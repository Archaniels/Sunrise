import { Cite, type CSL, type CSLName } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import {
  canRoleMutateReferences,
  CiteKeySchema,
  DEFAULT_PROVIDER_CLIENT_POLICY,
  err,
  ExportBibliographyInputSchema,
  ExportBibliographyResponseSchema,
  extractDoisFromText,
  ImportBibliographyInputSchema,
  ImportBibliographyResponseSchema,
  IngestDoiInputSchema,
  IngestDoiResponseSchema,
  IngestPdfInputSchema,
  IngestPdfResponseSchema,
  normalizeDoi,
  ok,
  type CreateReferenceInput,
  type DuplicateReferenceConflict,
  type ExportBibliographyInput,
  type ExportBibliographyResponse,
  type ImportBibliographyEntryError,
  type ImportBibliographyInput,
  type ImportBibliographyResponse,
  type IngestDoiInput,
  type IngestDoiResponse,
  type IngestPdfInput,
  type IngestPdfResponse,
  type PdfExtractionMethod,
  type ProjectRole,
  type ProviderPaperCandidate,
  type Reference,
  type ReferenceAuthor,
  type Result,
} from '@sunrise/shared';
import { XMLParser } from 'fast-xml-parser';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseCrossrefWork, parseOpenAlexWork } from './literature-service.js';
import { createInMemoryReferenceService, type ReferenceService } from './reference-service.js';

export interface IngestionActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

export interface ExtractedPdfContent {
  readonly text: string;
  readonly xmpTitle: string | null;
  readonly xmpAuthors: readonly string[];
  readonly xmpDoi: string | null;
}

export interface HydratedDoiMatch {
  readonly provider: 'crossref' | 'openalex';
  readonly candidate: ProviderPaperCandidate;
}

export interface ByokPdfFallbackMetadata {
  readonly title: string | null;
  readonly authors: readonly ReferenceAuthor[];
  readonly year: number | null;
  readonly journal: string | null;
  readonly doi: string | null;
  readonly abstract: string | null;
}

export interface ByokPdfFallbackExtractor {
  readonly extractMetadata: (input: {
    readonly projectId: string;
    readonly text: string;
    readonly fileName: string;
  }) => Promise<ByokPdfFallbackMetadata | null>;
}

export interface IngestionServiceDeps {
  readonly referenceService?: ReferenceService;
  readonly hydrateByDoi: (doi: string) => Promise<HydratedDoiMatch | null>;
  readonly extractPdfContent: (pdfBytes: Uint8Array) => Promise<ExtractedPdfContent>;
  readonly fetchPdfBytes?: (projectId: string, fileId: string) => Promise<Uint8Array | null>;
  readonly byokFallback?: ByokPdfFallbackExtractor;
}

export interface IngestionService {
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

const XMP_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  processEntities: {
    enabled: true,
    maxEntitySize: 1024,
    maxExpansionDepth: 5,
    maxTotalExpansions: 500,
    maxExpandedLength: 50000,
    maxEntityCount: 50,
  },
});

function parseAuthorNameString(rawName: string): ReferenceAuthor | null {
  const cleaned = rawName.trim();
  if (cleaned.length === 0) {
    return null;
  }
  if (cleaned.includes(',')) {
    const [rawFamily, rawGiven] = cleaned.split(',', 2);
    const family = (rawFamily ?? '').trim();
    const given = (rawGiven ?? '').trim();
    if (family.length === 0) {
      return null;
    }
    const displayName = given.length > 0 ? `${given} ${family}` : family;
    return { family, given, displayName, orcid: null };
  }
  const parts = cleaned.split(/\s+/);
  const family = parts[parts.length - 1] ?? cleaned;
  const given = parts.slice(0, -1).join(' ');
  return { family, given, displayName: cleaned, orcid: null };
}

