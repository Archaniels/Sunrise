import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE2_IPC_EVENT_CHANNELS,
  type PdfDeepLinkTarget,
  type ProviderPaperCandidate,
} from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { registerIngestionRoutes } from '../../apps/api/src/controllers/ingestion-controller.js';
import { registerPdfAnnotationRoutes } from '../../apps/api/src/controllers/pdf-annotation-controller.js';
import { registerReferenceRoutes } from '../../apps/api/src/controllers/reference-controller.js';
import { createPostgresPdfAnnotationRepository } from '../../apps/api/src/db/pdf-annotation-repository.js';
import { createPostgresReferenceRepository } from '../../apps/api/src/db/reference-repository.js';
import type { TransactionClient, TransactionPool } from '../../apps/api/src/db/transaction.js';
import { createApiServer } from '../../apps/api/src/server.js';
import { createInMemoryAuthService } from '../../apps/api/src/services/auth-service.js';
import { createInMemoryFileExplorerService } from '../../apps/api/src/services/file-explorer-service.js';
import {
  createDefaultDoiHydrator,
  createIngestionService,
  unfoldRisDoiLines,
} from '../../apps/api/src/services/ingestion-service.js';
import {
  createCrossrefAdapter,
  createLiteratureSearchService,
  createOpenAlexAdapter,
  createPubMedAdapter,
  parsePubMedXmlCandidates,
} from '../../apps/api/src/services/literature-service.js';
import {
  createInMemoryPdfAnnotationRepository,
  createInMemoryPdfAnnotationService,
  createPdfAnnotationService,
} from '../../apps/api/src/services/pdf-annotation-service.js';
import { createInMemoryProjectService } from '../../apps/api/src/services/project-service.js';
import {
  createInMemoryReferenceRepository,
  createInMemoryReferenceService,
  createReferenceService,
} from '../../apps/api/src/services/reference-service.js';
import {
  createDeepLinkBroadcaster,
  createPhase2DesktopService,
} from '../../apps/desktop/src/main/services/phase2-desktop-service.js';
import { createPhase2PreloadApi } from '../../apps/desktop/src/preload/expose-api.js';
import {
  bindDeepLinkSubscription,
  createPdfViewerController,
} from '../../apps/desktop/src/renderer/pdf-viewer/pdf-viewer-state.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const REF_A = '33333333-3333-4333-8333-333333333333';
const USER_A = '44444444-4444-4444-8444-444444444444';
const EDITOR_ACTOR = { userId: USER_A, role: 'editor' as const };

function makeCandidate(overrides: Partial<ProviderPaperCandidate>): ProviderPaperCandidate {
  return {
    provider: 'openalex',
    externalId: 'W-1',
    title: 'Sample Paper Title',
    authors: [{ family: 'Lin', given: 'Mei', displayName: 'Mei Lin', orcid: null }],
    year: 2025,
    journal: 'Journal of Science',
    published: '2025-01-01',
    doi: '10.1234/sample-2025',
    url: 'https://doi.org/10.1234/sample-2025',
    abstract: 'Sample abstract.',
    volume: '10',
    issue: '2',
    pages: '1-12',
    citationCount: 15,
    pdfUrl: null,
    isOpenAccess: true,
    topics: ['AI'],
    ...overrides,
  };
}

function readRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function createBareFastifyServer() {
  return createApiServer(
    { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
    '0.1.0',
  );
}

describe('PR #1 CodeRabbit fixes — Literature Search (#1-#7)', () => {
  it('keeps cache keys case-sensitive and deduplicates requested providers (#1, #2)', async () => {
    const pubmedQueries: string[] = [];
    const service = createLiteratureSearchService({
      adapters: {
        openalex: async () => [],
        crossref: async () => [],
        pubmed: async (query) => {
          pubmedQueries.push(query.query);
          return [
            makeCandidate({
              provider: 'pubmed',
              externalId: query.query,
              title: `Result for ${query.query}`,
              doi: null,
            }),
          ];
        },
      },
    });

    const upper = await service.search({
      query: 'asthma OR eczema',
      providers: ['pubmed', 'pubmed'],
    });
    const lower = await service.search({
      query: 'asthma or eczema',
      providers: ['pubmed', 'pubmed'],
    });

    expect(upper.ok && lower.ok).toBe(true);
    expect(pubmedQueries).toEqual(['asthma OR eczema', 'asthma or eczema']);
    if (upper.ok) {
      expect(upper.value.providerSummaries).toHaveLength(1);
    }
  });

  it('fetches multiple upstream pages for deep offsets and reports pagination metadata (#3)', async () => {
    const pagesRequested: string[] = [];
    const pagingFetch: typeof fetch = async (input) => {
      const url = new URL(readRequestUrl(input));
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per-page') ?? '10');
      pagesRequested.push(`${page}:${perPage}`);
      const start = (page - 1) * perPage;
      const results = Array.from({ length: perPage }, (_, idx) => ({
        id: `https://openalex.org/W${start + idx + 1}`,
        display_name: `Paper ${start + idx + 1}`,
        publication_year: 2025,
      }));
      return new Response(JSON.stringify({ meta: { count: 250 }, results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const service = createLiteratureSearchService({
      adapters: {
        openalex: createOpenAlexAdapter('polite-pool@sunrise.research', pagingFetch),
        crossref: async () => ({ candidates: [], totalAvailable: 0 }),
        pubmed: async () => ({ candidates: [], totalAvailable: 0 }),
      },
    });

    const pageRes = await service.search({
      query: 'deep paging',
      providers: ['openalex'],
      offset: 120,
      limit: 10,
    });
    expect(pageRes.ok).toBe(true);
    if (pageRes.ok) {
      expect(pagesRequested.length).toBeGreaterThanOrEqual(2);
      expect(pageRes.value.results).toHaveLength(10);
      expect(pageRes.value.results[0]?.title).toBe('Paper 121');
      expect(pageRes.value.totalResults).toBe(250);
      expect(pageRes.value.totalResultsIsEstimate).toBe(true);
      expect(pageRes.value.hasMore).toBe(true);
    }
  });

  it('bounds oversized Crossref fields and preserves PubMed inline XML text order (#4, #5)', async () => {
    const longTitle = 'A'.repeat(1400);
    const crossrefFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          message: {
            'total-results': 1,
            items: [
              {
                DOI: '10.1234/long-title',
                title: [longTitle],
                'container-title': ['J'.repeat(700)],
                abstract: `<p>${'B'.repeat(21000)}</p>`,
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const adapter = createCrossrefAdapter('polite-pool@sunrise.research', crossrefFetch);
    const parsed = await adapter(
      { query: 'long', providers: ['crossref'], filters: {}, offset: 0, limit: 10 },
      {
        headers: { Accept: 'application/json' },
        timeoutMs: 5000,
        page: 1,
        pageSize: 10,
        signal: new AbortController().signal,
      },
    );
    const items = 'candidates' in parsed ? parsed.candidates : parsed;
    expect(items).toHaveLength(1);
    expect(items[0]?.title.length).toBe(1000);
    expect(items[0]?.journal?.length).toBe(500);
    expect(items[0]?.abstract?.length).toBe(20000);

    const mixedPubMedXml = `
      <PubmedArticleSet>
        <PubmedArticle>
          <MedlineCitation>
            <PMID>42000001</PMID>
            <Article>
              <ArticleTitle>H<sub>2</sub>O and <i>in vitro</i> transport.</ArticleTitle>
              <Abstract>
                <AbstractText>Measured CO<sub>2</sub> with <b>high</b> precision.</AbstractText>
              </Abstract>
            </Article>
          </MedlineCitation>
        </PubmedArticle>
      </PubmedArticleSet>
    `;
    const pubmedItems = parsePubMedXmlCandidates(mixedPubMedXml);
    expect(pubmedItems).toHaveLength(1);
    expect(pubmedItems[0]?.title).toBe('H2O and in vitro transport');
    expect(pubmedItems[0]?.abstract).toBe('Measured CO2 with high precision.');
  });

  it('aborts PubMed EFetch on attempt timeout and honors Retry-After budget on 429 (#6, #7)', async () => {
    let efetchAborted = false;
    const slowPubMedFetch: typeof fetch = async (input, init) => {
      const url = readRequestUrl(input);
      if (url.includes('esearch.fcgi')) {
        return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['12345'] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          efetchAborted = true;
          reject(new Error('aborted'));
        });
      });
    };

    const timedOutService = createLiteratureSearchService({
      policy: {
        timeoutMs: 500,
        maxRetries: 0,
        cacheTtlMs: 1000,
        contactEmail: 'polite-pool@sunrise.research',
      },
      adapters: {
        openalex: async () => [],
        crossref: async () => [],
        pubmed: createPubMedAdapter(
          { contactEmail: 'polite-pool@sunrise.research' },
          slowPubMedFetch,
        ),
      },
    });
    const timeoutRes = await timedOutService.search({
      query: 'abort test',
      providers: ['pubmed'],
    });
    expect(timeoutRes.ok).toBe(true);
    expect(efetchAborted).toBe(true);

    let rateLimitAttempts = 0;
    const rateLimitedFetch: typeof fetch = async () => {
      rateLimitAttempts += 1;
      return new Response(null, { status: 429, headers: { 'Retry-After': '120' } });
    };
    const rateLimitService = createLiteratureSearchService({
      policy: {
        timeoutMs: 500,
        maxRetries: 2,
        cacheTtlMs: 1000,
        contactEmail: 'polite-pool@sunrise.research',
      },
      adapters: {
        openalex: createOpenAlexAdapter('polite-pool@sunrise.research', rateLimitedFetch),
        crossref: async () => [],
        pubmed: async () => [],
      },
    });
    const rlRes = await rateLimitService.search({
      query: 'rate limit',
      providers: ['openalex'],
    });
    expect(rlRes.ok).toBe(true);
    expect(rateLimitAttempts).toBe(1);
    if (rlRes.ok) {
      expect(rlRes.value.warnings[0]?.code).toBe('RATE_LIMITED');
    }
  });
});

describe('PR #1 CodeRabbit fixes — Ingestion & Controllers (#8-#15)', () => {
  it('distinguishes DOI provider outages (503) from authoritative misses (404) (#8)', async () => {
    const outageFetch: typeof fetch = async (input) => {
      const url = readRequestUrl(input);
      return url.includes('crossref')
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 404 });
    };
    const outageService = createIngestionService({
      hydrateByDoi: createDefaultDoiHydrator('polite-pool@sunrise.research', outageFetch),
      extractPdfContent: async () => ({ text: '', xmpTitle: null, xmpAuthors: [], xmpDoi: null }),
    });
    const outageRes = await outageService.ingestDoi(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      doi: '10.1234/outage',
    });
    expect(outageRes.ok).toBe(false);
    if (!outageRes.ok) {
      expect(outageRes.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }

    const notFoundFetch: typeof fetch = async () => new Response(null, { status: 404 });
    const missService = createIngestionService({
      hydrateByDoi: createDefaultDoiHydrator('polite-pool@sunrise.research', notFoundFetch),
      extractPdfContent: async () => ({ text: '', xmpTitle: null, xmpAuthors: [], xmpDoi: null }),
    });
    const missRes = await missService.ingestDoi(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      doi: '10.1234/missing',
    });
    expect(missRes.ok).toBe(false);
    if (!missRes.ok) {
      expect(missRes.error.code).toBe('NOT_FOUND');
    }
  });

  it('unfolds long RIS DOIs, verifies inline PDF bytes, and rolls back failed bibliography batches (#9, #10, #11, #13)', async () => {
    const foldedRis =
      'TY  - JOUR\nTI  - Long DOI Paper\nDO  - 10.1007/s11192-023-04567-8-reproducible-reference-interchange-format-l\nong-suffix-2023\nER  - ';
    expect(unfoldRisDoiLines(foldedRis)).toContain(
      'DO  - 10.1007/s11192-023-04567-8-reproducible-reference-interchange-format-long-suffix-2023',
    );

    const storedBytes = Uint8Array.from(Buffer.from('%PDF-1.7 stored-content', 'utf8'));
    const mismatchBytes = Buffer.from('%PDF-1.7 spoofed-content', 'utf8').toString('base64');
    const pdfService = createIngestionService({
      hydrateByDoi: async () => null,
      fetchPdfBytes: async () => storedBytes,
      extractPdfContent: async () => ({
        text: 'Stored PDF',
        xmpTitle: 'Stored PDF',
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });
    const mismatchRes = await pdfService.ingestPdf(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      localPdfFileId: FILE_A,
      fileName: 'stored.pdf',
      pdfBase64: mismatchBytes,
    });
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.error.code).toBe('VALIDATION_ERROR');
    }

    const wrongFormatRes = await pdfService.importBibliography(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      format: 'bibtex',
      content: 'TY  - JOUR\nTI  - RIS Submitted As Bibtex\nER  - ',
    });
    expect(wrongFormatRes.ok).toBe(false);
    if (!wrongFormatRes.ok) {
      expect(wrongFormatRes.error.code).toBe('VALIDATION_ERROR');
    }

    const baseRepo = createInMemoryReferenceRepository();
    let saveCalls = 0;
    const wrapTxRepo = (txRepo: typeof baseRepo): typeof baseRepo => {
      const wrapped: typeof baseRepo = {
        ...txRepo,
        save: async (ref) => {
          saveCalls += 1;
          if (saveCalls === 2) {
            throw new Error('disk full');
          }
          return txRepo.save(ref);
        },
        runInTransaction: async <T>(inner: (repo: typeof baseRepo) => Promise<T>): Promise<T> =>
          inner(wrapped),
      };
      return wrapped;
    };
    const flakyRepo = {
      ...baseRepo,
      runInTransaction: async <T>(fn: (txRepo: typeof baseRepo) => Promise<T>): Promise<T> => {
        if (!baseRepo.runInTransaction) {
          return fn(wrapTxRepo(baseRepo));
        }
        return baseRepo.runInTransaction(async (txRepo) => fn(wrapTxRepo(txRepo)));
      },
    };
    const flakyRefService = createReferenceService(flakyRepo);
    const batchService = createIngestionService({
      referenceService: flakyRefService,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({ text: '', xmpTitle: null, xmpAuthors: [], xmpDoi: null }),
    });
    const twoBibEntries = [
      '@article{a2024, title = {First Paper}, year = {2024}}',
      '@article{b2024, title = {Second Paper}, year = {2024}}',
    ].join('\n');
    const batchRes = await batchService.importBibliography(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      format: 'bibtex',
      content: twoBibEntries,
    });
    expect(batchRes.ok).toBe(false);
    if (!batchRes.ok) {
      expect(batchRes.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }
    const remaining = await flakyRefService.listReferences(EDITOR_ACTOR, { projectId: PROJECT_A });
    expect(remaining.ok && remaining.value.length === 0).toBe(true);
  });

  it('rejects unverified cited body-text DOIs and emits unverifiedCandidateDois (#12)', async () => {
    const citedDoi = '10.1000/cited-related-work';
    const referenceService = createInMemoryReferenceService({
      assertFileInProject: async (pid, fid) => pid === PROJECT_A && fid === FILE_A,
    });
    const service = createIngestionService({
      referenceService,
      hydrateByDoi: async (doi) => ({
        provider: 'crossref',
        candidate: makeCandidate({
          provider: 'crossref',
          title: 'Completely Unrelated Prior Survey',
          authors: [{ family: 'Other', given: 'Author', displayName: 'Author Other', orcid: null }],
          doi,
        }),
      }),
      extractPdfContent: async () => ({
        text: `Novel Quantum Compiler Design\nRelated work cites ${citedDoi} for comparison.`,
        xmpTitle: 'Novel Quantum Compiler Design',
        xmpAuthors: ['Jane Smith'],
        xmpDoi: null,
      }),
    });

    const outcome = await service.ingestPdf(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      localPdfFileId: FILE_A,
      fileName: 'quantum.pdf',
      pdfBase64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.extractionMethod).toBe('xmp_and_text_heuristic');
      expect(outcome.value.detectedDoi).toBeNull();
      expect(outcome.value.hydratedFrom).toBe('none');
      expect(outcome.value.needsLlmFallback).toBe(true);
      expect(outcome.value.unverifiedCandidateDois).toEqual([citedDoi]);
    }
  });

  it('fails closed without ownership guards and supports route-specific 2 MiB PDF bodyLimit (#14, #15)', async () => {
    const authService = createInMemoryAuthService();
    const signup = await authService.signup({
      email: 'guard-test@sunrise.edu',
      password: 'GuardPassword!2026',
      displayName: 'Guard Tester',
    });
    expect(signup.ok).toBe(true);
    if (!signup.ok) {
      return;
    }
    const projectService = createInMemoryProjectService([signup.value.user]);
    const createdProj = await projectService.createProject(signup.value.user.id, {
      name: 'Guard Proj',
    });
    expect(createdProj.ok).toBe(true);
    if (!createdProj.ok) {
      return;
    }
    const headers = { authorization: `Bearer ${signup.value.tokens.accessToken}` };

    const appNoGuards = createBareFastifyServer();
    const guardReferenceService = createInMemoryReferenceService({
      assertFileInProject: async (pid, fid) => pid === createdProj.value.id && fid === FILE_A,
    });
    const ingestionService = createIngestionService({
      referenceService: guardReferenceService,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: 'Large PDF',
        xmpTitle: 'Large PDF',
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });
    registerIngestionRoutes(appNoGuards, authService, projectService, ingestionService);
    const noGuardRes = await appNoGuards.inject({
      method: 'POST',
      url: `/projects/${createdProj.value.id}/ingestion/pdf`,
      headers,
      payload: {
        localPdfFileId: FILE_A,
        fileName: 'paper.pdf',
        pdfBase64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
      },
    });
    expect(noGuardRes.statusCode).toBe(404);
    await appNoGuards.close();

    const appLargeLimit = createBareFastifyServer();
    const overOneMiBBytes = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'utf8'),
      Buffer.alloc(900_000, 65),
    ]);
    const overOneMiBBase64 = overOneMiBBytes.toString('base64');
    const readFileBytesSpy = vi.fn(async (pid: string, fid: string) =>
      pid === createdProj.value.id && fid === FILE_A ? new Uint8Array(overOneMiBBytes) : null,
    );
    registerIngestionRoutes(appLargeLimit, authService, projectService, ingestionService, {
      assertFileInProject: async () => true,
      readFileBytes: readFileBytesSpy,
    });
    const largeRes = await appLargeLimit.inject({
      method: 'POST',
      url: `/projects/${createdProj.value.id}/ingestion/pdf`,
      headers,
      payload: {
        localPdfFileId: FILE_A,
        fileName: 'large.pdf',
        pdfBase64: overOneMiBBase64,
      },
    });
    expect(largeRes.statusCode).toBe(201);
    expect(readFileBytesSpy).toHaveBeenCalledTimes(1);
    await appLargeLimit.close();
  });
});

