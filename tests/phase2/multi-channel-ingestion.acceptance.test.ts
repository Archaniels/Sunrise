import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ExportBibliographyResponseSchema,
  ImportBibliographyResponseSchema,
  IngestDoiResponseSchema,
  IngestPdfResponseSchema,
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
  type Result,
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

    const factory = (
      loaded as {
        readonly createIngestionService: (deps: {
          readonly hydrateByDoi: (doi: string) => Promise<{
            readonly provider: 'openalex';
            readonly candidate: ProviderPaperCandidate;
          } | null>;
          readonly extractPdfContent: (pdfBytes: Uint8Array) => Promise<ExtractedPdfContent>;
        }) => IngestionServiceLike;
      }
    ).createIngestionService;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileIdWithDoi = '44444444-4444-4444-8444-444444444444';
    const fileIdNoDoi = '55555555-5555-4555-8555-555555555555';
    const editor: IngestionActor = {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'editor',
    };

    const serviceWithDoi = factory({
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
      pdfBase64: Buffer.from('%PDF-1.7 mock', 'utf8').toString('base64'),
    });
    expect(pdfWithDoiResult.ok).toBe(true);
    if (pdfWithDoiResult.ok) {
      expect(IngestPdfResponseSchema.safeParse(pdfWithDoiResult.value).success).toBe(true);
      expect(pdfWithDoiResult.value.extractionMethod).toBe('doi_hydrated');
      expect(pdfWithDoiResult.value.byokFallbackUsed).toBe(false);
      expect(pdfWithDoiResult.value.detectedDoi).toBe('10.18653/v1/2025.acl-1.10');
      expect(pdfWithDoiResult.value.reference?.localPdfFileId).toBe(fileIdWithDoi);
    }

    const serviceWithoutDoi = factory({
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
      pdfBase64: Buffer.from('%PDF-1.7 mock', 'utf8').toString('base64'),
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
});
