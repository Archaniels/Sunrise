import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_PRELOAD_KEYS,
  PHASE2_IPC_CHANNELS,
  PHASE2_PRELOAD_EXPOSED_KEYS,
  validateCspHeader,
} from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresAuthRepository } from '../../apps/api/src/db/auth-repository.js';
import { createPostgresReferenceRepository } from '../../apps/api/src/db/reference-repository.js';
import {
  withTransaction,
  type TransactionClient,
  type TransactionPool,
} from '../../apps/api/src/db/transaction.js';
import { createApiServer } from '../../apps/api/src/server.js';
import {
  createAuthService,
  createInMemoryAuthService,
} from '../../apps/api/src/services/auth-service.js';
import { createInMemoryFileExplorerService } from '../../apps/api/src/services/file-explorer-service.js';
import {
  createDefaultDoiHydrator,
  createIngestionService,
  extractPdfContentWithPdfJs,
  parseXmpPacketMetadata,
} from '../../apps/api/src/services/ingestion-service.js';
import {
  createLiteratureSearchService,
  createOpenAlexAdapter,
  parsePubMedXmlCandidates,
} from '../../apps/api/src/services/literature-service.js';
import { createInMemoryPdfAnnotationService } from '../../apps/api/src/services/pdf-annotation-service.js';
import { createInMemoryProjectService } from '../../apps/api/src/services/project-service.js';
import {
  createInMemoryReferenceService,
  createReferenceService,
} from '../../apps/api/src/services/reference-service.js';
import {
  registerPhase2IpcHandlers,
  type Phase2IpcRegistrar,
} from '../../apps/desktop/src/main/controllers/phase2-ipc-router.js';
import { createPhase2DesktopService } from '../../apps/desktop/src/main/services/phase2-desktop-service.js';
import {
  createMainWindowCsp,
  getAllowedNavigationOrigins,
  isAllowedNavigationOrigin,
  MAIN_WINDOW_CSP,
} from '../../apps/desktop/src/main/window-config.js';
import { exposePhase2SunriseApi } from '../../apps/desktop/src/preload/expose-api.js';
import { resolveLocalPdfWorkerUrl } from '../../apps/desktop/src/renderer/pdf-viewer/pdf-worker-setup.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SAMPLE_PUBMED_XML = `
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>39001234</PMID>
      <Article>
        <Journal>
          <JournalIssue>
            <Volume>41</Volume>
            <Issue>2</Issue>
            <PubDate><Year>2025</Year></PubDate>
          </JournalIssue>
          <Title>Journal of Biomedical Discovery</Title>
        </Journal>
        <ArticleTitle>Federated XML Parsing in Clinical Literature.</ArticleTitle>
        <Pagination><MedlinePgn>12-25</MedlinePgn></Pagination>
        <Abstract>
          <AbstractText>Structured abstract summary.</AbstractText>
        </Abstract>
        <AuthorList>
          <Author>
            <LastName>Patel</LastName>
            <ForeName>Asha</ForeName>
          </Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="doi">10.1093/jbd/2025.001</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>
`;

const SAMPLE_XMP_XML = `
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
      <dc:title><rdf:Alt><rdf:li>XMP Extracted Paper Title</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>Mei Lin</rdf:li></rdf:Seq></dc:creator>
      <prism:doi>10.1145/3544548.3589999</prism:doi>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