function parseCslAuthor(author: CSLName): ReferenceAuthor | null {
  const family = (author.family ?? '').trim();
  const given = (author.given ?? '').trim();
  if (family.length > 0) {
    const displayName = given.length > 0 ? `${given} ${family}` : family;
    return { family, given, displayName, orcid: null };
  }
  if (author.literal && author.literal.trim().length > 0) {
    return parseAuthorNameString(author.literal);
  }
  return null;
}

function parseCslYear(entry: CSL): number | null {
  const dateParts = entry.issued?.['date-parts'];
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) {
    return null;
  }
  const rawYear = dateParts[0][0];
  const parsed = typeof rawYear === 'number' ? rawYear : Number.parseInt(String(rawYear), 10);
  return Number.isInteger(parsed) && parsed >= 1450 && parsed <= 2100 ? parsed : null;
}

function readCslOptionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return null;
}

function resolveCslCiteKey(entry: CSL): string | undefined {
  const rawKey =
    typeof entry['citation-key'] === 'string'
      ? entry['citation-key'].trim()
      : typeof entry.id === 'string' && !entry.id.startsWith('temp_id_')
        ? entry.id.trim()
        : '';
  if (rawKey.length > 0 && CiteKeySchema.safeParse(rawKey).success) {
    return rawKey;
  }
  return undefined;
}

function sanitizeHttpUrl(rawUrl: string | null): string | null {
  if (rawUrl === null) {
    return null;
  }
  return rawUrl.startsWith('https://') || rawUrl.startsWith('http://') ? rawUrl : null;
}

function mapCslToCreateInput(
  entry: CSL,
  projectId: string,
  format: 'bibtex' | 'ris',
  onDuplicate: 'prompt' | 'merge' | 'update' | 'skip',
): CreateReferenceInput | null {
  const title = readCslOptionalString(entry.title);
  if (title === null) {
    return null;
  }
  const authors = (entry.author ?? [])
    .map(parseCslAuthor)
    .filter((item): item is ReferenceAuthor => item !== null);
  const year = parseCslYear(entry);
  const rawDoi = readCslOptionalString(entry.DOI);
  const doi = rawDoi !== null ? normalizeDoi(rawDoi) : null;
  const citeKey = resolveCslCiteKey(entry);

  return {
    projectId,
    ...(citeKey !== undefined ? { citeKey } : {}),
    title,
    authors,
    year,
    journal: readCslOptionalString(entry['container-title']),
    published: year !== null ? String(year) : null,
    doi,
    url: sanitizeHttpUrl(readCslOptionalString(entry.URL)),
    abstract: readCslOptionalString(entry.abstract),
    volume: readCslOptionalString(entry.volume),
    issue: readCslOptionalString(entry.issue),
    pages: readCslOptionalString(entry.page),
    citationCount: null,
    pdfUrl: null,
    localPdfFileId: null,
    tags: [],
    notes: '',
    sourceProvider: format,
    onDuplicate,
  };
}

function mapReferenceToCsl(ref: Reference): CSL {
  const authors: CSLName[] = ref.authors.map((author) => ({
    family: author.family,
    ...(author.given.length > 0 ? { given: author.given } : {}),
  }));
  return {
    id: ref.citeKey,
    'citation-key': ref.citeKey,
    type: 'article-journal',
    title: ref.title,
    ...(authors.length > 0 ? { author: authors } : {}),
    ...(ref.year !== null ? { issued: { 'date-parts': [[ref.year]] } } : {}),
    ...(ref.journal !== null ? { 'container-title': ref.journal } : {}),
    ...(ref.volume !== null ? { volume: ref.volume } : {}),
    ...(ref.issue !== null ? { issue: ref.issue } : {}),
    ...(ref.pages !== null ? { page: ref.pages } : {}),
    ...(ref.doi !== null ? { DOI: ref.doi } : {}),
    ...(ref.url !== null ? { URL: ref.url } : {}),
    ...(ref.abstract !== null ? { abstract: ref.abstract } : {}),
  };
}

