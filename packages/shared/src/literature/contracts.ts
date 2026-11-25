import { z } from 'zod';
import {
  CanonicalDoiSchema,
  HttpUrlSchema,
  normalizeAuthorFamily,
  normalizeDoi,
  normalizeTitleForMatching,
  ReferenceAuthorSchema,
  type ReferenceAuthor,
} from '../references/contracts.js';

export const LITERATURE_PROVIDERS = ['openalex', 'crossref', 'pubmed'] as const;

export const LiteratureProviderSchema = z.enum(LITERATURE_PROVIDERS);

export type LiteratureProvider = z.infer<typeof LiteratureProviderSchema>;

export const LITERATURE_CARD_ACTIONS = ['open', 'save', 'pdf', 'add_to_project'] as const;

export const LiteratureCardActionSchema = z.enum(LITERATURE_CARD_ACTIONS);

export type LiteratureCardAction = z.infer<typeof LiteratureCardActionSchema>;

export const PROVIDER_WARNING_CODES = [
  'TIMEOUT',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'NETWORK_ERROR',
  'INVALID_RESPONSE',
] as const;

export const ProviderWarningCodeSchema = z.enum(PROVIDER_WARNING_CODES);

export type ProviderWarningCode = z.infer<typeof ProviderWarningCodeSchema>;

export const ProviderClientPolicySchema = z.object({
  timeoutMs: z.number().int().min(500).max(30000),
  maxRetries: z.number().int().min(0).max(5),
  baseBackoffMs: z.number().int().min(50).max(5000),
  cacheTtlMs: z.number().int().min(1000).max(86400000),
  contactEmail: z.string().trim().email().max(254),
});

export type ProviderClientPolicy = z.infer<typeof ProviderClientPolicySchema>;

export const DEFAULT_PROVIDER_CLIENT_POLICY: ProviderClientPolicy = {
  timeoutMs: 8000,
  maxRetries: 2,
  baseBackoffMs: 250,
  cacheTtlMs: 300000,
  contactEmail: 'polite-pool@sunrise.research',
};

export const LiteratureSearchFiltersSchema = z
  .object({
    yearFrom: z.number().int().min(1450).max(2100).optional(),
    yearTo: z.number().int().min(1450).max(2100).optional(),
    author: z.string().trim().min(1).max(200).optional(),
    journal: z.string().trim().min(1).max(200).optional(),
    minCitationCount: z.number().int().min(0).max(10000000).optional(),
    fieldOrTopic: z.string().trim().min(1).max(200).optional(),
    openAccessOnly: z.boolean().optional(),
    pdfAvailableOnly: z.boolean().optional(),
  })
  .refine(
    (filters) =>
      filters.yearFrom === undefined ||
      filters.yearTo === undefined ||
      filters.yearFrom <= filters.yearTo,
    'yearFrom must be less than or equal to yearTo',
  );

export type LiteratureSearchFilters = z.infer<typeof LiteratureSearchFiltersSchema>;

export const LiteratureSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(500),
  providers: z.array(LiteratureProviderSchema).min(1).max(3).optional(),
  filters: LiteratureSearchFiltersSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(1000).default(0),
});

export type LiteratureSearchQuery = z.input<typeof LiteratureSearchQuerySchema>;

export const ProviderPaperCandidateSchema = z.object({
  provider: LiteratureProviderSchema,
  externalId: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(1000),
  authors: z.array(ReferenceAuthorSchema).max(200),
  year: z.number().int().min(1450).max(2100).nullable(),
  journal: z.string().trim().max(500).nullable(),
  published: z.string().trim().max(200).nullable(),
  doi: z.string().trim().max(256).nullable(),
  url: HttpUrlSchema.nullable(),
  abstract: z.string().max(20000).nullable(),
  volume: z.string().trim().max(64).nullable(),
  issue: z.string().trim().max(64).nullable(),
  pages: z.string().trim().max(64).nullable(),
  citationCount: z.number().int().min(0).nullable(),
  pdfUrl: HttpUrlSchema.nullable(),
  isOpenAccess: z.boolean(),
  topics: z.array(z.string().trim().min(1).max(120)).max(30),
});