describe('PR #1 CodeRabbit fixes — Ownership, References & Annotations (#16-#21)', () => {
  it('enforces PDF-only checks, fail-closed guards, delete lock, and full conflict diffs (#16-#19)', async () => {
    const fileExplorer = createInMemoryFileExplorerService();
    const folder = await fileExplorer.createFolder(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      name: 'docs',
    });
    const textFile = await fileExplorer.uploadFile(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      fileName: 'notes.txt',
      sizeBytes: 5,
      contentBase64: Buffer.from('hello', 'utf8').toString('base64'),
    });
    const pdfFile = await fileExplorer.uploadFile(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      fileName: 'paper.pdf',
      sizeBytes: 8,
      contentBase64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
    });
    expect(folder.ok && textFile.ok && pdfFile.ok).toBe(true);
    if (!folder.ok || !textFile.ok || !pdfFile.ok) {
      return;
    }
    expect(await fileExplorer.hasPdfFileInProject(PROJECT_A, folder.value.id)).toBe(false);
    expect(await fileExplorer.hasPdfFileInProject(PROJECT_A, textFile.value.id)).toBe(false);
    expect(await fileExplorer.hasPdfFileInProject(PROJECT_A, pdfFile.value.id)).toBe(true);

    const noGuardRefService = createReferenceService(createInMemoryReferenceRepository());
    const unverifiedPdfCreate = await noGuardRefService.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Missing Verifier',
      localPdfFileId: pdfFile.value.id,
    });
    expect(unverifiedPdfCreate.ok).toBe(false);
    if (!unverifiedPdfCreate.ok) {
      expect(unverifiedPdfCreate.error.code).toBe('NOT_FOUND');
    }

    const sqlLog: string[] = [];
    const fakeClient: TransactionClient = {
      query: async (sql: string) => {
        sqlLog.push(sql.trim());
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const fakePool: TransactionPool = { connect: async () => fakeClient };
    const pgRefService = createReferenceService(createPostgresReferenceRepository(fakePool));
    const deleted = await pgRefService.deleteReference(EDITOR_ACTOR, PROJECT_A, REF_A);
    expect(deleted.ok).toBe(true);
    expect(sqlLog[0]).toBe('BEGIN');
    expect(sqlLog[1]).toBe('SELECT id FROM projects WHERE id = $1 FOR UPDATE');
    expect(sqlLog[sqlLog.length - 1]).toBe('COMMIT');

    const memRefService = createInMemoryReferenceService();
    await memRefService.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Original Study',
      authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
      year: 2024,
      doi: '10.1234/conflict-check',
      volume: '1',
      pages: '1-5',
      tags: ['ml'],
    });
    const conflictRes = await memRefService.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Original Study',
      authors: [{ family: 'Chen', given: 'Wei', displayName: 'Wei Chen', orcid: null }],
      year: 2024,
      doi: '10.1234/conflict-check',
      volume: '2',
      pages: '10-20',
      tags: ['nlp'],
      onDuplicate: 'prompt',
    });
    expect(conflictRes.ok && conflictRes.value.status === 'conflict').toBe(true);
    if (conflictRes.ok && conflictRes.value.status === 'conflict') {
      expect(conflictRes.value.conflict.conflictingFields).toEqual(
        expect.arrayContaining(['authors', 'volume', 'pages', 'tags']),
      );
    }
  });

  it('prevents deleted annotation resurrection, persists to Postgres, and fails closed without guards (#20, #21)', async () => {
    const noGuardAnnService = createPdfAnnotationService(createInMemoryPdfAnnotationRepository());
    const unverifiedAnn = await noGuardAnnService.createAnnotation(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      fileId: FILE_A,
      pageNumber: 1,
      selectedText: 'Blocked without ownership verifier',
      rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.03 }],
    });
    expect(unverifiedAnn.ok).toBe(false);
    if (!unverifiedAnn.ok) {
      expect(unverifiedAnn.error.code).toBe('NOT_FOUND');
    }

    const memAnnService = createInMemoryPdfAnnotationService();
    const created = await memAnnService.createAnnotation(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      fileId: FILE_A,
      pageNumber: 2,
      selectedText: 'Highlight text',
      rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const deleted = await memAnnService.deleteAnnotation(EDITOR_ACTOR, PROJECT_A, created.value.id);
    expect(deleted.ok).toBe(true);
    const updateDeleted = await memAnnService.updateAnnotation(
      EDITOR_ACTOR,
      PROJECT_A,
      created.value.id,
      { note: 'Should not resurrect' },
    );
    expect(updateDeleted.ok).toBe(false);
    if (!updateDeleted.ok) {
      expect(updateDeleted.error.code).toBe('NOT_FOUND');
    }

    const sqlLog: string[] = [];
    const pgClient: TransactionClient = {
      query: async (sql: string) => {
        sqlLog.push(sql.trim());
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const pgAnnRepo = createPostgresPdfAnnotationRepository({ connect: async () => pgClient });
    const missingUpdate = await pgAnnRepo.update(PROJECT_A, REF_A, {
      note: 'Updated',
      updatedAt: new Date().toISOString(),
    });
    expect(missingUpdate).toBeNull();
    expect(sqlLog[0]).toContain('UPDATE pdf_annotations');
    expect(sqlLog[0]).toContain('RETURNING');

    const authService = createInMemoryAuthService();
    const userRes = await authService.signup({
      email: 'ctrl-guards@sunrise.edu',
      password: 'CtrlPassword!2026',
      displayName: 'Ctrl User',
    });
    expect(userRes.ok).toBe(true);
    if (!userRes.ok) {
      return;
    }
    const projectService = createInMemoryProjectService([userRes.value.user]);
    const projRes = await projectService.createProject(userRes.value.user.id, { name: 'P' });
    expect(projRes.ok).toBe(true);
    if (!projRes.ok) {
      return;
    }
    const headers = { authorization: `Bearer ${userRes.value.tokens.accessToken}` };

    const appNoGuards = createBareFastifyServer();
    registerReferenceRoutes(
      appNoGuards,
      authService,
      projectService,
      createInMemoryReferenceService(),
    );
    registerPdfAnnotationRoutes(appNoGuards, authService, projectService, memAnnService);
    const refNoGuard = await appNoGuards.inject({
      method: 'POST',
      url: `/projects/${projRes.value.id}/references`,
      headers,
      payload: { title: 'Blocked Ref', localPdfFileId: FILE_A },
    });
    const annNoGuard = await appNoGuards.inject({
      method: 'POST',
      url: `/projects/${projRes.value.id}/files/${FILE_A}/annotations`,
      headers,
      payload: {
        pageNumber: 1,
        selectedText: 'Blocked',
        rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
      },
    });
    expect(refNoGuard.statusCode).toBe(404);
    expect(annNoGuard.statusCode).toBe(404);
    await appNoGuards.close();

    const fileExplorer = createInMemoryFileExplorerService();
    const apiServer = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
      { authService, projectService, fileExplorerService: fileExplorer },
      { referenceService: createInMemoryReferenceService(), pdfAnnotationService: memAnnService },
    );
    const txtUpload = await apiServer.inject({
      method: 'POST',
      url: `/projects/${projRes.value.id}/files`,
      headers,
      payload: {
        parentId: null,
        fileName: 'not-a-pdf.txt',
        sizeBytes: 3,
        contentBase64: Buffer.from('abc', 'utf8').toString('base64'),
      },
    });
    const txtId: string = txtUpload.json().value.id;
    const attachNonPdf = await apiServer.inject({
      method: 'POST',
      url: `/projects/${projRes.value.id}/references`,
      headers,
      payload: { title: 'Non-PDF Link', localPdfFileId: txtId },
    });
    expect(attachNonPdf.statusCode).toBe(404);
    await apiServer.close();
  });
});