function isCslObject(value: unknown): value is CSL {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBibliographyEntries(content: string): Result<CSL[]> {
  try {
    const cite = new Cite(content);
    const rawData: unknown = cite.data;
    const data = Array.isArray(rawData) ? rawData.filter(isCslObject) : [];
    return ok(data);
  } catch (error: unknown) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim().slice(0, 480)
        : 'Unable to parse bibliography content';
    return err({ code: 'VALIDATION_ERROR', message });
  }
}

function formatBibliographyEntries(cslEntries: CSL[], format: 'bibtex' | 'ris'): Result<string> {
  try {
    const cite = new Cite(cslEntries);
    return ok(String(cite.format(format)));
  } catch {
    return err({
      code: 'VALIDATION_ERROR',
      message: `Unable to serialize bibliography entries as ${format}`,
    });
  }
}

function extractHeuristicYear(text: string): number | null {
  const match = /\b(19\d{2}|20\d{2})\b/.exec(text);
  if (!match || !match[1]) {
    return null;
  }
  const year = Number.parseInt(match[1], 10);
  return year >= 1450 && year <= 2100 ? year : null;
}

function extractHeuristicTitle(extracted: ExtractedPdfContent, fileName: string): string {
  if (extracted.xmpTitle && extracted.xmpTitle.trim().length > 0) {
    return extracted.xmpTitle.trim().slice(0, 1000);
  }
  const firstLine = extracted.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 4);
  if (firstLine) {
    return firstLine.slice(0, 1000);
  }
  return fileName.replace(/\.pdf$/i, '').trim() || fileName;
}

function buildReferenceInputFromCandidate(
  candidate: ProviderPaperCandidate,
  projectId: string,
  canonicalDoi: string,
  tags: readonly string[],
  onDuplicate: 'prompt' | 'merge' | 'update' | 'skip',
  sourceProvider: 'doi' | 'pdf',
  localPdfFileId: string | null,
): CreateReferenceInput {
  return {
    projectId,
    title: candidate.title,
    authors: candidate.authors,
    year: candidate.year,
    journal: candidate.journal,
    published: candidate.published,
    doi: canonicalDoi,
    url: candidate.url,
    abstract: candidate.abstract,
    volume: candidate.volume,
    issue: candidate.issue,
    pages: candidate.pages,
    citationCount: candidate.citationCount,
    pdfUrl: candidate.pdfUrl,
    localPdfFileId,
    tags: [...tags],
    notes: '',
    sourceProvider,
    onDuplicate,
  };
}

function extractCandidateDoisFromPdf(extracted: ExtractedPdfContent): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const xmpDoi = extracted.xmpDoi !== null ? normalizeDoi(extracted.xmpDoi) : null;
  if (xmpDoi !== null) {
    seen.add(xmpDoi);
    ordered.push(xmpDoi);
  }
  for (const doi of extractDoisFromText(extracted.text)) {
    if (!seen.has(doi)) {
      seen.add(doi);
      ordered.push(doi);
    }
  }
  return ordered;
}

function buildHeuristicPdfMetadata(
  extracted: ExtractedPdfContent,
  fileName: string,
): {
  readonly title: string;
  readonly authors: ReferenceAuthor[];
  readonly year: number | null;
  readonly journal: string | null;
  readonly abstract: string | null;
} {
  const title = extractHeuristicTitle(extracted, fileName);
  const authors = extracted.xmpAuthors
    .map(parseAuthorNameString)
    .filter((item): item is ReferenceAuthor => item !== null);
  const year = extractHeuristicYear(extracted.text);
  return { title, authors, year, journal: null, abstract: null };
}