export type ProviderPaperCandidate = z.infer<typeof ProviderPaperCandidateSchema>;

export const FederatedPaperResultSchema = z.object({
  dedupeKey: z.string().min(1).max(512),
  matchedBy: z.enum(['doi', 'title_author_year', 'single_source']),
  providers: z.array(LiteratureProviderSchema).min(1).max(3),
  primaryProvider: LiteratureProviderSchema,
  externalIds: z.record(z.string(), z.string().min(1).max(256)),
  title: z.string().trim().min(1).max(1000),
  authors: z.array(ReferenceAuthorSchema).max(200),
  year: z.number().int().min(1450).max(2100).nullable(),
  journal: z.string().trim().max(500).nullable(),
  published: z.string().trim().max(200).nullable(),
  doi: CanonicalDoiSchema.nullable(),
  url: HttpUrlSchema.nullable(),
  abstract: z.string().max(20000).nullable(),
  volume: z.string().trim().max(64).nullable(),
  issue: z.string().trim().max(64).nullable(),
  pages: z.string().trim().max(64).nullable(),
  citationCount: z.number().int().min(0).nullable(),
  pdfUrl: HttpUrlSchema.nullable(),
  isOpenAccess: z.boolean(),
  topics: z.array(z.string().trim().min(1).max(120)).max(30),
  availableActions: z.array(LiteratureCardActionSchema).min(1).max(4),
});

export type FederatedPaperResult = z.infer<typeof FederatedPaperResultSchema>;

export const ProviderWarningSchema = z.object({
  provider: LiteratureProviderSchema,
  code: ProviderWarningCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});

export type ProviderWarning = z.infer<typeof ProviderWarningSchema>;

export const ProviderExecutionSummarySchema = z.object({
  provider: LiteratureProviderSchema,
  status: z.enum(['ok', 'degraded', 'failed']),
  resultCount: z.number().int().min(0),
  cached: z.boolean(),
  latencyMs: z.number().int().min(0),
});

export type ProviderExecutionSummary = z.infer<typeof ProviderExecutionSummarySchema>;

export const FederatedSearchResponseSchema = z.object({
  query: z.string().trim().min(1).max(500),
  totalResults: z.number().int().min(0),
  cached: z.boolean(),
  results: z.array(FederatedPaperResultSchema),
  warnings: z.array(ProviderWarningSchema),
  providerSummaries: z.array(ProviderExecutionSummarySchema).min(1).max(3),
});

export type FederatedSearchResponse = z.infer<typeof FederatedSearchResponseSchema>;

export const TITLE_SIMILARITY_THRESHOLD = 0.85;

function tokenizeNormalizedTitle(title: string): Set<string> {
  const normalized = normalizeTitleForMatching(title);
  if (normalized.length === 0) {
    return new Set<string>();
  }
  return new Set(normalized.split(' ').filter((token) => token.length > 0));
}

export function computeTitleSimilarity(titleA: string, titleB: string): number {
  const tokensA = tokenizeNormalizedTitle(titleA);
  const tokensB = tokenizeNormalizedTitle(titleB);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let intersectionCount = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionCount += 1;
    }
  }
  const unionSize = tokensA.size + tokensB.size - intersectionCount;
  return unionSize === 0 ? 0 : intersectionCount / unionSize;
}

function pickRicherString(current: string | null, incoming: string | null): string | null {
  if (!incoming || incoming.trim().length === 0) {
    return current;
  }
  if (!current || current.trim().length === 0) {
    return incoming;
  }
  return incoming.trim().length > current.trim().length ? incoming : current;
}

function pickHigherNumber(current: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return current;
  }
  if (current === null) {
    return incoming;
  }
  return incoming > current ? incoming : current;
}

function pickRicherAuthors(
  current: readonly ReferenceAuthor[],
  incoming: readonly ReferenceAuthor[],
): ReferenceAuthor[] {
  return incoming.length > current.length ? [...incoming] : [...current];
}