`;

interface MockPgStore {
  readonly users: Map<string, Record<string, unknown>>;
  readonly tokensByHash: Map<string, Record<string, unknown>>;
  readonly tokensById: Map<string, Record<string, unknown>>;
}

function handleUserMockQuery(
  trimmed: string,
  params: unknown[],
  store: MockPgStore,
): { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly rowCount: number } | null {
  if (trimmed.startsWith('INSERT INTO users')) {
    const row = {
      id: params[0],
      email: params[1],
      password_hash: params[2],
      display_name: params[3],
      created_at: params[4],
    };
    store.users.set(String(params[0]), row);
    return { rows: [row], rowCount: 1 };
  }
  if (trimmed.includes('FROM users WHERE LOWER(email)')) {
    const target = String(params[0]).toLowerCase();
    const match = Array.from(store.users.values()).find(
      (item) => String(item['email']).toLowerCase() === target,
    );
    return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
  }
  if (trimmed.includes('FROM users WHERE id')) {
    const match = store.users.get(String(params[0]));
    return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
  }
  return null;
}

function handleTokenMockQuery(
  trimmed: string,
  params: unknown[],
  store: MockPgStore,
): { readonly rows: ReadonlyArray<Record<string, unknown>>; readonly rowCount: number } {
  if (trimmed.startsWith('INSERT INTO refresh_tokens')) {
    const row = {
      id: params[0],
      user_id: params[1],
      token_hash: params[2],
      expires_at: params[3],
      revoked_at: params[4],
      replaced_by: params[5],
      created_at: params[6],
    };
    store.tokensByHash.set(String(params[2]), row);
    store.tokensById.set(String(params[0]), row);
    return { rows: [row], rowCount: 1 };
  }
  if (trimmed.includes('FROM refresh_tokens WHERE token_hash')) {
    const match = store.tokensByHash.get(String(params[0]));
    return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
  }
  if (trimmed.startsWith('UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3')) {
    const existing = store.tokensById.get(String(params[0]));
    if (existing) {
      existing['revoked_at'] = params[1];
      existing['replaced_by'] = params[2];
    }
    return { rows: [], rowCount: existing ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

function createMockAuthPgClient(sqlLog: string[]): TransactionClient {
  const store: MockPgStore = {
    users: new Map(),
    tokensByHash: new Map(),
    tokensById: new Map(),
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const trimmed = sql.trim();
      sqlLog.push(trimmed);
      return (
        handleUserMockQuery(trimmed, params, store) ?? handleTokenMockQuery(trimmed, params, store)
      );
    },
    release: vi.fn(),
  };
}

function buildPhase2TestServer() {
  const authService = createInMemoryAuthService();
  const fileExplorerService = createInMemoryFileExplorerService();
  const referenceService = createInMemoryReferenceService({
    assertFileInProject: (projectId, fileId) =>
      fileExplorerService.hasPdfFileInProject(projectId, fileId),
  });
  const pdfAnnotationService = createInMemoryPdfAnnotationService();
  const literatureService = createLiteratureSearchService({
    adapters: {
      openalex: async () => parsePubMedXmlCandidates(SAMPLE_PUBMED_XML),
      crossref: async () => [],
      pubmed: async () => [],
    },
  });
  const ingestionService = createIngestionService({
    referenceService,
    hydrateByDoi: async () => null,
    extractPdfContent: async () => ({
      text: 'Working draft',
      xmpTitle: 'Working Draft',
      xmpAuthors: ['Dr. Owner'],
      xmpDoi: null,
    }),
  });
  return {
    authService,
    fileExplorerService,
    referenceService,
    pdfAnnotationService,
    literatureService,
    ingestionService,
  };
}

function resolveAssetUrlToDiskPath(assetUrl: string): string {
  if (assetUrl.startsWith('file://')) {
    return fileURLToPath(assetUrl);
  }
  if (assetUrl.startsWith('/@fs/')) {
    return assetUrl.slice('/@fs/'.length);
  }
  if (assetUrl.startsWith('/')) {
    return join(REPO_ROOT, assetUrl.slice(1));
  }
  return resolve(REPO_ROOT, assetUrl);
}

describe('Phase 2 integration and bundled Phase 1 hardening carry-forwards', () => {
  it('enforces tightened production CSP, splits navigation origins, and resolves an existing local pdf.js worker file (F1)', () => {
    expect(validateCspHeader(MAIN_WINDOW_CSP).ok).toBe(true);
    expect(MAIN_WINDOW_CSP).toContain("worker-src 'self'");
    expect(MAIN_WINDOW_CSP).toContain("connect-src 'self'");
    expect(MAIN_WINDOW_CSP).not.toContain('connect-src *');
    expect(MAIN_WINDOW_CSP).not.toContain("connect-src 'self' https:");

    const prodCsp = createMainWindowCsp({
      isDev: false,
      apiBaseUrl: 'https://api.sunrise.research',
    });
    expect(prodCsp).toContain("worker-src 'self'");
    expect(prodCsp).toContain("connect-src 'self' https://api.sunrise.research");
    expect(prodCsp).not.toContain('localhost:5173');

    const prodOrigins = getAllowedNavigationOrigins(false);
    const devOrigins = getAllowedNavigationOrigins(true);
    expect(isAllowedNavigationOrigin('file:///app/index.html', prodOrigins)).toBe(true);
    expect(isAllowedNavigationOrigin('http://localhost:5173/', prodOrigins)).toBe(false);
    expect(isAllowedNavigationOrigin('http://127.0.0.1:5173/', prodOrigins)).toBe(false);
    expect(isAllowedNavigationOrigin('http://localhost:5173/', devOrigins)).toBe(true);

    const workerUrl = resolveLocalPdfWorkerUrl();
    expect(workerUrl.startsWith('https://')).toBe(false);
    expect(workerUrl.startsWith('http://')).toBe(false);
    expect(workerUrl).toContain('pdfjs-dist/build/pdf.worker.min.mjs');
    expect(workerUrl).not.toContain('src/renderer');
    expect(existsSync(resolveAssetUrlToDiskPath(workerUrl))).toBe(true);
  });

  it('commits/rolls back PoolClient transactions, uses FOR UPDATE on refresh rotation, and locks project on Postgres reference writes (F5)', async () => {
    const executedSql: string[] = [];
    const releaseSpy = vi.fn();
    const fakeClient: TransactionClient = {
      query: async (sql: string) => {
        executedSql.push(sql.trim());
        return { rows: [], rowCount: 0 };
      },
      release: releaseSpy,
    };
    const fakePool: TransactionPool = {
      connect: async () => fakeClient,
    };

    const committed = await withTransaction(fakePool, async (client) => {
      await client.query('SELECT 1');
      return 'done';
    });
    expect(committed).toBe('done');
    expect(executedSql).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(releaseSpy).toHaveBeenCalledWith(false);

    executedSql.length = 0;
    await expect(
      withTransaction(fakePool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(executedSql).toEqual(['BEGIN', 'ROLLBACK']);

    const sqlLog: string[] = [];
    const pgClient = createMockAuthPgClient(sqlLog);
    const pgPool: TransactionPool = { connect: async () => pgClient };
    const authService = createAuthService(createPostgresAuthRepository(pgPool), {
      accessSecret: new Uint8Array(32).fill(1),
      refreshSecret: new Uint8Array(32).fill(2),
    });

    const signedUp = await authService.signup({
      email: 'tx-user@sunrise.edu',
      password: 'SecurePassword!2026',
      displayName: 'Tx Researcher',
    });
    expect(signedUp.ok).toBe(true);
    if (!signedUp.ok) {
      return;
    }

    sqlLog.length = 0;
    const refreshed = await authService.refresh({
      refreshToken: signedUp.value.tokens.refreshToken,
    });
    expect(refreshed.ok).toBe(true);
    expect(sqlLog[0]).toBe('BEGIN');
    expect(sqlLog.some((q) => q.includes('FOR UPDATE'))).toBe(true);
    expect(sqlLog[sqlLog.length - 1]).toBe('COMMIT');

    executedSql.length = 0;
    const refService = createReferenceService(createPostgresReferenceRepository(fakePool));
    const createdRef = await refService.createReference(
      { userId: '11111111-1111-4111-8111-111111111111', role: 'owner' },
      { projectId: '22222222-2222-4222-8222-222222222222', title: 'Locked Write Reference' },
    );
    expect(createdRef.ok).toBe(true);
    expect(executedSql[0]).toBe('BEGIN');
    expect(executedSql[1]).toBe('SELECT id FROM projects WHERE id = $1 FOR UPDATE');
    expect(executedSql[executedSql.length - 1]).toBe('COMMIT');
  });

  it('prevents concurrent refresh token double-spend and verifies SQL composite FK and partial unique indexes (F2)', async () => {
    const authService = createInMemoryAuthService();
    const signup = await authService.signup({
      email: 'race@sunrise.edu',
      password: 'RacePassword!2026',
      displayName: 'Dr. Race',
    });
    expect(signup.ok).toBe(true);
    if (!signup.ok) {
      return;
    }

    const [first, second] = await Promise.all([
      authService.refresh({ refreshToken: signup.value.tokens.refreshToken }),
      authService.refresh({ refreshToken: signup.value.tokens.refreshToken }),
    ]);
    expect([first, second].filter((item) => item.ok).length).toBe(1);

    const migrationSql = readFileSync(
      join(REPO_ROOT, 'apps/api/src/db/migrations/0003_references_and_pdf_annotations.sql'),
      'utf8',
    );
    expect(migrationSql).toContain('uq_project_files_active_sibling');
    expect(migrationSql).toContain('WHERE deleted_at IS NULL');
    expect(migrationSql).toContain('uq_project_files_project_id_id');
    expect(migrationSql).toContain('uq_project_references_project_id_id');
    expect(migrationSql).toContain('FOREIGN KEY (project_id, local_pdf_file_id)');
    expect(migrationSql).toContain('FOREIGN KEY (project_id, file_id)');
    expect(migrationSql).toContain('FOREIGN KEY (project_id, reference_id)');
  });

  it('blocks cross-project localPdfFileId, fileId, and referenceId IDOR with HTTP 404 and rejects malformed query params with 400 (F2, F6)', async () => {
    const services = buildPhase2TestServer();
    const alice = await services.authService.signup({
      email: 'f2-alice@sunrise.edu',
      password: 'AlicePassword!2026',
      displayName: 'Dr. Alice',
    });
    const bob = await services.authService.signup({
      email: 'f2-bob@sunrise.edu',
      password: 'BobPassword!2026',
      displayName: 'Dr. Bob',
    });
    expect(alice.ok && bob.ok).toBe(true);
    if (!alice.ok || !bob.ok) {
      return;
    }

    const projectService = createInMemoryProjectService([alice.value.user, bob.value.user]);
    const app = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
      {
        authService: services.authService,
        projectService,
        fileExplorerService: services.fileExplorerService,
      },
      {
        literatureService: services.literatureService,
        referenceService: services.referenceService,
        ingestionService: services.ingestionService,
        pdfAnnotationService: services.pdfAnnotationService,
      },
    );

    const aliceHeader = { authorization: `Bearer ${alice.value.tokens.accessToken}` };
    const bobHeader = { authorization: `Bearer ${bob.value.tokens.accessToken}` };

    const projectAId: string = (
      await app.inject({
        method: 'POST',
        url: '/projects',
        headers: aliceHeader,
        payload: { name: 'Project A' },
      })
    ).json().value.id;
    const projectBId: string = (
      await app.inject({
        method: 'POST',
        url: '/projects',
        headers: bobHeader,
        payload: { name: 'Project B' },
      })
    ).json().value.id;

    const fileAId: string = (
      await app.inject({
        method: 'POST',
        url: `/projects/${projectAId}/files`,
        headers: aliceHeader,
        payload: {
          parentId: null,
          fileName: 'a.pdf',
          sizeBytes: 8,
          contentBase64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
        },
      })
    ).json().value.id;
    const fileBId: string = (
      await app.inject({
        method: 'POST',
        url: `/projects/${projectBId}/files`,
        headers: bobHeader,
        payload: {
          parentId: null,
          fileName: 'b.pdf',
          sizeBytes: 8,
          contentBase64: Buffer.from('%PDF-1.7', 'utf8').toString('base64'),
        },
      })
    ).json().value.id;

    const refARes = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/references`,
      headers: aliceHeader,
      payload: { title: 'Alice Paper', year: 2025, localPdfFileId: fileAId },
    });
    expect(refARes.statusCode).toBe(201);
    const refAId: string = refARes.json().value.reference.id;

    const refBId: string = (
      await app.inject({
        method: 'POST',
        url: `/projects/${projectBId}/references`,
        headers: bobHeader,
        payload: { title: 'Bob Paper', year: 2025, localPdfFileId: fileBId },
      })
    ).json().value.reference.id;

    const crossCreateRef = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/references`,
      headers: aliceHeader,
      payload: { title: 'Cross Link Attempt', localPdfFileId: fileBId },
    });
    expect(crossCreateRef.statusCode).toBe(404);

    const crossAttachPdf = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/references/${refAId}/attach-pdf`,
      headers: aliceHeader,
      payload: { localPdfFileId: fileBId },
    });
    expect(crossAttachPdf.statusCode).toBe(404);

    const crossPatchRef = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectAId}/references/${refAId}`,
      headers: aliceHeader,
      payload: { localPdfFileId: fileBId },
    });
    expect(crossPatchRef.statusCode).toBe(404);

    const validAnn = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/files/${fileAId}/annotations`,
      headers: aliceHeader,
      payload: {
        referenceId: refAId,
        pageNumber: 1,
        selectedText: 'Valid project annotation',
        rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      },
    });
    expect(validAnn.statusCode).toBe(201);

    const crossFileAnn = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/files/${fileBId}/annotations`,
      headers: aliceHeader,
      payload: {
        pageNumber: 1,
        selectedText: 'Cross file IDOR',
        rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      },
    });
    expect(crossFileAnn.statusCode).toBe(404);

    const crossRefAnn = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/files/${fileAId}/annotations`,
      headers: aliceHeader,
      payload: {
        referenceId: refBId,
        pageNumber: 1,
        selectedText: 'Cross reference IDOR',
        rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      },
    });
    expect(crossRefAnn.statusCode).toBe(404);

    const crossIngestPdf = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/ingestion/pdf`,
      headers: aliceHeader,
      payload: {
        localPdfFileId: fileBId,
        fileName: 'b.pdf',
        pdfBase64: Buffer.from('%PDF', 'utf8').toString('base64'),
      },
    });
    expect(crossIngestPdf.statusCode).toBe(404);

    const crossListAnn = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/files/${fileBId}/annotations`,
      headers: aliceHeader,
    });
    expect(crossListAnn.statusCode).toBe(404);

    const badYearQuery = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/references?yearFrom=abc`,
      headers: aliceHeader,
    });
    expect(badYearQuery.statusCode).toBe(400);

    const badBoolQuery = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/references?hasPdf=maybe`,
      headers: aliceHeader,
    });
    expect(badBoolQuery.statusCode).toBe(400);

    const badPageQuery = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/files/${fileAId}/annotations?pageNumber=abc`,
      headers: aliceHeader,
    });
    expect(badPageQuery.statusCode).toBe(400);

    await app.close();
  });

  it('falls back to OpenAlex on Crossref failure (F3), handles malformed PDFs cleanly (F4), and paginates offset queries without starvation (F6)', async () => {
    const pubmedResults = parsePubMedXmlCandidates(SAMPLE_PUBMED_XML);
    expect(pubmedResults).toHaveLength(1);
    expect(pubmedResults[0]?.doi).toBe('10.1093/jbd/2025.001');

    const xmp = parseXmpPacketMetadata(SAMPLE_XMP_XML);
    expect(xmp.xmpTitle).toBe('XMP Extracted Paper Title');
    expect(xmp.xmpDoi).toBe('10.1145/3544548.3589999');

    const requestedUrls: string[] = [];
    const fallbackFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      if (new URL(url).hostname === 'api.crossref.org') {
        return new Response(null, { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: 'https://openalex.org/W999',
          display_name: 'OpenAlex Fallback Paper',
          publication_year: 2025,
          doi: 'https://doi.org/10.1234/fallback-2025',
          authorships: [{ author: { display_name: 'Ada Lovelace', orcid: null } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const hydrator = createDefaultDoiHydrator('polite-pool@sunrise.research', fallbackFetch);
    const hydrated = await hydrator('10.1234/fallback-2025');
    expect(hydrated?.provider).toBe('openalex');
    expect(hydrated?.candidate.title).toBe('OpenAlex Fallback Paper');
    expect(requestedUrls.some((url) => new URL(url).hostname === 'api.crossref.org')).toBe(true);
    expect(
      requestedUrls.some((url) => {
        const parsed = new URL(url);
        return (
          parsed.hostname === 'api.openalex.org' &&
          parsed.pathname.startsWith('/works/https://doi.org/')
        );
      }),
    ).toBe(true);

    const corruptPdfService = createIngestionService({
      hydrateByDoi: async () => {
        throw new Error('upstream down');
      },
      extractPdfContent: extractPdfContentWithPdfJs,
    });
    const editor = { userId: '11111111-1111-4111-8111-111111111111', role: 'editor' as const };
    const corruptOutcome = await corruptPdfService.ingestPdf(editor, {
      projectId: '22222222-2222-4222-8222-222222222222',
      localPdfFileId: '33333333-3333-4333-8333-333333333333',
      fileName: 'corrupt.pdf',
      pdfBase64: Buffer.from('NOT_A_PDF_AT_ALL', 'utf8').toString('base64'),
    });
    expect(corruptOutcome.ok).toBe(false);
    if (!corruptOutcome.ok) {
      expect(corruptOutcome.error.code).toBe('VALIDATION_ERROR');
    }

    const throwingFetchService = createIngestionService({
      hydrateByDoi: async () => null,
      extractPdfContent: extractPdfContentWithPdfJs,
      fetchPdfBytes: async () => {
        throw new Error('s3 timeout');
      },
    });
    const fetchErrOutcome = await throwingFetchService.ingestPdf(editor, {
      projectId: '22222222-2222-4222-8222-222222222222',
      localPdfFileId: '33333333-3333-4333-8333-333333333333',
      fileName: 'remote.pdf',
    });
    expect(fetchErrOutcome.ok).toBe(false);
    if (!fetchErrOutcome.ok) {
      expect(fetchErrOutcome.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }

    const throwingDoiOutcome = await corruptPdfService.ingestDoi(editor, {
      projectId: '22222222-2222-4222-8222-222222222222',
      doi: '10.1234/throws-500',
    });
    expect(throwingDoiOutcome.ok).toBe(false);
    if (!throwingDoiOutcome.ok) {
      expect(throwingDoiOutcome.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }

    let capturedPerPage = '';
    const pagingFetch: typeof fetch = async (input) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const parsedUrl = new URL(rawUrl);
      capturedPerPage = parsedUrl.searchParams.get('per-page') ?? '';
      return new Response(
        JSON.stringify({
          results: [
            { id: 'https://openalex.org/W1', display_name: 'Paper 1', publication_year: 2025 },
            { id: 'https://openalex.org/W2', display_name: 'Paper 2', publication_year: 2025 },
            { id: 'https://openalex.org/W3', display_name: 'Paper 3', publication_year: 2025 },
            { id: 'https://openalex.org/W4', display_name: 'Paper 4', publication_year: 2025 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const pagedSearch = createLiteratureSearchService({
      adapters: {
        openalex: createOpenAlexAdapter('polite-pool@sunrise.research', pagingFetch),
        crossref: async () => [],
        pubmed: async () => [],
      },
    });
    const page2 = await pagedSearch.search({ query: 'paged', offset: 2, limit: 2 });
    expect(capturedPerPage).toBe('4');
    expect(page2.ok).toBe(true);
    if (page2.ok) {
      expect(page2.value.totalResults).toBe(4);
      expect(page2.value.results.map((item) => item.title)).toEqual(['Paper 3', 'Paper 4']);
    }
  });

  it('wires Phase 2 preload API and IPC router with desktop clipboard and viewer state services', async () => {
    const copied: string[] = [];
    const desktopService = createPhase2DesktopService({
      writeClipboardText: (text) => {
        copied.push(text);
      },
    });
    const listeners = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
    const registrar: Phase2IpcRegistrar = {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
      removeHandler: (channel) => {
        listeners.delete(channel);
      },
    };

    const cleanup = registerPhase2IpcHandlers(registrar, desktopService);
    const bridge = { exposeInMainWorld: vi.fn() };
    const api = exposePhase2SunriseApi(bridge, async (channel, payload) => {
      const listener = listeners.get(channel);
      if (!listener) {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'Missing channel' } };
      }
      return listener({}, payload);
    });

    expect(Object.keys(api).sort()).toEqual([...PHASE2_PRELOAD_EXPOSED_KEYS].sort());
    for (const forbidden of FORBIDDEN_PRELOAD_KEYS) {
      expect(forbidden in api).toBe(false);
    }

    const copyOutcome = await api.references.copyCitation({
      action: 'copy_citation',
      referenceId: '33333333-3333-4333-8333-333333333333',
      citeKey: 'smith2024',
      pageNumber: 5,
      formattedCitation: '[@smith2024, p. 5]',
      selectedText: 'Quoted text',
    });
    expect(copyOutcome.ok).toBe(true);
    expect(copied).toEqual(['[@smith2024, p. 5]']);

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const savedState = await api.pdf.saveViewerState({
      projectId,
      fileId,
      referenceId: null,
      currentPage: 4,
      totalPages: 12,
      zoom: 1.25,
      thumbnailsOpen: true,
      searchQuery: 'results',
      searchMatches: [],
      activeMatchIndex: -1,
      isReadOnly: false,
    });
    expect(savedState.ok).toBe(true);

    const loadedState = await api.pdf.getViewerState({ projectId, fileId });
    expect(loadedState.ok && loadedState.value?.currentPage === 4).toBe(true);
    expect(listeners.has(PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK)).toBe(true);

    cleanup();
    expect(listeners.size).toBe(0);
  });
});