async function resolvePdfBytes(
  deps: IngestionServiceDeps,
  parsed: ReturnType<typeof IngestPdfInputSchema.parse>,
): Promise<Result<Uint8Array>> {
  if (parsed.pdfBase64 !== undefined) {
    return ok(Uint8Array.from(Buffer.from(parsed.pdfBase64, 'base64')));
  }
  if (deps.fetchPdfBytes !== undefined) {
    const fetched = await deps.fetchPdfBytes(parsed.projectId, parsed.localPdfFileId);
    if (fetched !== null) {
      return ok(fetched);
    }
    return err({ code: 'NOT_FOUND', message: 'PDF bytes could not be loaded for localPdfFileId' });
  }
  return err({
    code: 'VALIDATION_ERROR',
    message: 'PDF content bytes are required for metadata extraction',
  });
}

interface ResolvedHeuristicPdfDraft {
  readonly title: string;
  readonly authors: ReferenceAuthor[];
  readonly year: number | null;
  readonly journal: string | null;
  readonly abstract: string | null;
  readonly finalDoi: string | null;
  readonly extractionMethod: PdfExtractionMethod;
  readonly byokFallbackUsed: boolean;
  readonly needsLlmFallback: boolean;
}

function mergeByokFallback(
  base: ResolvedHeuristicPdfDraft,
  llmResult: ByokPdfFallbackMetadata,
): ResolvedHeuristicPdfDraft {
  return {
    title: llmResult.title ?? base.title,
    authors: llmResult.authors.length > 0 ? [...llmResult.authors] : base.authors,
    year: llmResult.year ?? base.year,
    journal: llmResult.journal ?? base.journal,
    abstract: llmResult.abstract ?? base.abstract,
    finalDoi: llmResult.doi !== null ? normalizeDoi(llmResult.doi) : base.finalDoi,
    extractionMethod: 'byok_llm_fallback',
    byokFallbackUsed: true,
    needsLlmFallback: false,
  };
}

async function safeHydrateByDoi(
  hydrateByDoi: IngestionServiceDeps['hydrateByDoi'],
  doi: string,
): Promise<Result<HydratedDoiMatch | null>> {
  try {
    return ok(await hydrateByDoi(doi));
  } catch {
    return err({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: `Failed to hydrate metadata for DOI ${doi}`,
    });
  }
}

async function safeExtractPdfContent(
  extractPdfContent: IngestionServiceDeps['extractPdfContent'],
  pdfBytes: Uint8Array,
): Promise<Result<ExtractedPdfContent>> {
  try {
    return ok(await extractPdfContent(pdfBytes));
  } catch {
    return err({
      code: 'VALIDATION_ERROR',
      message: 'Unable to extract metadata from invalid, corrupted, or encrypted PDF',
    });
  }
}

async function resolveHeuristicDraft(
  deps: IngestionServiceDeps,
  parsed: ReturnType<typeof IngestPdfInputSchema.parse>,
  extracted: ExtractedPdfContent,
  detectedDoi: string | null,
): Promise<Result<ResolvedHeuristicPdfDraft>> {
  const heuristic = buildHeuristicPdfMetadata(extracted, parsed.fileName);
  const base: ResolvedHeuristicPdfDraft = {
    ...heuristic,
    finalDoi: detectedDoi,
    extractionMethod: 'xmp_and_text_heuristic',
    byokFallbackUsed: false,
    needsLlmFallback: true,
  };
  if (!parsed.allowByokFallback || deps.byokFallback === undefined) {
    return ok(base);
  }
  try {
    const llmResult = await deps.byokFallback.extractMetadata({
      projectId: parsed.projectId,
      text: extracted.text,
      fileName: parsed.fileName,
    });
    return ok(llmResult !== null ? mergeByokFallback(base, llmResult) : base);
  } catch {
    return err({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'BYOK metadata extraction adapter failed',
    });
  }
}

function toIngestPdfResponse(
  outcome: ReturnType<typeof IngestPdfResponseSchema.parse>['status'],
  extractionMethod: PdfExtractionMethod,
  detectedDoi: string | null,
  hydratedFrom: 'crossref' | 'openalex' | 'none',
  byokFallbackUsed: boolean,
  needsLlmFallback: boolean,
  reference: Reference | null,
  conflict: DuplicateReferenceConflict | null,
): IngestPdfResponse {
  return IngestPdfResponseSchema.parse({
    status: outcome,
    extractionMethod,
    detectedDoi,
    hydratedFrom,
    byokFallbackUsed,
    needsLlmFallback,
    reference,
    conflict,
  });
}