function mergeUniqueStrings(current: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...current, ...incoming]) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function computeAvailableActions(
  url: string | null,
  pdfUrl: string | null,
): LiteratureCardAction[] {
  const actions: LiteratureCardAction[] = [];
  if (url !== null) {
    actions.push('open');
  }
  actions.push('save');
  if (pdfUrl !== null) {
    actions.push('pdf');
  }
  actions.push('add_to_project');
  return actions;
}

function createInitialFederatedResult(candidate: ProviderPaperCandidate): FederatedPaperResult {
  const canonicalDoi = candidate.doi !== null ? normalizeDoi(candidate.doi) : null;
  const firstAuthor = normalizeAuthorFamily(candidate.authors[0]) || 'unknown';
  const yearToken = candidate.year !== null ? String(candidate.year) : 'nd';
  const dedupeKey =
    canonicalDoi !== null
      ? `doi:${canonicalDoi}`
      : `tay:${firstAuthor}:${yearToken}:${normalizeTitleForMatching(candidate.title).slice(0, 120)}`;
  return {
    dedupeKey,
    matchedBy: 'single_source',
    providers: [candidate.provider],
    primaryProvider: candidate.provider,
    externalIds: { [candidate.provider]: candidate.externalId },
    title: candidate.title,
    authors: [...candidate.authors],
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
    isOpenAccess: candidate.isOpenAccess,
    topics: [...candidate.topics],
    availableActions: computeAvailableActions(candidate.url, candidate.pdfUrl),
  };
}

function resolveMergedDoi(existingDoi: string | null, incomingDoi: string | null): string | null {
  if (existingDoi !== null) {
    return existingDoi;
  }
  return incomingDoi !== null ? normalizeDoi(incomingDoi) : null;
}

function mergeProviderList(
  existingProviders: readonly LiteratureProvider[],
  incomingProvider: LiteratureProvider,
): LiteratureProvider[] {
  return existingProviders.includes(incomingProvider)
    ? [...existingProviders]
    : [...existingProviders, incomingProvider];
}

function mergePublicationDetails(
  existing: FederatedPaperResult,
  incoming: ProviderPaperCandidate,
): Pick<
  FederatedPaperResult,
  'year' | 'volume' | 'issue' | 'pages' | 'url' | 'pdfUrl' | 'isOpenAccess'
> {
  return {
    year: existing.year ?? incoming.year,
    volume: existing.volume ?? incoming.volume,
    issue: existing.issue ?? incoming.issue,
    pages: existing.pages ?? incoming.pages,
    url: existing.url ?? incoming.url,
    pdfUrl: existing.pdfUrl ?? incoming.pdfUrl,
    isOpenAccess: existing.isOpenAccess || incoming.isOpenAccess,
  };
}

function mergeIntoFederatedResult(
  existing: FederatedPaperResult,
  incoming: ProviderPaperCandidate,
  matchReason: 'doi' | 'title_author_year',
): FederatedPaperResult {
  const canonicalDoi = resolveMergedDoi(existing.doi, incoming.doi);
  const details = mergePublicationDetails(existing, incoming);
  return {
    ...details,
    dedupeKey: canonicalDoi !== null ? `doi:${canonicalDoi}` : existing.dedupeKey,
    matchedBy: existing.matchedBy === 'doi' ? 'doi' : matchReason,
    providers: mergeProviderList(existing.providers, incoming.provider),
    primaryProvider: existing.primaryProvider,
    externalIds: { ...existing.externalIds, [incoming.provider]: incoming.externalId },
    title: pickRicherString(existing.title, incoming.title) ?? existing.title,
    authors: pickRicherAuthors(existing.authors, incoming.authors),
    journal: pickRicherString(existing.journal, incoming.journal),
    published: pickRicherString(existing.published, incoming.published),
    doi: canonicalDoi,
    abstract: pickRicherString(existing.abstract, incoming.abstract),
    citationCount: pickHigherNumber(existing.citationCount, incoming.citationCount),
    topics: mergeUniqueStrings(existing.topics, incoming.topics).slice(0, 30),
    availableActions: computeAvailableActions(details.url, details.pdfUrl),
  };
}

