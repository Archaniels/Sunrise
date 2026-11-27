import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ExportBibliographyResponseSchema,
  ImportBibliographyEntryErrorSchema,
  ImportBibliographyResponseSchema,
  IngestDoiResponseSchema,
  IngestPdfResponseSchema,
  ok,
  type ExportBibliographyInput,
  type ExportBibliographyResponse,
  type ImportBibliographyInput,
  type ImportBibliographyResponse,
  type IngestDoiInput,
  type IngestDoiResponse,
  type IngestPdfInput,
  type IngestPdfResponse,
  type ProjectRole,
  type ProviderPaperCandidate,
  type Reference,
  type Result,
  type UserPublic,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface IngestionActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

interface ExtractedPdfContent {
  readonly text: string;
  readonly xmpTitle: string | null;
  readonly xmpAuthors: readonly string[];
  readonly xmpDoi: string | null;
}

interface IngestionServiceLike {
  readonly ingestDoi: (
    actor: IngestionActor,
    input: IngestDoiInput,
  ) => Promise<Result<IngestDoiResponse>>;
  readonly importBibliography: (
    actor: IngestionActor,
    input: ImportBibliographyInput,
  ) => Promise<Result<ImportBibliographyResponse>>;
  readonly exportBibliography: (
    actor: IngestionActor,
    input: ExportBibliographyInput,
  ) => Promise<Result<ExportBibliographyResponse>>;
  readonly ingestPdf: (
    actor: IngestionActor,
    input: IngestPdfInput,
  ) => Promise<Result<IngestPdfResponse>>;
}

interface ReferenceServiceListLike {
  readonly listReferences: (
    actor: IngestionActor,
    query: { readonly projectId: string },
  ) => Promise<Result<Reference[]>>;
}

interface ReferenceServiceFactoryModuleLike {
  readonly createInMemoryReferenceService: (options?: {
    readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
  }) => ReferenceServiceListLike;
}

interface IngestionServiceFactoryModuleLike {
  readonly createIngestionService: (deps: {
    readonly referenceService?: ReferenceServiceListLike;
    readonly hydrateByDoi: (doi: string) => Promise<{
      readonly provider: 'crossref' | 'openalex';
      readonly candidate: ProviderPaperCandidate;
    } | null>;
    readonly extractPdfContent: (pdfBytes: Uint8Array) => Promise<ExtractedPdfContent>;
    readonly fetchPdfBytes?: (projectId: string, fileId: string) => Promise<Uint8Array | null>;
  }) => IngestionServiceLike;
}

interface FastifyInjectLike {
  readonly inject: (options: {
    readonly method: string;
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly payload?: unknown;
  }) => Promise<{ readonly statusCode: number; readonly json: () => unknown }>;
  readonly close: () => Promise<void>;
}

interface IngestionControllerModuleLike {
  readonly registerIngestionRoutes: (
    app: FastifyInjectLike,
    authService: {
      readonly getMe: (token: string | undefined) => Promise<Result<UserPublic>>;
    },
    projectService: {
      readonly assertAccess: (
        userId: string,
        projectId: string,
        action: string,
      ) => Promise<Result<{ readonly role: ProjectRole }>>;
    },
    ingestionService: IngestionServiceLike,
    guards?: {
      readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
      readonly readFileBytes?: (projectId: string, fileId: string) => Promise<Uint8Array | null>;
    },
  ) => void;
}

interface ServerModuleLike {
  readonly createApiServer: (
    probes: {
      readonly checkPostgres: () => Promise<number>;
      readonly checkPgvector: () => Promise<number>;
      readonly checkS3: () => Promise<number>;
    },
    version: string,
  ) => FastifyInjectLike;
}

async function createScopedReferenceService(
  allowedProjectId: string,
  allowedFileIds: ReadonlySet<string>,
): Promise<ReferenceServiceListLike> {
  const refServicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
  const loaded: unknown = await import(pathToFileURL(refServicePath).href);
  const factory = (loaded as ReferenceServiceFactoryModuleLike).createInMemoryReferenceService;
  return factory({
    assertFileInProject: async (projectId, fileId) =>
      projectId === allowedProjectId && allowedFileIds.has(fileId),
  });
}