async function ingestPdfWithHeuristics(
  actor: IngestionActor,
  deps: IngestionServiceDeps,
  referenceService: ReferenceService,
  parsed: ReturnType<typeof IngestPdfInputSchema.parse>,
  extracted: ExtractedPdfContent,
  detectedDoi: string | null,
): Promise<Result<IngestPdfResponse>> {
  const draftResult = await resolveHeuristicDraft(deps, parsed, extracted, detectedDoi);
  if (!draftResult.ok) {
    return draftResult;
  }
  const draft = draftResult.value;
  const created = await referenceService.createReference(actor, {
    projectId: parsed.projectId,
    title: draft.title,
    authors: draft.authors,
    year: draft.year,
    journal: draft.journal,
    published: draft.year !== null ? String(draft.year) : null,
    doi: draft.finalDoi,
    url: null,
    abstract: draft.abstract,
    volume: null,
    issue: null,
    pages: null,
    citationCount: null,
    pdfUrl: null,
    localPdfFileId: parsed.localPdfFileId,
    tags: parsed.tags,
    notes: '',
    sourceProvider: 'pdf',
    onDuplicate: parsed.onDuplicate,
  });
  if (!created.ok) {
    return created;
  }
  const reference = created.value.status === 'conflict' ? null : created.value.reference;
  const conflict = created.value.status === 'conflict' ? created.value.conflict : null;
  return ok(
    toIngestPdfResponse(
      created.value.status,
      draft.extractionMethod,
      draft.finalDoi,
      'none',
      draft.byokFallbackUsed,
      draft.needsLlmFallback,
      reference,
      conflict,
    ),
  );
}

async function tryIngestPdfFromDoi(
  actor: IngestionActor,
  deps: IngestionServiceDeps,
  referenceService: ReferenceService,
  parsed: ReturnType<typeof IngestPdfInputSchema.parse>,
  detectedDoi: string | null,
): Promise<Result<IngestPdfResponse> | null> {
  if (detectedDoi === null) {
    return null;
  }
  const hydratedResult = await safeHydrateByDoi(deps.hydrateByDoi, detectedDoi);
  if (!hydratedResult.ok) {
    return hydratedResult;
  }
  const hydrated = hydratedResult.value;
  if (hydrated === null) {
    return null;
  }
  const outcome = await referenceService.createReference(
    actor,
    buildReferenceInputFromCandidate(
      hydrated.candidate,
      parsed.projectId,
      detectedDoi,
      parsed.tags,
      parsed.onDuplicate,
      'pdf',
      parsed.localPdfFileId,
    ),
  );
  if (!outcome.ok) {
    return outcome;
  }
  const reference = outcome.value.status === 'conflict' ? null : outcome.value.reference;
  const conflict = outcome.value.status === 'conflict' ? outcome.value.conflict : null;
  return ok(
    toIngestPdfResponse(
      outcome.value.status,
      'doi_hydrated',
      detectedDoi,
      hydrated.provider,
      false,
      false,
      reference,
      conflict,
    ),
  );
}

interface BibliographyImportBuckets {
  readonly imported: Reference[];
  readonly merged: Reference[];
  readonly conflicts: DuplicateReferenceConflict[];
  readonly errors: ImportBibliographyEntryError[];
}