function isTitleAuthorYearMatch(
  existing: FederatedPaperResult,
  incoming: ProviderPaperCandidate,
): boolean {
  if (existing.year === null || incoming.year === null || existing.year !== incoming.year) {
    return false;
  }
  const existingAuthor = normalizeAuthorFamily(existing.authors[0]);
  const incomingAuthor = normalizeAuthorFamily(incoming.authors[0]);
  if (existingAuthor.length === 0 || existingAuthor !== incomingAuthor) {
    return false;
  }
  return computeTitleSimilarity(existing.title, incoming.title) >= TITLE_SIMILARITY_THRESHOLD;
}

function findMatchingGroupIndex(
  groups: readonly FederatedPaperResult[],
  candidate: ProviderPaperCandidate,
): { readonly index: number; readonly reason: 'doi' | 'title_author_year' } | null {
  const incomingDoi = candidate.doi !== null ? normalizeDoi(candidate.doi) : null;
  if (incomingDoi !== null) {
    const doiIndex = groups.findIndex((group) => group.doi === incomingDoi);
    if (doiIndex !== -1) {
      return { index: doiIndex, reason: 'doi' };
    }
  }
  const fuzzyIndex = groups.findIndex((group) => isTitleAuthorYearMatch(group, candidate));
  if (fuzzyIndex !== -1) {
    return { index: fuzzyIndex, reason: 'title_author_year' };
  }
  return null;
}

export function deduplicatePaperCandidates(
  candidates: readonly ProviderPaperCandidate[],
): FederatedPaperResult[] {
  const groups: FederatedPaperResult[] = [];
  for (const candidate of candidates) {
    const match = findMatchingGroupIndex(groups, candidate);
    if (match === null) {
      groups.push(createInitialFederatedResult(candidate));
      continue;
    }
    const existing = groups[match.index];
    if (existing !== undefined) {
      groups[match.index] = mergeIntoFederatedResult(existing, candidate, match.reason);
    }
  }
  return groups;
}

function matchesYearBounds(
  year: number | null,
  yearFrom: number | undefined,
  yearTo: number | undefined,
): boolean {
  if (yearFrom !== undefined && (year === null || year < yearFrom)) {
    return false;
  }
  if (yearTo !== undefined && (year === null || year > yearTo)) {
    return false;
  }
  return true;
}

function matchesTextConstraints(
  paper: FederatedPaperResult,
  filters: LiteratureSearchFilters,
): boolean {
  if (filters.author !== undefined) {
    const needle = filters.author.toLowerCase();
    const hasAuthor = paper.authors.some(
      (author) =>
        author.displayName.toLowerCase().includes(needle) ||
        author.family.toLowerCase().includes(needle),
    );
    if (!hasAuthor) {
      return false;
    }
  }
  if (filters.journal !== undefined) {
    const journal = paper.journal?.toLowerCase() ?? '';
    if (!journal.includes(filters.journal.toLowerCase())) {
      return false;
    }
  }
  if (filters.fieldOrTopic !== undefined) {
    const needle = filters.fieldOrTopic.toLowerCase();
    const hasTopic = paper.topics.some((topic) => topic.toLowerCase().includes(needle));
    if (!hasTopic) {
      return false;
    }
  }
  return true;
}

export function matchesLiteratureFilters(
  paper: FederatedPaperResult,
  filters: LiteratureSearchFilters,
): boolean {
  if (!matchesYearBounds(paper.year, filters.yearFrom, filters.yearTo)) {
    return false;
  }
  if (
    filters.minCitationCount !== undefined &&
    (paper.citationCount === null || paper.citationCount < filters.minCitationCount)
  ) {
    return false;
  }
  if (filters.openAccessOnly === true && !paper.isOpenAccess) {
    return false;
  }
  if (filters.pdfAvailableOnly === true && paper.pdfUrl === null) {
    return false;
  }
  return matchesTextConstraints(paper, filters);
}
