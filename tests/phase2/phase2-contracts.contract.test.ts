import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  buildPdfAskRavenPayload,
  buildPdfCopyCitationPayload,
  buildPdfCreateNotePayload,
  canRoleMutatePdfAnnotations,
  canRoleMutateReferences,
  CiteKeySchema,
  clampPdfPage,
  clampPdfZoom,
  computeTitleSimilarity,
  CreateReferenceOutcomeSchema,
  deduplicatePaperCandidates,
  DEFAULT_PROVIDER_CLIENT_POLICY,
  DuplicateReferenceConflictSchema,
  ExportBibliographyInputSchema,
  extractDoisFromText,
  FederatedSearchResponseSchema,
  FORBIDDEN_PRELOAD_KEYS,
  generateDeterministicCiteKey,
  ImportBibliographyInputSchema,
  IngestDoiInputSchema,
  IngestPdfInputSchema,
  IngestPdfResponseSchema,
  LiteratureSearchFiltersSchema,
  matchesLiteratureFilters,
  normalizeAuthorFamilyForMatching,
  normalizeDoi,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PdfAnnotationSchema,
  PdfDeepLinkTargetSchema,
  PdfSelectionActionPayloadSchema,
  PdfViewerStateSchema,
  PHASE2_IPC_CHANNELS,
  PHASE2_IPC_EVENT_CHANNELS,
  PHASE2_PRELOAD_EXPOSED_KEYS,
  Phase2IpcChannelContracts,
  Phase2IpcEventContracts,
  ProviderClientPolicySchema,
  ReferenceManagerViewStateSchema,
  ReferenceSchema,
  type PdfDeepLinkOpenedListener,
  type Phase2SunrisePreloadApi,
  type ProviderPaperCandidate,
  type Reference,
  type ReferenceAuthor,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const REF_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const ANNOTATION_ID = '55555555-5555-4555-8555-555555555555';
const SAMPLE_ISO = '2026-11-25T09:00:00.000Z';

const AUTHOR_SMITH: ReferenceAuthor = {
  family: 'Smith',
  given: 'Jane',
  displayName: 'Jane Smith',
  orcid: '0000-0002-1825-0097',
};

const AUTHOR_CHEN: ReferenceAuthor = {
  family: 'Chen',
  given: 'Wei',
  displayName: 'Wei Chen',
  orcid: null,
};

function buildSampleReference(): Reference {
  return {
    id: REF_ID,
    projectId: PROJECT_ID,
    citeKey: 'smith2024',
    title: 'Federated Scientific Discovery in Research Workspaces',
    authors: [AUTHOR_SMITH, AUTHOR_CHEN],
    year: 2024,
    journal: 'Nature Digital Research',
    published: '2024-06-15',
    doi: '10.1038/s41586-024-00001-1',
    url: 'https://doi.org/10.1038/s41586-024-00001-1',
    abstract: 'We evaluate federated scholarly search and citation grounding.',
    volume: '12',
    issue: '4',
    pages: '101-118',
    citationCount: 87,
    pdfUrl: 'https://arxiv.org/pdf/2406.00001.pdf',
    localPdfFileId: FILE_ID,
    tags: ['literature-search', 'citations'],
    notes: 'Core baseline architecture paper.',
    sourceProvider: 'openalex',
    createdAt: SAMPLE_ISO,
    updatedAt: SAMPLE_ISO,
  };
}

function buildProviderCandidate(
  overrides: Partial<ProviderPaperCandidate>,
): ProviderPaperCandidate {
  return {
    provider: 'openalex',
    externalId: 'W1001',
    title: 'Federated Scientific Discovery in Research Workspaces',
    authors: [AUTHOR_SMITH],
    year: 2024,
    journal: 'Nature Digital Research',
    published: '2024-06-15',
    doi: 'https://doi.org/10.1038/S41586-024-00001-1',
    url: 'https://openalex.org/W1001',
    abstract: 'Short abstract.',
    volume: '12',
    issue: null,
    pages: '101-118',
    citationCount: 42,
    pdfUrl: null,
    isOpenAccess: false,
    topics: ['Information Retrieval'],
    ...overrides,
  };
}

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

function collectAnyNodes(node: ts.Node, findings: string[]): void {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    findings.push(`any:${node.getStart()}`);
  }
  ts.forEachChild(node, (child) => {
    collectAnyNodes(child, findings);
  });
}