async function processSingleBibliographyEntry(
  actor: IngestionActor,
  referenceService: ReferenceService,
  entry: CSL,
  index: number,
  parsed: ReturnType<typeof ImportBibliographyInputSchema.parse>,
  buckets: BibliographyImportBuckets,
): Promise<void> {
  const mapped = mapCslToCreateInput(entry, parsed.projectId, parsed.format, parsed.onDuplicate);
  if (mapped === null) {
    buckets.errors.push({
      entryIndex: index,
      rawCiteKey: readCslOptionalString(entry['citation-key']),
      message: 'Bibliography entry is missing a valid title',
    });
    return;
  }
  const created = await referenceService.createReference(actor, mapped);
  if (!created.ok) {
    buckets.errors.push({
      entryIndex: index,
      rawCiteKey: mapped.citeKey ?? null,
      message: created.error.message,
    });
    return;
  }
  if (created.value.status === 'created') {
    buckets.imported.push(created.value.reference);
  } else if (created.value.status === 'merged' || created.value.status === 'updated') {
    buckets.merged.push(created.value.reference);
  } else if (created.value.status === 'conflict') {
    buckets.conflicts.push(created.value.conflict);
  }
}

function toIngestDoiResponse(
  outcome:
    | { readonly status: 'conflict'; readonly conflict: DuplicateReferenceConflict }
    | {
        readonly status: 'created' | 'merged' | 'updated' | 'skipped';
        readonly reference: Reference;
      },
  canonicalDoi: string,
  hydratedFrom: 'crossref' | 'openalex',
): IngestDoiResponse {
  return IngestDoiResponseSchema.parse({
    status: outcome.status,
    canonicalDoi,
    hydratedFrom,
    reference: outcome.status === 'conflict' ? null : outcome.reference,
    conflict: outcome.status === 'conflict' ? outcome.conflict : null,
  });
}

export function createIngestionService(deps: IngestionServiceDeps): IngestionService {
  const referenceService = deps.referenceService ?? createInMemoryReferenceService();

  return {
    ingestDoi: async (actor, input): Promise<Result<IngestDoiResponse>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to ingest DOI references' });
      }
      const parsed = IngestDoiInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid DOI ingestion payload',
        });
      }
      const canonicalDoi = normalizeDoi(parsed.data.doi);
      if (canonicalDoi === null) {
        return err({ code: 'VALIDATION_ERROR', message: 'Malformed DOI identifier' });
      }
      const hydratedResult = await safeHydrateByDoi(deps.hydrateByDoi, canonicalDoi);
      if (!hydratedResult.ok) {
        return hydratedResult;
      }
      const hydrated = hydratedResult.value;
      if (hydrated === null) {
        return err({
          code: 'NOT_FOUND',
          message: `No scholarly metadata found for DOI ${canonicalDoi}`,
        });
      }
      const outcome = await referenceService.createReference(
        actor,
        buildReferenceInputFromCandidate(
          hydrated.candidate,
          parsed.data.projectId,
          canonicalDoi,
          parsed.data.tags,
          parsed.data.onDuplicate,
          'doi',
          null,
        ),
      );
      if (!outcome.ok) {
        return outcome;
      }
      return ok(toIngestDoiResponse(outcome.value, canonicalDoi, hydrated.provider));
    },

    importBibliography: async (actor, input): Promise<Result<ImportBibliographyResponse>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to import bibliography' });
      }
      const parsed = ImportBibliographyInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid bibliography import payload',
        });
      }
      const entriesResult = parseBibliographyEntries(parsed.data.content);
      if (!entriesResult.ok) {
        return entriesResult;
      }
      const buckets: BibliographyImportBuckets = {
        imported: [],
        merged: [],
        conflicts: [],
        errors: [],
      };
      for (let index = 0; index < entriesResult.value.length; index += 1) {
        const entry = entriesResult.value[index];
        if (entry) {
          await processSingleBibliographyEntry(
            actor,
            referenceService,
            entry,
            index,
            parsed.data,
            buckets,
          );
        }
      }
      return ok(
        ImportBibliographyResponseSchema.parse({
          format: parsed.data.format,
          ...buckets,
        }),
      );
    },

    exportBibliography: async (actor, input): Promise<Result<ExportBibliographyResponse>> => {
      const parsed = ExportBibliographyInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid bibliography export payload',
        });
      }
      const listed = await referenceService.listReferences(actor, {
        projectId: parsed.data.projectId,
      });
      if (!listed.ok) {
        return listed;
      }
      const selected =
        parsed.data.referenceIds !== undefined
          ? listed.value.filter((ref) => parsed.data.referenceIds?.includes(ref.id) === true)
          : listed.value;

      const extension = parsed.data.format === 'bibtex' ? 'bib' : 'ris';
      const suggestedFileName = `bibliography-${parsed.data.projectId.slice(0, 8)}.${extension}`;
      if (selected.length === 0) {
        return ok(
          ExportBibliographyResponseSchema.parse({
            format: parsed.data.format,
            content: '',
            entryCount: 0,
            suggestedFileName,
          }),
        );
      }

      const cslEntries = selected.map(mapReferenceToCsl);
      const formatted = formatBibliographyEntries(cslEntries, parsed.data.format);
      if (!formatted.ok) {
        return formatted;
      }
      return ok(
        ExportBibliographyResponseSchema.parse({
          format: parsed.data.format,
          content: formatted.value,
          entryCount: selected.length,
          suggestedFileName,
        }),
      );
    },

    ingestPdf: async (actor, input): Promise<Result<IngestPdfResponse>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to ingest PDF references' });
      }
      const parsed = IngestPdfInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF ingestion payload',
        });
      }
      const bytesResult = await resolvePdfBytes(deps, parsed.data);
      if (!bytesResult.ok) {
        return bytesResult;
      }
      const extractedResult = await safeExtractPdfContent(
        deps.extractPdfContent,
        bytesResult.value,
      );
      if (!extractedResult.ok) {
        return extractedResult;
      }
      const extracted = extractedResult.value;
      const detectedDoi = extractCandidateDoisFromPdf(extracted)[0] ?? null;
      const hydratedOutcome = await tryIngestPdfFromDoi(
        actor,
        deps,
        referenceService,
        parsed.data,
        detectedDoi,
      );
      if (hydratedOutcome !== null) {
        return hydratedOutcome;
      }
      return ingestPdfWithHeuristics(
        actor,
        deps,
        referenceService,
        parsed.data,
        extracted,
        detectedDoi,
      );
    },
  };
}