function makeProviderPaper(overrides: Partial<ProviderPaperCandidate>): ProviderPaperCandidate {
  return {
    provider: 'crossref',
    externalId: 'CR-DEFAULT',
    title: 'Default Scholarly Paper Title',
    authors: [{ family: 'Smith', given: 'Alex', displayName: 'Alex Smith', orcid: null }],
    year: 2024,
    journal: 'Journal of Testing',
    published: '2024-01-01',
    doi: '10.1000/default',
    url: 'https://doi.org/10.1000/default',
    abstract: 'Default abstract.',
    volume: null,
    issue: null,
    pages: null,
    citationCount: 1,
    pdfUrl: null,
    isOpenAccess: false,
    topics: [],
    ...overrides,
  };
}

function buildTestAuthAndProjectStubs(projectId: string): {
  readonly authService: {
    readonly getMe: (token: string | undefined) => Promise<Result<UserPublic>>;
  };
  readonly projectService: {
    readonly assertAccess: (
      userId: string,
      pid: string,
      action: string,
    ) => Promise<Result<{ readonly role: ProjectRole }>>;
  };
} {
  return {
    authService: {
      getMe: async () =>
        ok({
          id: '22222222-2222-4222-8222-222222222222',
          email: 'editor@sunrise.edu',
          displayName: 'Editor',
          createdAt: '2026-11-25T00:00:00.000Z',
        }),
    },
    projectService: {
      assertAccess: async (_userId, pid) =>
        pid === projectId
          ? ok({ role: 'editor' })
          : { ok: false, error: { code: 'NOT_FOUND', message: 'Project not found' } },
    },
  };
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

const SAMPLE_BIBTEX = [
  '@article{chen2024,',
  '  title = {Deterministic Academic Metadata Extraction},',
  '  author = {Chen, Wei and Patel, Asha},',
  '  journal = {Journal of Digital Libraries},',
  '  year = {2024},',
  '  volume = {18},',
  '  number = {3},',
  '  pages = {45--62},',
  '  doi = {10.1145/3544548.3581234}',
  '}',
].join('\n');

const LONG_RIS_DOI =
  '10.1007/s11192-023-04567-8-reproducible-reference-interchange-format-long-suffix-2023';

const SAMPLE_RIS = [
  'TY  - JOUR',
  'TI  - Reproducible Reference Interchange Formats',
  'AU  - Gomez, Elena',
  'AU  - Novak, Tomas',
  'JO  - Scientometrics Review',
  'PY  - 2023',
  'VL  - 9',
  'IS  - 1',
  'SP  - 10',
  'EP  - 24',
  `DO  - ${LONG_RIS_DOI}`,
  'ER  - ',
].join('\n');

function assertPreservedEntries(
  entries: readonly {
    readonly citeKey: string;
    readonly authors: ReadonlyArray<{ readonly family: string }>;
    readonly journal: string | null;
    readonly doi: string | null;
    readonly pages: string | null;
  }[],
  verifyCiteKey: boolean,
): void {
  expect(entries).toHaveLength(2);
  const chen = entries.find((entry) => entry.doi === '10.1145/3544548.3581234');
  const gomez = entries.find((entry) => entry.doi === LONG_RIS_DOI);

  expect(chen).toBeDefined();
  expect(gomez).toBeDefined();
  if (!chen || !gomez) {
    return;
  }
  expect(chen.authors.map((author) => author.family)).toEqual(['Chen', 'Patel']);
  expect(chen.journal).toBe('Journal of Digital Libraries');
  expect(chen.pages).toMatch(/45[-–]{1,2}62/);
  if (verifyCiteKey) {
    expect(chen.citeKey).toBe('chen2024');
  }

  expect(gomez.authors.map((author) => author.family)).toEqual(['Gomez', 'Novak']);
  expect(gomez.journal).toBe('Scientometrics Review');
  expect(gomez.doi).toBe(LONG_RIS_DOI);
  expect(gomez.pages).toMatch(/10[-–]{1,2}24/);
}

async function assertExportAndReimport(
  service: IngestionServiceLike,
  sourceProjectId: string,
  targetProjectId: string,
  format: 'bibtex' | 'ris',
  editor: IngestionActor,
): Promise<void> {
  const exported = await service.exportBibliography(editor, {
    projectId: sourceProjectId,
    format,
  });
  expect(exported.ok && ExportBibliographyResponseSchema.safeParse(exported.value).success).toBe(
    true,
  );
  if (!exported.ok) {
    return;
  }
  expect(exported.value.entryCount).toBe(2);
  const reimported = await service.importBibliography(editor, {
    projectId: targetProjectId,
    format,
    content: exported.value.content,
  });
  expect(reimported.ok).toBe(true);
  if (reimported.ok) {
    assertPreservedEntries(reimported.value.imported, format === 'bibtex');
  }
}

async function assertBibliographyRoundTrip(
  service: IngestionServiceLike,
  projectId: string,
  editor: IngestionActor,
): Promise<void> {
  const bibImported = await service.importBibliography(editor, {
    projectId,
    format: 'bibtex',
    content: SAMPLE_BIBTEX,
  });
  expect(bibImported.ok).toBe(true);
  if (bibImported.ok) {
    expect(ImportBibliographyResponseSchema.safeParse(bibImported.value).success).toBe(true);
    expect(bibImported.value.imported).toHaveLength(1);
    expect(bibImported.value.imported[0]?.citeKey).toBe('chen2024');
    expect(bibImported.value.imported[0]?.doi).toBe('10.1145/3544548.3581234');
  }

  const risImported = await service.importBibliography(editor, {
    projectId,
    format: 'ris',
    content: SAMPLE_RIS,
  });
  expect(risImported.ok).toBe(true);
  if (risImported.ok) {
    expect(risImported.value.imported).toHaveLength(1);
    expect(risImported.value.imported[0]?.doi).toBe(LONG_RIS_DOI);
  }

  await assertExportAndReimport(
    service,
    projectId,
    '66666666-6666-4666-8666-666666666666',
    'bibtex',
    editor,
  );
  await assertExportAndReimport(
    service,
    projectId,
    '77777777-7777-4777-8777-777777777777',
    'ris',
    editor,
  );
}

describe('Phase 2.3 Multi-channel ingestion (DOI, BibTeX/RIS, PDF) acceptance', () => {
  it('hydrates valid DOIs via Crossref/OpenAlex and returns actionable errors for malformed or unknown DOIs', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/ingestion-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createIngestionService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createIngestionService')) {
      return;
    }

    const hydrateByDoi = vi.fn(
      async (
        doi: string,
      ): Promise<{
        readonly provider: 'crossref' | 'openalex';
        readonly candidate: ProviderPaperCandidate;
      } | null> => {
        if (doi !== '10.1038/s41586-024-00001-1') {
          return null;
        }
        return {
          provider: 'crossref',
          candidate: {
            provider: 'crossref',
            externalId: doi,
            title: 'Hydrated Paper from DOI',
            authors: [
              { family: 'Ada', given: 'Lovelace', displayName: 'Lovelace Ada', orcid: null },
            ],
            year: 2024,
            journal: 'Nature',
            published: '2024-05-01',
            doi,
            url: 'https://doi.org/' + doi,
            abstract: 'Normalized metadata from Crossref.',
            volume: '620',
            issue: '1',
            pages: '1-10',
            citationCount: 33,
            pdfUrl: null,
            isOpenAccess: false,
            topics: ['Computing'],
          },
        };
      },
    );

    const factory = (
      loaded as {
        readonly createIngestionService: (deps: {
          readonly hydrateByDoi: typeof hydrateByDoi;
          readonly extractPdfContent: (pdfBytes: Uint8Array) => Promise<ExtractedPdfContent>;
        }) => IngestionServiceLike;
      }
    ).createIngestionService;

    const service = factory({
      hydrateByDoi,
      extractPdfContent: async () => ({
        text: '',
        xmpTitle: null,
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });

    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };
    const viewer: IngestionActor = {
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'viewer',
    };

    const validResult = await service.ingestDoi(editor, {
      projectId,
      doi: 'https://doi.org/10.1038/S41586-024-00001-1',
    });
    expect(validResult.ok).toBe(true);
    if (validResult.ok) {
      expect(IngestDoiResponseSchema.safeParse(validResult.value).success).toBe(true);
      expect(validResult.value.status).toBe('created');
      expect(validResult.value.reference?.title).toBe('Hydrated Paper from DOI');
    }

    const malformed = await service.ingestDoi(editor, { projectId, doi: 'not-a-valid-doi' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.code).toBe('VALIDATION_ERROR');
    }

    const unknownDoi = await service.ingestDoi(editor, {
      projectId,
      doi: '10.9999/unknown-paper-404',
    });
    expect(unknownDoi.ok).toBe(false);
    if (!unknownDoi.ok) {
      expect(unknownDoi.error.code).toBe('NOT_FOUND');
    }

    const viewerBlocked = await service.ingestDoi(viewer, {
      projectId,
      doi: '10.1038/s41586-024-00001-1',
    });
    expect(viewerBlocked.ok).toBe(false);
    if (!viewerBlocked.ok) {
      expect(viewerBlocked.error.code).toBe('FORBIDDEN');
    }
  });

  it('round-trips BibTeX and RIS imports and exports preserving authors, venues, DOIs, pages, and citeKeys', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/ingestion-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createIngestionService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createIngestionService')) {
      return;
    }

    const factory = (
      loaded as {
        readonly createIngestionService: (deps: {
          readonly hydrateByDoi: (doi: string) => Promise<null>;
          readonly extractPdfContent: (pdfBytes: Uint8Array) => Promise<ExtractedPdfContent>;
        }) => IngestionServiceLike;
      }
    ).createIngestionService;

    const service = factory({
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: '',
        xmpTitle: null,
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });

    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };

    await assertBibliographyRoundTrip(service, projectId, editor);
  });

  it('extracts embedded PDF DOI deterministically without an LLM key and links S3 PDF while preserving Phase 4 BYOK slot', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/ingestion-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createIngestionService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createIngestionService')) {
      return;
    }

    const factory = (loaded as IngestionServiceFactoryModuleLike).createIngestionService;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileIdWithDoi = '44444444-4444-4444-8444-444444444444';
    const fileIdNoDoi = '55555555-5555-4555-8555-555555555555';
    const mockPdfBytes = Uint8Array.from(Buffer.from('%PDF-1.7 mock', 'utf8'));
    const mockPdfBase64 = Buffer.from(mockPdfBytes).toString('base64');
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };

    const refServiceWithDoi = await createScopedReferenceService(
      projectId,
      new Set([fileIdWithDoi]),
    );
    const serviceWithDoi = factory({
      referenceService: refServiceWithDoi,
      fetchPdfBytes: async (pid, fid) =>
        pid === projectId && fid === fileIdWithDoi ? mockPdfBytes : null,
      hydrateByDoi: async (doi) => ({
        provider: 'openalex',
        candidate: {
          provider: 'openalex',
          externalId: 'W-PDF-1',
          title: 'PDF Hydrated Research Article',
          authors: [{ family: 'Lin', given: 'Mei', displayName: 'Mei Lin', orcid: null }],
          year: 2025,
          journal: 'ACL Findings',
          published: '2025-07-01',
          doi,
          url: 'https://doi.org/' + doi,
          abstract: 'Hydrated from embedded PDF DOI.',
          volume: null,
          issue: null,
          pages: '100-112',
          citationCount: 7,
          pdfUrl: null,
          isOpenAccess: true,
          topics: ['NLP'],
        },
      }),
      extractPdfContent: async () => ({
        text: 'Published 2025. DOI: 10.18653/v1/2025.acl-1.10',
        xmpTitle: 'PDF Hydrated Research Article',
        xmpAuthors: ['Mei Lin'],
        xmpDoi: null,
      }),
    });

    const pdfWithDoiResult = await serviceWithDoi.ingestPdf(editor, {
      projectId,
      localPdfFileId: fileIdWithDoi,
      fileName: 'lin2025.pdf',
      pdfBase64: mockPdfBase64,
    });
    expect(pdfWithDoiResult.ok).toBe(true);
    if (pdfWithDoiResult.ok) {
      expect(IngestPdfResponseSchema.safeParse(pdfWithDoiResult.value).success).toBe(true);
      expect(pdfWithDoiResult.value.extractionMethod).toBe('doi_hydrated');
      expect(pdfWithDoiResult.value.byokFallbackUsed).toBe(false);
      expect(pdfWithDoiResult.value.detectedDoi).toBe('10.18653/v1/2025.acl-1.10');
      expect(pdfWithDoiResult.value.reference?.localPdfFileId).toBe(fileIdWithDoi);
    }

    const refServiceWithoutDoi = await createScopedReferenceService(
      projectId,
      new Set([fileIdNoDoi]),
    );
    const serviceWithoutDoi = factory({
      referenceService: refServiceWithoutDoi,
      fetchPdfBytes: async (pid, fid) =>
        pid === projectId && fid === fileIdNoDoi ? mockPdfBytes : null,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: 'Unpublished Technical Working Paper Without Identifier',
        xmpTitle: 'Unpublished Technical Working Paper',
        xmpAuthors: ['Alex Rivera'],
        xmpDoi: null,
      }),
    });

    const pdfNoDoiResult = await serviceWithoutDoi.ingestPdf(editor, {
      projectId,
      localPdfFileId: fileIdNoDoi,
      fileName: 'working-paper.pdf',
      pdfBase64: mockPdfBase64,
      allowByokFallback: false,
    });
    expect(pdfNoDoiResult.ok).toBe(true);
    if (pdfNoDoiResult.ok) {
      expect(pdfNoDoiResult.value.extractionMethod).toBe('xmp_and_text_heuristic');
      expect(pdfNoDoiResult.value.byokFallbackUsed).toBe(false);
      expect(pdfNoDoiResult.value.needsLlmFallback).toBe(true);
      expect(pdfNoDoiResult.value.reference?.localPdfFileId).toBe(fileIdNoDoi);
    }
  });

  it('requires storage-backed verification for linked PDF HTTP ingestion and rejects unverified inline pdfBase64', async () => {
    const controllerPath = join(REPO_ROOT, 'apps/api/src/controllers/ingestion-controller.ts');
    const serverPath = join(REPO_ROOT, 'apps/api/src/server.ts');
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    const loadedController: unknown = await import(pathToFileURL(controllerPath).href);
    const loadedServer: unknown = await import(pathToFileURL(serverPath).href);
    const loadedService: unknown = await import(pathToFileURL(servicePath).href);

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileId = '44444444-4444-4444-8444-444444444444';
    const storedBytes = Uint8Array.from(Buffer.from('%PDF-1.7 verified-stored', 'utf8'));
    const matchingBase64 = Buffer.from(storedBytes).toString('base64');
    const spoofedBase64 = Buffer.from('%PDF-1.7 spoofed-inline', 'utf8').toString('base64');
    const { authService, projectService } = buildTestAuthAndProjectStubs(projectId);
    const { registerIngestionRoutes } = loadedController as IngestionControllerModuleLike;
    const { createApiServer } = loadedServer as ServerModuleLike;
    const { createIngestionService } = loadedService as IngestionServiceFactoryModuleLike;

    const refServiceUnverified = await createScopedReferenceService(projectId, new Set([fileId]));
    const ingestionWithoutStorage = createIngestionService({
      referenceService: refServiceUnverified,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: 'Inline Spoofed Text',
        xmpTitle: 'Inline Spoofed Text',
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });

    const appNoStorageReader = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
    );
    registerIngestionRoutes(
      appNoStorageReader,
      authService,
      projectService,
      ingestionWithoutStorage,
      { assertFileInProject: async (pid, fid) => pid === projectId && fid === fileId },
    );
    try {
      const unverifiedRes = await appNoStorageReader.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers: { authorization: 'Bearer valid' },
        payload: { localPdfFileId: fileId, fileName: 'paper.pdf', pdfBase64: spoofedBase64 },
      });
      expect([400, 404, 503]).toContain(unverifiedRes.statusCode);
      const body = unverifiedRes.json() as { readonly ok?: boolean };
      expect(body.ok).toBe(false);
    } finally {
      await appNoStorageReader.close();
    }

    const refServiceVerified = await createScopedReferenceService(projectId, new Set([fileId]));
    const ingestionWithStorage = createIngestionService({
      referenceService: refServiceVerified,
      fetchPdfBytes: async (pid, fid) => (pid === projectId && fid === fileId ? storedBytes : null),
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: 'Verified Stored PDF',
        xmpTitle: 'Verified Stored PDF',
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });

    const appWithStorageReader = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
    );
    registerIngestionRoutes(
      appWithStorageReader,
      authService,
      projectService,
      ingestionWithStorage,
      {
        assertFileInProject: async (pid, fid) => pid === projectId && fid === fileId,
        readFileBytes: async (pid, fid) =>
          pid === projectId && fid === fileId ? storedBytes : null,
      },
    );
    try {
      const mismatchRes = await appWithStorageReader.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers: { authorization: 'Bearer valid' },
        payload: { localPdfFileId: fileId, fileName: 'paper.pdf', pdfBase64: spoofedBase64 },
      });
      expect(mismatchRes.statusCode).toBe(400);

      const verifiedRes = await appWithStorageReader.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers: { authorization: 'Bearer valid' },
        payload: { localPdfFileId: fileId, fileName: 'paper.pdf', pdfBase64: matchingBase64 },
      });
      expect(verifiedRes.statusCode).toBe(201);
    } finally {
      await appWithStorageReader.close();
    }
  });

  it('accepts RIS records whose abstract contains BibTeX syntax while still rejecting mismatched formats', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    const service = (loaded as IngestionServiceFactoryModuleLike).createIngestionService({
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({ text: '', xmpTitle: null, xmpAuthors: [], xmpDoi: null }),
    });

    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };
    const risWithBibtexAbstract = [
      'TY  - JOUR',
      'TI  - Parsing RIS Abstracts With Embedded BibTeX',
      'AU  - Patel, Asha',
      'PY  - 2024',
      'AB  - Example inline snippet: @article{key, title={Embedded}} inside abstract.',
      'ER  - ',
    ].join('\n');

    const risAccepted = await service.importBibliography(editor, {
      projectId,
      format: 'ris',
      content: risWithBibtexAbstract,
    });
    expect(risAccepted.ok).toBe(true);
    if (risAccepted.ok) {
      expect(ImportBibliographyResponseSchema.safeParse(risAccepted.value).success).toBe(true);
      expect(risAccepted.value.imported).toHaveLength(1);
      expect(risAccepted.value.imported[0]?.title).toBe(
        'Parsing RIS Abstracts With Embedded BibTeX',
      );
    }

    const bibAsRis = await service.importBibliography(editor, {
      projectId,
      format: 'ris',
      content: '@article{wrong2024, title = {Actual BibTeX Entry}, year = {2024}}',
    });
    expect(bibAsRis.ok).toBe(false);
    if (!bibAsRis.ok) {
      expect(bibAsRis.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('rejects surname-only cited DOI verification when XMP title is absent without corroborating heading evidence', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    const { createIngestionService } = loaded as IngestionServiceFactoryModuleLike;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileIdSurname = '44444444-4444-4444-8444-444444444444';
    const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.7 body', 'utf8'));
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };

    const refServiceA = await createScopedReferenceService(projectId, new Set([fileIdSurname]));
    const surnameService = createIngestionService({
      referenceService: refServiceA,
      fetchPdfBytes: async (pid, fid) =>
        pid === projectId && fid === fileIdSurname ? pdfBytes : null,
      hydrateByDoi: async (doi) => ({
        provider: 'crossref',
        candidate: makeProviderPaper({
          title: 'Unrelated Agricultural Soil Microbiology Survey',
          authors: [{ family: 'Smith', given: 'Alex', displayName: 'Alex Smith', orcid: null }],
          doi,
        }),
      }),
      extractPdfContent: async () => ({
        text: 'Quantum Compiler Verification Architecture\nRelated work cites 10.1000/cited-smith-2020.',
        xmpTitle: null,
        xmpAuthors: ['Jane Smith'],
        xmpDoi: null,
      }),
    });

    const surnameRes = await surnameService.ingestPdf(editor, {
      projectId,
      localPdfFileId: fileIdSurname,
      fileName: 'quantum-compiler.pdf',
    });
    expect(surnameRes.ok).toBe(true);
    if (surnameRes.ok) {
      expect(surnameRes.value.extractionMethod).toBe('xmp_and_text_heuristic');
      expect(surnameRes.value.detectedDoi).toBeNull();
      expect(surnameRes.value.unverifiedCandidateDois).toEqual(['10.1000/cited-smith-2020']);
    }
  });

  it('leaves transiently failed cited body DOIs unverified and continues to later candidates or heuristics', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    const { createIngestionService } = loaded as IngestionServiceFactoryModuleLike;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileIdTransient = '55555555-5555-4555-8555-555555555555';
    const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.7 body', 'utf8'));
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };

    const refServiceB = await createScopedReferenceService(projectId, new Set([fileIdTransient]));
    const transientService = createIngestionService({
      referenceService: refServiceB,
      fetchPdfBytes: async (pid, fid) =>
        pid === projectId && fid === fileIdTransient ? pdfBytes : null,
      hydrateByDoi: async (doi) => {
        if (doi === '10.1000/transient-503') {
          throw new Error('DOI metadata providers unavailable: Crossref returned HTTP 503');
        }
        return {
          provider: 'openalex',
          candidate: makeProviderPaper({
            provider: 'openalex',
            title: 'Resilient PDF Ingestion Pipeline',
            authors: [{ family: 'Lin', given: 'Mei', displayName: 'Mei Lin', orcid: null }],
            doi,
          }),
        };
      },
      extractPdfContent: async () => ({
        text: 'Resilient PDF Ingestion Pipeline\nPrior work 10.1000/transient-503. Paper DOI: 10.1000/actual-paper-2025.',
        xmpTitle: 'Resilient PDF Ingestion Pipeline',
        xmpAuthors: ['Mei Lin'],
        xmpDoi: null,
      }),
    });

    const transientPdfRes = await transientService.ingestPdf(editor, {
      projectId,
      localPdfFileId: fileIdTransient,
      fileName: 'resilient.pdf',
    });
    expect(transientPdfRes.ok).toBe(true);
    if (transientPdfRes.ok) {
      expect(transientPdfRes.value.extractionMethod).toBe('doi_hydrated');
      expect(transientPdfRes.value.detectedDoi).toBe('10.1000/actual-paper-2025');
    }

    const explicitDoiRes = await transientService.ingestDoi(editor, {
      projectId,
      doi: '10.1000/transient-503',
    });
    expect(explicitDoiRes.ok).toBe(false);
    if (!explicitDoiRes.ok) {
      expect(explicitDoiRes.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }
  });

  it('keeps title-less BibTeX errors with >128-char rawCiteKey schema-compliant without false rollback after commit', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/ingestion-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };
    const referenceService = await createScopedReferenceService(projectId, new Set());
    const service = (loaded as IngestionServiceFactoryModuleLike).createIngestionService({
      referenceService,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({ text: '', xmpTitle: null, xmpAuthors: [], xmpDoi: null }),
    });

    const oversizedCiteKey = `longkey${'x'.repeat(150)}`;
    const content = [
      '@article{valid2024, title = {Committed Valid Entry}, year = {2024}}',
      `@article{${oversizedCiteKey}, author = {Smith, Jane}, year = {2024}}`,
    ].join('\n');

    const outcome = await service.importBibliography(editor, {
      projectId,
      format: 'bibtex',
      content,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(ImportBibliographyResponseSchema.safeParse(outcome.value).success).toBe(true);
    expect(outcome.value.imported).toHaveLength(1);
    expect(outcome.value.errors).toHaveLength(1);
    expect(ImportBibliographyEntryErrorSchema.safeParse(outcome.value.errors[0]).success).toBe(
      true,
    );
  });
});