describe('PR #1 CodeRabbit fixes — Desktop Viewer, Table & Deep-Link Delivery (#22-#26)', () => {
  it('caps 500-char deep-link excerpts to 300 chars and wires main->preload->renderer deep-link delivery (#24, #26)', async () => {
    const controller = createPdfViewerController({
      projectId: PROJECT_A,
      fileId: FILE_A,
      referenceId: REF_A,
      totalPages: 25,
      role: 'editor',
    });

    const longExcerpt = 'x'.repeat(500);
    const target: PdfDeepLinkTarget = {
      projectId: PROJECT_A,
      fileId: FILE_A,
      referenceId: REF_A,
      pageNumber: 14,
      highlightId: null,
      searchExcerpt: longExcerpt,
    };

    const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
    const broadcaster = createDeepLinkBroadcaster(() => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          for (const listener of eventListeners.get(channel) ?? []) {
            listener(payload);
          }
        },
      },
    }));

    const desktopService = createPhase2DesktopService({
      writeClipboardText: vi.fn(),
      onDeepLinkOpened: broadcaster,
    });

    const api = createPhase2PreloadApi(
      async (_channel, payload) => desktopService.openDeepLink(payload as PdfDeepLinkTarget),
      (channel, listener) => {
        const set = eventListeners.get(channel) ?? new Set<(payload: unknown) => void>();
        set.add(listener);
        eventListeners.set(channel, set);
        return () => {
          set.delete(listener);
        };
      },
    );

    const receivedTargets: PdfDeepLinkTarget[] = [];
    const unsubscribe = bindDeepLinkSubscription(controller, api.pdf.onDeepLinkOpened, (_s, t) => {
      receivedTargets.push(t);
    });

    for (const listener of eventListeners.get(PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED) ??
      []) {
      listener({ invalid: true });
    }
    expect(receivedTargets).toHaveLength(0);

    const opened = await api.pdf.openDeepLink(target);
    expect(opened.ok).toBe(true);
    expect(receivedTargets).toHaveLength(1);
    expect(controller.getState().currentPage).toBe(14);
    expect(controller.getState().searchQuery).toHaveLength(300);

    unsubscribe();
    await api.pdf.openDeepLink({ ...target, pageNumber: 3 });
    expect(controller.getState().currentPage).toBe(14);
  });

  it('preserves PDF bytes with private copy, renders selectable TextLayer, and provides keyboard controls in ReferenceManagerView (#22, #23, #25)', () => {
    const pdfPaneSource = readFileSync(
      join(REPO_ROOT, 'apps/desktop/src/renderer/pdf-viewer/PdfViewerPane.tsx'),
      'utf8',
    );
    expect(pdfPaneSource).toContain('new Uint8Array(pdfData)');
    expect(pdfPaneSource).toContain('new TextLayer(');
    expect(pdfPaneSource).toContain('activeTextLayer?.cancel()');
    expect(pdfPaneSource).toContain('onMouseUp={handleTextSelectionEnd}');

    const refViewSource = readFileSync(
      join(REPO_ROOT, 'apps/desktop/src/renderer/references/ReferenceManagerView.tsx'),
      'utf8',
    );
    expect(refViewSource).toContain('header.column.getCanSort()');
    expect(refViewSource).toContain('aria-sort={ariaSort}');
    expect(refViewSource).toContain(
      'aria-pressed={row.original.id === viewState.selectedReferenceId}',
    );
  });
});