const XMP_CONTAINER_KEYS = ['#text', 'li', 'Alt', 'Seq', 'Bag'] as const;

function collectTextFromXmpNode(node: unknown): string[] {
  if (typeof node === 'string' && node.trim().length > 0) {
    return [node.trim()];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectTextFromXmpNode);
  }
  if (typeof node !== 'object' || node === null) {
    return [];
  }
  const rec = node as Readonly<Record<string, unknown>>;
  for (const key of XMP_CONTAINER_KEYS) {
    if (key in rec) {
      return collectTextFromXmpNode(rec[key]);
    }
  }
  return [];
}

function asObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function extractXmpDescriptionList(
  parsed: unknown,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const root = asObjectRecord(parsed);
  const xmpmeta = asObjectRecord(root?.['xmpmeta']);
  const rdf = asObjectRecord(xmpmeta?.['RDF'] ?? root?.['RDF']);
  const rawDesc = rdf?.['Description'];
  const items = Array.isArray(rawDesc) ? rawDesc : rawDesc ? [rawDesc] : [];
  return items
    .map(asObjectRecord)
    .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null);
}

function resolveNormalizedXmpDoi(desc: Readonly<Record<string, unknown>>): string | null {
  const candidateDoi = collectTextFromXmpNode(desc['doi'] ?? desc['identifier'])[0];
  return candidateDoi ? normalizeDoi(candidateDoi) : null;
}