function scanStaticHygiene(filePath: string, sourceText: string): string[] {
  const findings: string[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      findings.push(`comment:${scanner.getTokenPos()}`);
    }
    token = scanner.scan();
  }
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true);
  collectAnyNodes(sourceFile, findings);
  return findings;
}

describe('Phase 2 shared contracts', () => {
  describe('Static hygiene and preload key safety', () => {
    it('enforces zero comments and zero any across tests/phase2 files', () => {
      const files = collectTypeScriptFiles(join(REPO_ROOT, 'tests/phase2'));
      expect(files.length).toBeGreaterThanOrEqual(5);
      for (const filePath of files) {
        const text = readFileSync(filePath, 'utf8');
        expect(scanStaticHygiene(filePath, text), `Violations in ${filePath}`).toEqual([]);
      }
    });

    it('ensures PHASE2_PRELOAD_EXPOSED_KEYS never collide with FORBIDDEN_PRELOAD_KEYS', () => {
      const forbiddenSet = new Set<string>(FORBIDDEN_PRELOAD_KEYS);
      for (const key of PHASE2_PRELOAD_EXPOSED_KEYS) {
        expect(forbiddenSet.has(key), `Forbidden preload key collision: ${key}`).toBe(false);
      }
      expect(PHASE2_PRELOAD_EXPOSED_KEYS).toContain('references');
      expect(PHASE2_PRELOAD_EXPOSED_KEYS).toContain('pdf');
    });
  });

  describe('2.1 Federated literature search and deduplication contracts', () => {
    it('validates provider client policy and filter bounds including yearFrom <= yearTo', () => {
      expect(ProviderClientPolicySchema.safeParse(DEFAULT_PROVIDER_CLIENT_POLICY).success).toBe(
        true,
      );
      expect(
        LiteratureSearchFiltersSchema.safeParse({
          yearFrom: 2020,
          yearTo: 2025,
          author: 'Smith',
          journal: 'Nature',
          minCitationCount: 10,
          fieldOrTopic: 'Machine Learning',
          openAccessOnly: true,
          pdfAvailableOnly: true,
        }).success,
      ).toBe(true);
      expect(
        LiteratureSearchFiltersSchema.safeParse({
          yearFrom: 2026,
          yearTo: 2022,
        }).success,
      ).toBe(false);
      expect(
        LiteratureSearchFiltersSchema.safeParse({
          minCitationCount: -1,
        }).success,
      ).toBe(false);
    });

    it('deduplicates canonical DOI matches across providers preserving richest metadata and highest citation count', () => {
      const openAlexCandidate = buildProviderCandidate({
        provider: 'openalex',
        externalId: 'W1001',
        doi: 'https://doi.org/10.1038/S41586-024-00001-1',
        abstract: 'Short abstract.',
        citationCount: 87,
        pdfUrl: 'https://arxiv.org/pdf/2406.00001.pdf',
        isOpenAccess: true,
        topics: ['Information Retrieval'],
      });
      const crossrefCandidate = buildProviderCandidate({
        provider: 'crossref',
        externalId: 'CR-1',
        doi: 'doi:10.1038/s41586-024-00001-1',
        authors: [AUTHOR_SMITH, AUTHOR_CHEN],
        abstract: 'A significantly richer and longer abstract describing federated methodology.',
        issue: '4',
        citationCount: 61,
        pdfUrl: null,
        isOpenAccess: false,
        topics: ['Scholarly Communication'],
      });
      const pubmedCandidate = buildProviderCandidate({
        provider: 'pubmed',
        externalId: 'PMID-999',
        doi: '10.1038/s41586-024-00001-1.',
        citationCount: 95,
        topics: ['Biomedical Informatics'],
      });

      const merged = deduplicatePaperCandidates([
        openAlexCandidate,
        crossrefCandidate,
        pubmedCandidate,
      ]);

      expect(merged).toHaveLength(1);
      const result = merged[0];
      expect(result).toBeDefined();
      if (!result) {
        return;
      }
      expect(result.matchedBy).toBe('doi');
      expect(result.doi).toBe('10.1038/s41586-024-00001-1');
      expect(result.providers).toEqual(['openalex', 'crossref', 'pubmed']);
      expect(result.authors).toHaveLength(2);
      expect(result.abstract).toContain('significantly richer');
      expect(result.citationCount).toBe(95);
      expect(result.pdfUrl).toBe('https://arxiv.org/pdf/2406.00001.pdf');
      expect(result.isOpenAccess).toBe(true);
      expect(result.availableActions).toEqual(['open', 'save', 'pdf', 'add_to_project']);
    });

    it('deduplicates by normalized title, first author, and year when DOI is absent without merging distinct papers', () => {
      const noDoiCandidateA = buildProviderCandidate({
        provider: 'openalex',
        externalId: 'W2001',
        title: 'Neural Scaling Laws for Academic Retrieval Systems!',
        authors: [AUTHOR_SMITH],
        year: 2023,
        doi: null,
        citationCount: 15,
      });
      const noDoiCandidateB = buildProviderCandidate({
        provider: 'pubmed',
        externalId: 'PMID-2001',
        title: 'neural scaling laws for academic retrieval systems',
        authors: [AUTHOR_SMITH, AUTHOR_CHEN],
        year: 2023,
        doi: null,
        citationCount: 28,
      });
      const distinctYearCandidate = buildProviderCandidate({
        provider: 'crossref',
        externalId: 'CR-2002',
        title: 'Neural Scaling Laws for Academic Retrieval Systems',
        authors: [AUTHOR_SMITH],
        year: 2021,
        doi: null,
        citationCount: 5,
      });

      expect(computeTitleSimilarity(noDoiCandidateA.title, noDoiCandidateB.title)).toBe(1);
      const deduped = deduplicatePaperCandidates([
        noDoiCandidateA,
        noDoiCandidateB,
        distinctYearCandidate,
      ]);
      expect(deduped).toHaveLength(2);
      expect(deduped[0]?.matchedBy).toBe('title_author_year');
      expect(deduped[0]?.citationCount).toBe(28);
      expect(deduped[1]?.year).toBe(2021);
    });

    it('never fuzzy-merges papers with different known DOIs and supports Unicode author/title matching', () => {
      const partOne = buildProviderCandidate({
        provider: 'openalex',
        externalId: 'W-PART-1',
        title:
          'Comprehensive Multi-Year Empirical Evaluation of Federated Academic Literature Discovery and Citation Grounding Pipelines Part I',
        authors: [AUTHOR_SMITH],
        year: 2024,
        doi: '10.1038/s41586-024-00101-1',
      });
      const partTwo = buildProviderCandidate({
        provider: 'crossref',
        externalId: 'CR-PART-2',
        title:
          'Comprehensive Multi-Year Empirical Evaluation of Federated Academic Literature Discovery and Citation Grounding Pipelines Part II',
        authors: [AUTHOR_SMITH],
        year: 2024,
        doi: '10.1038/s41586-024-00102-2',
      });

      expect(computeTitleSimilarity(partOne.title, partTwo.title)).toBeGreaterThanOrEqual(0.85);
      const distinctDoiResults = deduplicatePaperCandidates([partOne, partTwo]);
      expect(distinctDoiResults).toHaveLength(2);
      expect(distinctDoiResults[0]?.doi).toBe('10.1038/s41586-024-00101-1');
      expect(distinctDoiResults[1]?.doi).toBe('10.1038/s41586-024-00102-2');

      const unicodeAuthor: ReferenceAuthor = {
        family: '山田',
        given: '太郎',
        displayName: '山田 太郎',
        orcid: null,
      };
      expect(normalizeAuthorFamilyForMatching(unicodeAuthor)).toBe('山田');
      expect(computeTitleSimilarity('研究方法', '研究方法')).toBe(1);

      const unicodeA = buildProviderCandidate({
        provider: 'openalex',
        externalId: 'W-JP-1',
        title: '研究方法',
        authors: [unicodeAuthor],
        year: 2024,
        doi: null,
        citationCount: 10,
      });
      const unicodeB = buildProviderCandidate({
        provider: 'pubmed',
        externalId: 'PMID-JP-1',
        title: '研究方法',
        authors: [unicodeAuthor],
        year: 2024,
        doi: null,
        citationCount: 22,
      });
      const unicodeMerged = deduplicatePaperCandidates([unicodeA, unicodeB]);
      expect(unicodeMerged).toHaveLength(1);
      expect(unicodeMerged[0]?.matchedBy).toBe('title_author_year');
      expect(unicodeMerged[0]?.citationCount).toBe(22);
    });

    it('evaluates literature filters and validates partial-outage FederatedSearchResponseSchema', () => {
      const results = deduplicatePaperCandidates([
        buildProviderCandidate({
          pdfUrl: 'https://arxiv.org/pdf/2406.00001.pdf',
          isOpenAccess: true,
          citationCount: 50,
          topics: ['Machine Learning', 'Citations'],
        }),
      ]);
      const paper = results[0];
      expect(paper).toBeDefined();
      if (!paper) {
        return;
      }

      expect(
        matchesLiteratureFilters(paper, {
          yearFrom: 2023,
          yearTo: 2025,
          author: 'smith',
          journal: 'nature',
          minCitationCount: 40,
          fieldOrTopic: 'machine learning',
          openAccessOnly: true,
          pdfAvailableOnly: true,
        }),
      ).toBe(true);
      expect(matchesLiteratureFilters(paper, { minCitationCount: 100 })).toBe(false);

      const partialOutageResponse = FederatedSearchResponseSchema.safeParse({
        query: 'federated scientific discovery',
        totalResults: 1,
        totalResultsIsEstimate: true,
        hasMore: false,
        upstreamFetchCapReached: false,
        cached: false,
        results,
        warnings: [
          {
            provider: 'pubmed',
            code: 'TIMEOUT',
            message: 'PubMed request timed out after 8000ms',
            retryable: true,
          },
        ],
        providerSummaries: [
          { provider: 'openalex', status: 'ok', resultCount: 1, cached: false, latencyMs: 120 },
          { provider: 'crossref', status: 'ok', resultCount: 0, cached: false, latencyMs: 180 },
          { provider: 'pubmed', status: 'failed', resultCount: 0, cached: false, latencyMs: 8000 },
        ],
      });
      expect(partialOutageResponse.success).toBe(true);
    });
  });

  describe('2.2 Project bibliography database and Reference Manager contracts', () => {
    it('validates complete ReferenceSchema, DOI normalization, and deterministic citeKey disambiguation', () => {
      const sample = buildSampleReference();
      expect(ReferenceSchema.safeParse(sample).success).toBe(true);
      expect(ReferenceSchema.safeParse({ ...sample, doi: 'not-a-doi' }).success).toBe(false);
      expect(ReferenceSchema.safeParse({ ...sample, url: 'javascript:alert(1)' }).success).toBe(
        false,
      );

      expect(normalizeDoi('https://doi.org/10.1038/S41586-024-00001-1.')).toBe(
        '10.1038/s41586-024-00001-1',
      );
      expect(normalizeDoi('doi: 10.1145/3544548.3581000')).toBe('10.1145/3544548.3581000');
      expect(normalizeDoi('10.1234/example(2024)')).toBe('10.1234/example(2024)');
      expect(normalizeDoi('10.1234/example(2024)).')).toBe('10.1234/example(2024)');
      expect(normalizeDoi('invalid-doi-string')).toBeNull();

      const key1 = generateDeterministicCiteKey([AUTHOR_SMITH], 2024, new Set());
      const key2 = generateDeterministicCiteKey([AUTHOR_SMITH], 2024, new Set([key1]));
      const key3 = generateDeterministicCiteKey(
        [AUTHOR_SMITH],
        2024,
        new Set([key1.toUpperCase(), key2]),
      );
      expect(key1).toBe('smith2024');
      expect(key2).toBe('smith2024b');
      expect(key3).toBe('smith2024c');
      expect(generateDeterministicCiteKey([], null, new Set())).toBe('untitlednd');

      const digitAuthor: ReferenceAuthor = {
        family: '3M Research',
        given: '',
        displayName: '3M Research',
        orcid: null,
      };
      const digitKey1 = generateDeterministicCiteKey([digitAuthor], 2024, new Set());
      const digitKey2 = generateDeterministicCiteKey([digitAuthor], 2024, new Set([digitKey1]));
      expect(CiteKeySchema.safeParse(digitKey1).success).toBe(true);
      expect(CiteKeySchema.safeParse(digitKey2).success).toBe(true);
      expect(digitKey1).toBe('ref3mresearch2024');
      expect(digitKey2).toBe('ref3mresearch2024b');
    });

    it('validates duplicate DOI conflict payload, Reference Manager state, and RBAC mutation rules', () => {
      const existingReference = buildSampleReference();
      const conflict = {
        code: 'DUPLICATE_DOI_CONFLICT' as const,
        doi: '10.1038/s41586-024-00001-1',
        existingReference,
        incomingTitle: 'Federated Scientific Discovery in Research Workspaces',
        incomingSourceProvider: 'crossref' as const,
        conflictingFields: ['abstract', 'citationCount'],
        suggestedAction: 'merge' as const,
      };
      expect(DuplicateReferenceConflictSchema.safeParse(conflict).success).toBe(true);
      expect(CreateReferenceOutcomeSchema.safeParse({ status: 'conflict', conflict }).success).toBe(
        true,
      );

      expect(
        ReferenceManagerViewStateSchema.safeParse({
          projectId: PROJECT_ID,
          selectedReferenceId: REF_ID,
          activeTag: 'citations',
          searchQuery: 'smith',
          sortBy: 'year',
          sortOrder: 'desc',
          isReadOnly: true,
        }).success,
      ).toBe(true);

      expect(canRoleMutateReferences('owner')).toBe(true);
      expect(canRoleMutateReferences('editor')).toBe(true);
      expect(canRoleMutateReferences('viewer')).toBe(false);
    });
  });

  describe('2.3 Multi-channel ingestion contracts (DOI, BibTeX/RIS, PDF)', () => {
    it('extracts and deduplicates embedded DOIs from PDF text and validates ingestion DTOs', () => {
      const pdfText =
        'Journal of AI 2024. DOI: 10.1038/s41586-024-00001-1. Also see https://doi.org/10.1145/3544548.3581000), balanced 10.1234/example(2024). and duplicate 10.1038/S41586-024-00001-1;';
      expect(extractDoisFromText(pdfText)).toEqual([
        '10.1038/s41586-024-00001-1',
        '10.1145/3544548.3581000',
        '10.1234/example(2024)',
      ]);
      expect(extractDoisFromText('No identifiers present in this manuscript')).toEqual([]);

      expect(
        IngestPdfResponseSchema.safeParse({
          status: 'created',
          extractionMethod: 'xmp_and_text_heuristic',
          detectedDoi: null,
          hydratedFrom: 'none',
          byokFallbackUsed: false,
          needsLlmFallback: true,
          reference: buildSampleReference(),
          conflict: null,
          unverifiedCandidateDois: ['10.1234/example(2024)'],
        }).success,
      ).toBe(true);

      expect(
        IngestDoiInputSchema.safeParse({
          projectId: PROJECT_ID,
          doi: '10.1038/s41586-024-00001-1',
        }).success,
      ).toBe(true);

      expect(
        ImportBibliographyInputSchema.safeParse({
          projectId: PROJECT_ID,
          format: 'bibtex',
          content: '@article{smith2024, title={Example}}',
        }).success,
      ).toBe(true);

      expect(
        ExportBibliographyInputSchema.safeParse({
          projectId: PROJECT_ID,
          format: 'ris',
          referenceIds: [REF_ID],
        }).success,
      ).toBe(true);

      const parsedPdf = IngestPdfInputSchema.safeParse({
        projectId: PROJECT_ID,
        localPdfFileId: FILE_ID,
        fileName: 'smith2024.pdf',
      });
      expect(parsedPdf.success).toBe(true);
      if (parsedPdf.success) {
        expect(parsedPdf.data.allowByokFallback).toBe(false);
      }
    });

    it('preserves balanced DOI endings and trims pathological trailing delimiters in linear time', () => {
      expect(normalizeDoi('10.1234/example(2024)')).toBe('10.1234/example(2024)');
      expect(normalizeDoi('10.1234/example(2024))).;')).toBe('10.1234/example(2024)');
      expect(normalizeDoi('10.1234/example(2024)]]')).toBe('10.1234/example(2024)');
      expect(normalizeDoi('10.1234/example(2024)}}')).toBe('10.1234/example(2024)');
      expect(normalizeDoi(`10.1234/${'a'.repeat(300)}`)).toBeNull();

      const pathologicalDoi = `10.1234/example(2024)${')'.repeat(100_000)}.`;
      const startedAt = performance.now();
      const extracted = extractDoisFromText(`See reference (${pathologicalDoi}) for details.`);
      const elapsedMs = performance.now() - startedAt;

      expect(extracted).toEqual(['10.1234/example(2024)']);
      expect(elapsedMs).toBeLessThan(1000);
    });
  });

  describe('2.4 Integrated Academic PDF Viewer and Phase 2 IPC contracts', () => {
    it('validates PDF viewer state, deep links, annotations, clamping, and RBAC rules', () => {
      expect(clampPdfPage(0, 12)).toBe(1);
      expect(clampPdfPage(99, 12)).toBe(12);
      expect(clampPdfZoom(0.05)).toBe(PDF_MIN_ZOOM);
      expect(clampPdfZoom(9.5)).toBe(PDF_MAX_ZOOM);

      expect(canRoleMutatePdfAnnotations('owner')).toBe(true);
      expect(canRoleMutatePdfAnnotations('editor')).toBe(true);
      expect(canRoleMutatePdfAnnotations('viewer')).toBe(false);

      expect(
        PdfDeepLinkTargetSchema.safeParse({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          pageNumber: 7,
          highlightId: null,
          searchExcerpt: 'evaluation methodology',
        }).success,
      ).toBe(true);

      expect(
        PdfAnnotationSchema.safeParse({
          id: ANNOTATION_ID,
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          pageNumber: 7,
          selectedText: 'Key empirical result',
          note: 'Cite in section 3',
          color: 'yellow',
          rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
          createdBy: USER_ID,
          createdAt: SAMPLE_ISO,
          updatedAt: SAMPLE_ISO,
        }).success,
      ).toBe(true);

      expect(
        PdfViewerStateSchema.safeParse({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          currentPage: 2,
          totalPages: 18,
          zoom: 1.25,
          thumbnailsOpen: true,
          searchQuery: 'federated',
          searchMatches: [{ pageNumber: 2, matchIndex: 0, excerpt: 'federated search' }],
          activeMatchIndex: 0,
          isReadOnly: false,
        }).success,
      ).toBe(true);
    });

    it('builds valid selection popover hook payloads and enforces Phase 2 IPC schemas', () => {
      const selection = {
        projectId: PROJECT_ID,
        fileId: FILE_ID,
        referenceId: REF_ID,
        citeKey: 'smith2024',
        pageNumber: 7,
        selectedText: 'Federated search improves recall by 24%.',
        rects: [{ x: 0.12, y: 0.34, width: 0.6, height: 0.03 }],
      };

      const copyPayload = buildPdfCopyCitationPayload(selection);
      const notePayload = buildPdfCreateNotePayload(selection, 'green');
      const ravenPayload = buildPdfAskRavenPayload(selection);

      expect(PdfSelectionActionPayloadSchema.safeParse(copyPayload).success).toBe(true);
      expect(copyPayload.formattedCitation).toBe('[@smith2024, p. 7]');
      expect(PdfSelectionActionPayloadSchema.safeParse(notePayload).success).toBe(true);
      expect(PdfSelectionActionPayloadSchema.safeParse(ravenPayload).success).toBe(true);
      expect(ravenPayload.attachedFileIds).toEqual([FILE_ID]);
      expect(ravenPayload.attachedReferenceIds).toEqual([REF_ID]);

      expect(
        Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK].input.safeParse({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          pageNumber: 0,
          highlightId: null,
          searchExcerpt: null,
        }).success,
      ).toBe(false);

      expect(
        Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION].input.safeParse(
          copyPayload,
        ).success,
      ).toBe(true);

      expect(PHASE2_IPC_CHANNELS.PDF_DEEP_LINK_OPENED).toBe('pdf:deepLinkOpened');
      expect(PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED).toBe('pdf:deepLinkOpened');
      expect(
        Phase2IpcEventContracts[PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED].payload.safeParse({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          pageNumber: 7,
          highlightId: null,
          searchExcerpt: null,
        }).success,
      ).toBe(true);
      expect(
        Phase2IpcEventContracts[PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED].payload.safeParse({
          projectId: PROJECT_ID,
          fileId: FILE_ID,
          referenceId: REF_ID,
          pageNumber: 0,
          highlightId: null,
          searchExcerpt: null,
        }).success,
      ).toBe(false);

      const subscribeTypeCheck: NonNullable<Phase2SunrisePreloadApi['pdf']['onDeepLinkOpened']> = (
        _listener: PdfDeepLinkOpenedListener,
      ) => {
        return (): void => undefined;
      };
      expect(typeof subscribeTypeCheck).toBe('function');
    });
  });
});