export function parseXmpPacketMetadata(rawXmpXml: string): {
  readonly xmpTitle: string | null;
  readonly xmpAuthors: readonly string[];
  readonly xmpDoi: string | null;
} {
  try {
    const parsed: unknown = XMP_PARSER.parse(rawXmpXml);
    const descriptions = extractXmpDescriptionList(parsed);
    let xmpTitle: string | null = null;
    const xmpAuthors: string[] = [];
    let xmpDoi: string | null = extractDoisFromText(JSON.stringify(parsed))[0] ?? null;

    for (const desc of descriptions) {
      xmpTitle = xmpTitle ?? collectTextFromXmpNode(desc['title'])[0] ?? null;
      xmpAuthors.push(...collectTextFromXmpNode(desc['creator']));
      const explicitDoi = resolveNormalizedXmpDoi(desc);
      if (explicitDoi !== null) {
        xmpDoi = explicitDoi;
      }
    }
    return { xmpTitle, xmpAuthors, xmpDoi };
  } catch {
    return { xmpTitle: null, xmpAuthors: [], xmpDoi: null };
  }
}

function readTrimmedStringField(
  record: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function extractPdfContentWithPdfJs(
  pdfBytes: Uint8Array,
): Promise<ExtractedPdfContent> {
  const loadingTask = getDocument({
    data: pdfBytes,
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const doc = await loadingTask.promise;
    const pageLimit = Math.min(doc.numPages, 5);
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const strings = textContent.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter((part) => part.length > 0);
      pageTexts.push(strings.join(' '));
    }

    const metadata = await doc.getMetadata();
    const rawXmp = metadata.metadata?.getRaw();
    const xmp = rawXmp
      ? parseXmpPacketMetadata(rawXmp)
      : { xmpTitle: null, xmpAuthors: [], xmpDoi: null };
    const info = asObjectRecord(metadata.info);
    const infoTitle = readTrimmedStringField(info, 'Title');
    const infoAuthor = readTrimmedStringField(info, 'Author');

    return {
      text: pageTexts.join('\n'),
      xmpTitle: xmp.xmpTitle ?? infoTitle,
      xmpAuthors: xmp.xmpAuthors.length > 0 ? xmp.xmpAuthors : infoAuthor ? [infoAuthor] : [],
      xmpDoi: xmp.xmpDoi,
    };
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function fetchCrossrefDoiCandidate(
  doi: string,
  contactEmail: string,
  headers: Readonly<Record<string, string>>,
  fetchFn: typeof fetch,
): Promise<HydratedDoiMatch | null> {
  const crossrefUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(contactEmail)}`;
  try {
    const response = await fetchFn(crossrefUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? Reflect.get(body, 'message')
        : null;
    const candidate = parseCrossrefWork(message);
    return candidate !== null ? { provider: 'crossref', candidate } : null;
  } catch {
    return null;
  }
}

async function fetchOpenAlexDoiCandidate(
  doi: string,
  contactEmail: string,
  headers: Readonly<Record<string, string>>,
  fetchFn: typeof fetch,
): Promise<HydratedDoiMatch | null> {
  const openAlexUrl = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(contactEmail)}`;
  try {
    const response = await fetchFn(openAlexUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    const candidate = parseOpenAlexWork(body);
    return candidate !== null ? { provider: 'openalex', candidate } : null;
  } catch {
    return null;
  }
}

export function createDefaultDoiHydrator(
  contactEmail: string = DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail,
  fetchFn: typeof fetch = fetch,
): (doi: string) => Promise<HydratedDoiMatch | null> {
  const headers = {
    'User-Agent': `SunriseResearchWorkspace/0.1.0 (mailto:${contactEmail})`,
    Accept: 'application/json',
  };

  return async (doi: string): Promise<HydratedDoiMatch | null> => {
    const crossrefMatch = await fetchCrossrefDoiCandidate(doi, contactEmail, headers, fetchFn);
    if (crossrefMatch !== null) {
      return crossrefMatch;
    }
    return fetchOpenAlexDoiCandidate(doi, contactEmail, headers, fetchFn);
  };
}
