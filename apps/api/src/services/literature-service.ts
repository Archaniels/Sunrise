import {
  DEFAULT_PROVIDER_CLIENT_POLICY,
  deduplicatePaperCandidates,
  err,
  FederatedSearchResponseSchema,
  LITERATURE_PROVIDERS,
  LiteratureSearchQuerySchema,
  matchesLiteratureFilters,
  normalizeDoi,
  ok,
  ProviderClientPolicySchema,
  type FederatedPaperResult,
  type FederatedSearchResponse,
  type LiteratureProvider,
  type LiteratureSearchQuery,
  type ProviderClientPolicy,
  type ProviderExecutionSummary,
  type ProviderPaperCandidate,
  type ProviderWarning,
  type ProviderWarningCode,
  type ReferenceAuthor,
  type Result,
} from '@sunrise/shared';
import { XMLParser } from 'fast-xml-parser';

export interface ProviderAdapterCallContext {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ProviderAdapterPageResult {
  readonly candidates: readonly ProviderPaperCandidate[];
  readonly totalAvailable?: number | null;
  readonly hasMore?: boolean;
}

export type ProviderAdapterResult = readonly ProviderPaperCandidate[] | ProviderAdapterPageResult;

export type ProviderAdapterFn = (
  query: LiteratureSearchQuery,
  context: ProviderAdapterCallContext,
) => Promise<ProviderAdapterResult>;

export interface LiteratureSearchServiceDeps {
  readonly adapters: Readonly<Record<LiteratureProvider, ProviderAdapterFn>>;
  readonly policy?: Partial<ProviderClientPolicy>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LiteratureSearchService {
  readonly search: (query: LiteratureSearchQuery) => Promise<Result<FederatedSearchResponse>>;
}

interface ProviderAttemptOutcome {
  readonly ok: boolean;
  readonly candidates: readonly ProviderPaperCandidate[];
  readonly totalAvailable: number | null;
  readonly hasMore: boolean;
  readonly latencyMs: number;
  readonly warning: ProviderWarning | null;
}

interface ProviderPaginationState {
  readonly provider: LiteratureProvider;
  readonly candidates: ProviderPaperCandidate[];
  totalAvailable: number | null;
  hasMore: boolean;
  pagesFetched: number;
  latencyMs: number;
  status: 'ok' | 'degraded' | 'failed';
  warning: ProviderWarning | null;
  hitCap: boolean;
}

interface CachedSearchEntry {
  readonly expiresAt: number;
  readonly response: FederatedSearchResponse;
}

interface ProviderErrorMetadata {
  readonly status?: number;
  readonly retryAfterMs?: number | null;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const MAX_SEARCH_CACHE_ENTRIES = 500;
const MAX_PROVIDER_PAGES = 5;
const MAX_PROVIDER_ITEMS = 500;
const MAX_TITLE_LENGTH = 1000;
const MAX_JOURNAL_LENGTH = 500;
const MAX_ABSTRACT_LENGTH = 20000;
const MAX_SHORT_FIELD_LENGTH = 64;
const MAX_EXTERNAL_ID_LENGTH = 256;

const PROVIDER_ERROR_META_KEY = Symbol('providerErrorMeta');

const XML_ORDERED_PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: false,
  parseTagValue: false,
  processEntities: {
    enabled: true,
    maxEntitySize: 1024,
    maxExpansionDepth: 5,
    maxTotalExpansions: 500,
    maxExpandedLength: 50000,
    maxEntityCount: 50,
  },
});

function createProviderHttpError(message: string, meta: ProviderErrorMetadata): Error {
  const error = new Error(message);
  Reflect.set(error, PROVIDER_ERROR_META_KEY, meta);
  return error;
}

function readProviderErrorMeta(error: unknown): ProviderErrorMetadata {
  if (error instanceof Error) {
    const raw = Reflect.get(error, PROVIDER_ERROR_META_KEY);
    if (typeof raw === 'object' && raw !== null) {
      return raw as ProviderErrorMetadata;
    }
  }
  return {};
}

export function parseRetryAfterHeaderMs(
  headerValue: string | null,
  currentTimeMs: number = Date.now(),
): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - currentTimeMs);
  }
  return null;
}

function buildPolitePoolHeaders(
  provider: LiteratureProvider,
  contactEmail: string,
): Readonly<Record<string, string>> {
  const userAgent = `SunriseResearchWorkspace/0.1.0 (mailto:${contactEmail})`;
  const accept = provider === 'pubmed' ? 'application/xml, application/json' : 'application/json';
  return {
    'User-Agent': userAgent,
    Accept: accept,
  };
}

function matchesAnyToken(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function classifyProviderError(error: unknown): {
  readonly code: ProviderWarningCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
} {
  const meta = readProviderErrorMeta(error);
  const rawMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim().slice(0, 480)
      : 'Unexpected provider error';
  const lowered = rawMessage.toLowerCase();
  if (meta.status === 429 || matchesAnyToken(lowered, ['429', 'rate limit'])) {
    return {
      code: 'RATE_LIMITED',
      message: rawMessage,
      retryable: true,
      retryAfterMs: meta.retryAfterMs ?? null,
    };
  }
  if (matchesAnyToken(lowered, ['timeout', 'timed out', 'abort'])) {
    return { code: 'TIMEOUT', message: rawMessage, retryable: true, retryAfterMs: null };
  }
  if (matchesAnyToken(lowered, ['invalid', 'parse', 'xml'])) {
    return { code: 'INVALID_RESPONSE', message: rawMessage, retryable: false, retryAfterMs: null };
  }
  if (matchesAnyToken(lowered, ['500', '502', '503', '504', 'upstream'])) {
    return { code: 'UPSTREAM_ERROR', message: rawMessage, retryable: true, retryAfterMs: null };
  }
  return { code: 'NETWORK_ERROR', message: rawMessage, retryable: true, retryAfterMs: null };
}

function normalizeAdapterResult(result: ProviderAdapterResult): {
  readonly candidates: readonly ProviderPaperCandidate[];
  readonly totalAvailable: number | null;
  readonly hasMore: boolean;
} {
  if (Array.isArray(result)) {
    return { candidates: result, totalAvailable: null, hasMore: false };
  }
  const pageResult = result as ProviderAdapterPageResult;
  return {
    candidates: pageResult.candidates,
    totalAvailable:
      typeof pageResult.totalAvailable === 'number' && pageResult.totalAvailable >= 0
        ? Math.floor(pageResult.totalAvailable)
        : null,
    hasMore: pageResult.hasMore === true,
  };
}

async function runAttemptWithAbortDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeoutErr = new Error(`Provider request timed out after ${timeoutMs}ms`);
      controller.abort(timeoutErr);
      reject(timeoutErr);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function computeRetryDelayMs(
  policy: ProviderClientPolicy,
  attempt: number,
  retryAfterMs: number | null,
): number | null {
  const exponentialDelay = policy.baseBackoffMs * Math.pow(2, attempt);
  if (retryAfterMs === null) {
    return exponentialDelay;
  }
  if (retryAfterMs > policy.timeoutMs) {
    return null;
  }
  return Math.max(exponentialDelay, retryAfterMs);
}

async function executeProviderPageWithRetries(
  provider: LiteratureProvider,
  adapter: ProviderAdapterFn,
  query: LiteratureSearchQuery,
  page: number,
  pageSize: number,
  policy: ProviderClientPolicy,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<ProviderAttemptOutcome> {
  const startedAt = now();
  const headers = buildPolitePoolHeaders(provider, policy.contactEmail);
  let lastFailure: {
    readonly code: ProviderWarningCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterMs: number | null;
  } = { code: 'NETWORK_ERROR', message: 'Provider failed', retryable: true, retryAfterMs: null };

  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    try {
      const raw = await runAttemptWithAbortDeadline(
        (signal) =>
          adapter(query, {
            headers,
            timeoutMs: policy.timeoutMs,
            signal,
            page,
            pageSize,
          }),
        policy.timeoutMs,
      );
      const normalized = normalizeAdapterResult(raw);
      return {
        ok: true,
        candidates: normalized.candidates,
        totalAvailable: normalized.totalAvailable,
        hasMore: normalized.hasMore,
        latencyMs: Math.max(0, Math.round(now() - startedAt)),
        warning: null,
      };
    } catch (error: unknown) {
      lastFailure = classifyProviderError(error);
      const canRetry = lastFailure.retryable && attempt < policy.maxRetries;
      const delayMs = canRetry
        ? computeRetryDelayMs(policy, attempt, lastFailure.retryAfterMs)
        : null;
      if (delayMs !== null) {
        await sleep(delayMs);
      } else {
        break;
      }
    }
  }

  return {
    ok: false,
    candidates: [],
    totalAvailable: null,
    hasMore: false,
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
    warning: {
      provider,
      code: lastFailure.code,
      message: lastFailure.message,
      retryable: lastFailure.retryable,
    },
  };
}

function deduplicateProviders(
  providers: readonly LiteratureProvider[] | undefined,
): LiteratureProvider[] {
  const source = providers ?? LITERATURE_PROVIDERS;
  const seen = new Set<LiteratureProvider>();
  const unique: LiteratureProvider[] = [];
  for (const provider of source) {
    if (!seen.has(provider)) {
      seen.add(provider);
      unique.push(provider);
    }
  }
  return unique;
}

function buildCacheKey(
  query: string,
  providers: readonly LiteratureProvider[],
  filters: LiteratureSearchQuery['filters'],
  limit: number,
  offset: number,
): string {
  return JSON.stringify({
    query: query.trim(),
    providers,
    filters: filters ?? null,
    limit,
    offset,
  });
}

function toCachedResponse(response: FederatedSearchResponse): FederatedSearchResponse {
  return {
    ...response,
    cached: true,
    providerSummaries: response.providerSummaries.map((summary) => ({
      ...summary,
      cached: true,
    })),
  };
}

function resolvePolicy(overrides?: Partial<ProviderClientPolicy>): ProviderClientPolicy {
  const envEmail = process.env['SUNRISE_LITERATURE_CONTACT_EMAIL'];
  const fallbackEmail =
    envEmail && envEmail.trim().length > 0
      ? envEmail.trim()
      : DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail;
  const merged = {
    ...DEFAULT_PROVIDER_CLIENT_POLICY,
    contactEmail: fallbackEmail,
    ...overrides,
  };
  return ProviderClientPolicySchema.parse(merged);
}

function storeBoundedCacheEntry(
  cache: Map<string, CachedSearchEntry>,
  cacheKey: string,
  response: FederatedSearchResponse,
  ttlMs: number,
  currentTime: number,
): void {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= currentTime) {
      cache.delete(key);
    }
  }
  while (cache.size >= MAX_SEARCH_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
  cache.set(cacheKey, {
    expiresAt: currentTime + ttlMs,
    response,
  });
}

function createInitialProviderState(provider: LiteratureProvider): ProviderPaginationState {
  return {
    provider,
    candidates: [],
    totalAvailable: null,
    hasMore: true,
    pagesFetched: 0,
    latencyMs: 0,
    status: 'ok',
    warning: null,
    hitCap: false,
  };
}

function applyAttemptToState(
  state: ProviderPaginationState,
  outcome: ProviderAttemptOutcome,
): void {
  state.latencyMs += outcome.latencyMs;
  if (!outcome.ok) {
    state.status = state.pagesFetched === 0 ? 'failed' : 'degraded';
    state.warning = outcome.warning;
    state.hasMore = false;
    return;
  }
  state.pagesFetched += 1;
  state.candidates.push(...outcome.candidates);
  if (outcome.totalAvailable !== null) {
    state.totalAvailable = outcome.totalAvailable;
  }
  const reachedCap =
    state.pagesFetched >= MAX_PROVIDER_PAGES || state.candidates.length >= MAX_PROVIDER_ITEMS;
  if (outcome.hasMore && reachedCap) {
    state.hitCap = true;
    state.hasMore = false;
  } else {
    state.hasMore = outcome.hasMore && outcome.candidates.length > 0;
  }
}

function collectFilteredResults(
  states: readonly ProviderPaginationState[],
  filters: LiteratureSearchQuery['filters'],
): FederatedPaperResult[] {
  const allCandidates: ProviderPaperCandidate[] = [];
  for (const state of states) {
    allCandidates.push(...state.candidates);
  }
  const deduplicated = deduplicatePaperCandidates(allCandidates);
  return filters
    ? deduplicated.filter((paper) => matchesLiteratureFilters(paper, filters))
    : deduplicated;
}

function hasActiveFilters(filters: LiteratureSearchQuery['filters']): boolean {
  if (!filters) {
    return false;
  }
  return Object.values(filters).some((value) => value !== undefined);
}

function computePaginationMetadata(
  states: readonly ProviderPaginationState[],
  filteredCount: number,
  filters: LiteratureSearchQuery['filters'],
  offset: number,
  limit: number,
  warningsCount: number,
): {
  readonly totalResults: number;
  readonly totalResultsIsEstimate: boolean;
  readonly hasMore: boolean;
  readonly upstreamFetchCapReached: boolean;
} {
  const upstreamFetchCapReached = states.some((state) => state.hitCap);
  const anyUnfetched = states.some((state) => state.hasMore || state.hitCap);
  const reportedTotals = states
    .filter((state) => state.status !== 'failed' && state.totalAvailable !== null)
    .map((state) => state.totalAvailable ?? 0);
  const hasFilters = hasActiveFilters(filters);
  const hasMore = filteredCount > offset + limit || anyUnfetched;

  if (reportedTotals.length === 0) {
    return {
      totalResults: filteredCount,
      totalResultsIsEstimate: warningsCount > 0 || upstreamFetchCapReached,
      hasMore,
      upstreamFetchCapReached,
    };
  }

  const sumReported = reportedTotals.reduce((acc, value) => acc + value, 0);
  if (reportedTotals.length === 1 && states.length === 1 && !hasFilters) {
    return {
      totalResults: Math.max(filteredCount, sumReported),
      totalResultsIsEstimate: warningsCount > 0 || anyUnfetched,
      hasMore,
      upstreamFetchCapReached,
    };
  }
  if (!anyUnfetched) {
    return {
      totalResults: filteredCount,
      totalResultsIsEstimate: warningsCount > 0,
      hasMore,
      upstreamFetchCapReached,
    };
  }
  return {
    totalResults: Math.max(filteredCount, sumReported),
    totalResultsIsEstimate: true,
    hasMore,
    upstreamFetchCapReached,
  };
}

function buildProviderSummariesAndWarnings(states: readonly ProviderPaginationState[]): {
  readonly providerSummaries: ProviderExecutionSummary[];
  readonly warnings: ProviderWarning[];
} {
  const providerSummaries: ProviderExecutionSummary[] = [];
  const warnings: ProviderWarning[] = [];
  for (const state of states) {
    providerSummaries.push({
      provider: state.provider,
      status: state.status,
      resultCount: state.candidates.length,
      cached: false,
      latencyMs: state.latencyMs,
    });
    if (state.warning !== null) {
      warnings.push(state.warning);
    }
  }
  return { providerSummaries, warnings };
}

async function fetchPaginatedProviders(
  providers: readonly LiteratureProvider[],
  deps: LiteratureSearchServiceDeps,
  parsedData: ReturnType<typeof LiteratureSearchQuerySchema.parse>,
  policy: ProviderClientPolicy,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<{
  readonly states: ProviderPaginationState[];
  readonly filtered: FederatedPaperResult[];
}> {
  const states = providers.map(createInitialProviderState);
  const targetCount = parsedData.offset + parsedData.limit;
  const pageSize = Math.min(100, Math.max(parsedData.limit, Math.min(100, targetCount)));
  let filtered: FederatedPaperResult[] = [];

  for (let round = 0; round < MAX_PROVIDER_PAGES; round += 1) {
    const activeStates = states.filter((state) => state.hasMore);
    if (activeStates.length === 0) {
      break;
    }
    const outcomes = await Promise.all(
      activeStates.map((state) =>
        executeProviderPageWithRetries(
          state.provider,
          deps.adapters[state.provider],
          parsedData,
          state.pagesFetched + 1,
          pageSize,
          policy,
          now,
          sleep,
        ),
      ),
    );
    for (let index = 0; index < activeStates.length; index += 1) {
      const state = activeStates[index];
      const outcome = outcomes[index];
      if (state && outcome) {
        applyAttemptToState(state, outcome);
      }
    }
    filtered = collectFilteredResults(states, parsedData.filters);
    if (filtered.length >= targetCount) {
      break;
    }
  }

  return { states, filtered };
}

export function createLiteratureSearchService(
  deps: LiteratureSearchServiceDeps,
): LiteratureSearchService {
  const policy = resolvePolicy(deps.policy);
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? DEFAULT_SLEEP;
  const cache = new Map<string, CachedSearchEntry>();

  return {
    search: async (rawQuery): Promise<Result<FederatedSearchResponse>> => {
      const parsed = LiteratureSearchQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid literature search query',
        });
      }

      const providers = deduplicateProviders(parsed.data.providers);
      const cacheKey = buildCacheKey(
        parsed.data.query,
        providers,
        parsed.data.filters,
        parsed.data.limit,
        parsed.data.offset,
      );

      const cachedEntry = cache.get(cacheKey);
      if (cachedEntry !== undefined && now() < cachedEntry.expiresAt) {
        return ok(toCachedResponse(cachedEntry.response));
      }

      const { states, filtered } = await fetchPaginatedProviders(
        providers,
        deps,
        parsed.data,
        policy,
        now,
        sleep,
      );
      const { providerSummaries, warnings } = buildProviderSummariesAndWarnings(states);
      const paged = filtered.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);
      const pagination = computePaginationMetadata(
        states,
        filtered.length,
        parsed.data.filters,
        parsed.data.offset,
        parsed.data.limit,
        warnings.length,
      );

      const response = FederatedSearchResponseSchema.parse({
        query: parsed.data.query,
        totalResults: pagination.totalResults,
        totalResultsIsEstimate: pagination.totalResultsIsEstimate,
        hasMore: pagination.hasMore,
        upstreamFetchCapReached: pagination.upstreamFetchCapReached,
        cached: false,
        results: paged,
        warnings,
        providerSummaries,
      });

      if (providerSummaries.some((summary) => summary.status !== 'failed')) {
        storeBoundedCacheEntry(cache, cacheKey, response, policy.cacheTtlMs, now());
      }

      return ok(response);
    },
  };
}

function asArray<T>(value: T | readonly T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number') {
    return String(value);
  }
  const rec = asRecord(value);
  if (rec !== null && '#text' in rec) {
    return readTextValue(rec['#text']);
  }
  return '';
}

function clampString(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength).trim() : normalized;
}

function nonEmptyOrNull(value: string, maxLength?: number): string | null {
  const cleaned = maxLength !== undefined ? clampString(value, maxLength) : value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function readHttpUrlOrNull(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 2048) {
    return null;
  }
  return trimmed.startsWith('https://') || trimmed.startsWith('http://') ? trimmed : null;
}

function readNonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function readValidYearOrNull(value: unknown): number | null {
  return typeof value === 'number' && value >= 1450 && value <= 2100 ? value : null;
}

type OrderedXmlNode = Readonly<Record<string, unknown>>;

function asOrderedNodes(value: unknown): OrderedXmlNode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asRecord).filter((entry): entry is OrderedXmlNode => entry !== null);
}

function findOrderedChildren(nodes: readonly OrderedXmlNode[], tagName: string): OrderedXmlNode[] {
  const results: OrderedXmlNode[] = [];
  for (const node of nodes) {
    if (tagName in node) {
      results.push(node);
    }
  }
  return results;
}

function getOrderedTagBody(nodes: readonly OrderedXmlNode[], tagName: string): OrderedXmlNode[] {
  const match = findOrderedChildren(nodes, tagName)[0];
  return match ? asOrderedNodes(match[tagName]) : [];
}

function readOrderedNodeAttr(node: OrderedXmlNode, attrName: string): string {
  const attrs = asRecord(node[':@']);
  const value = attrs ? attrs[`@_${attrName}`] : undefined;
  return typeof value === 'string' ? value.trim() : '';
}

function collectOrderedInlineText(nodes: readonly OrderedXmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') {
        continue;
      }
      if (key === '#text') {
        out += typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      } else {
        out += collectOrderedInlineText(asOrderedNodes(value));
      }
    }
  }
  return out;
}

function readOrderedText(nodes: readonly OrderedXmlNode[]): string {
  return collectOrderedInlineText(nodes).replace(/\s+/g, ' ').trim();
}

function parsePubMedOrderedAuthors(articleBody: readonly OrderedXmlNode[]): ReferenceAuthor[] {
  const authorListBody = getOrderedTagBody(articleBody, 'AuthorList');
  const authorNodes = findOrderedChildren(authorListBody, 'Author');
  const authors: ReferenceAuthor[] = [];
  for (const authorNode of authorNodes) {
    const body = asOrderedNodes(authorNode['Author']);
    const family = readOrderedText(getOrderedTagBody(body, 'LastName'));
    const foreName = readOrderedText(getOrderedTagBody(body, 'ForeName'));
    const initials = readOrderedText(getOrderedTagBody(body, 'Initials'));
    const given = foreName.length > 0 ? foreName : initials;
    if (family.length === 0) {
      continue;
    }
    const displayName = given.length > 0 ? `${given} ${family}` : family;
    authors.push({ family, given, displayName, orcid: null });
  }
  return authors;
}

function parsePubMedOrderedDoi(articleBody: readonly OrderedXmlNode[]): string | null {
  const pubmedData = getOrderedTagBody(articleBody, 'PubmedData');
  const idList = getOrderedTagBody(pubmedData, 'ArticleIdList');
  for (const idNode of findOrderedChildren(idList, 'ArticleId')) {
    if (readOrderedNodeAttr(idNode, 'IdType') === 'doi') {
      const normalized = normalizeDoi(readOrderedText(asOrderedNodes(idNode['ArticleId'])));
      if (normalized !== null) {
        return normalized;
      }
    }
  }
  return null;
}

function parsePubMedOrderedAbstract(articleBody: readonly OrderedXmlNode[]): string | null {
  const abstractBody = getOrderedTagBody(articleBody, 'Abstract');
  const sections = findOrderedChildren(abstractBody, 'AbstractText')
    .map((node) => readOrderedText(asOrderedNodes(node['AbstractText'])))
    .filter((line) => line.length > 0);
  if (sections.length === 0) {
    return null;
  }
  return clampString(sections.join('\n'), MAX_ABSTRACT_LENGTH);
}

function parsePubMedOrderedYear(issueBody: readonly OrderedXmlNode[]): number | null {
  const pubDateBody = getOrderedTagBody(issueBody, 'PubDate');
  const yearText =
    readOrderedText(getOrderedTagBody(pubDateBody, 'Year')) ||
    readOrderedText(getOrderedTagBody(pubDateBody, 'MedlineDate'));
  const parsed = Number.parseInt(yearText.slice(0, 4), 10);
  return Number.isInteger(parsed) && parsed >= 1450 && parsed <= 2100 ? parsed : null;
}

function extractPubMedJournalMeta(articleBody: readonly OrderedXmlNode[]): {
  readonly year: number | null;
  readonly journal: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
} {
  const journalBody = getOrderedTagBody(articleBody, 'Journal');
  const issueBody = getOrderedTagBody(journalBody, 'JournalIssue');
  const paginationBody = getOrderedTagBody(articleBody, 'Pagination');
  return {
    year: parsePubMedOrderedYear(issueBody),
    journal: nonEmptyOrNull(
      readOrderedText(getOrderedTagBody(journalBody, 'Title')),
      MAX_JOURNAL_LENGTH,
    ),
    volume: nonEmptyOrNull(
      readOrderedText(getOrderedTagBody(issueBody, 'Volume')),
      MAX_SHORT_FIELD_LENGTH,
    ),
    issue: nonEmptyOrNull(
      readOrderedText(getOrderedTagBody(issueBody, 'Issue')),
      MAX_SHORT_FIELD_LENGTH,
    ),
    pages: nonEmptyOrNull(
      readOrderedText(getOrderedTagBody(paginationBody, 'MedlinePgn')),
      MAX_SHORT_FIELD_LENGTH,
    ),
  };
}

function extractPubMedArticleCandidate(articleNode: OrderedXmlNode): ProviderPaperCandidate | null {
  const outerBody = asOrderedNodes(articleNode['PubmedArticle']);
  const medlineBody = getOrderedTagBody(outerBody, 'MedlineCitation');
  const articleBody = getOrderedTagBody(medlineBody, 'Article');
  if (medlineBody.length === 0 || articleBody.length === 0) {
    return null;
  }
  const pmid = clampString(
    readOrderedText(getOrderedTagBody(medlineBody, 'PMID')),
    MAX_EXTERNAL_ID_LENGTH,
  );
  const rawTitle = readOrderedText(getOrderedTagBody(articleBody, 'ArticleTitle')).replace(
    /\.$/,
    '',
  );
  const title = clampString(rawTitle, MAX_TITLE_LENGTH);
  if (pmid.length === 0 || title.length === 0) {
    return null;
  }
  const meta = extractPubMedJournalMeta(articleBody);

  return {
    provider: 'pubmed',
    externalId: pmid,
    title,
    authors: parsePubMedOrderedAuthors(articleBody),
    year: meta.year,
    journal: meta.journal,
    published: meta.year !== null ? String(meta.year) : null,
    doi: parsePubMedOrderedDoi(outerBody),
    url: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`,
    abstract: parsePubMedOrderedAbstract(articleBody),
    volume: meta.volume,
    issue: meta.issue,
    pages: meta.pages,
    citationCount: null,
    pdfUrl: null,
    isOpenAccess: false,
    topics: [],
  };
}

export function parsePubMedXmlCandidates(xmlText: string): ProviderPaperCandidate[] {
  const rootNodes = asOrderedNodes(XML_ORDERED_PARSER.parse(xmlText));
  const articleSetBody = getOrderedTagBody(rootNodes, 'PubmedArticleSet');
  const articleNodes = findOrderedChildren(articleSetBody, 'PubmedArticle');
  const candidates: ProviderPaperCandidate[] = [];
  for (const node of articleNodes) {
    const candidate = extractPubMedArticleCandidate(node);
    if (candidate !== null) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function reconstructOpenAlexAbstract(invertedIndex: unknown): string | null {
  const rec = asRecord(invertedIndex);
  if (!rec) {
    return null;
  }
  const pairs: Array<{ readonly pos: number; readonly word: string }> = [];
  for (const [word, positions] of Object.entries(rec)) {
    if (!Array.isArray(positions)) {
      continue;
    }
    for (const pos of positions) {
      if (typeof pos === 'number') {
        pairs.push({ pos, word });
      }
    }
  }
  if (pairs.length === 0) {
    return null;
  }
  pairs.sort((a, b) => a.pos - b.pos);
  return clampString(pairs.map((item) => item.word).join(' '), MAX_ABSTRACT_LENGTH);
}

function parseOpenAlexAuthor(entry: unknown): ReferenceAuthor | null {
  const authorship = asRecord(entry);
  const author = asRecord(authorship ? authorship['author'] : null);
  const displayName = readTextValue(author ? author['display_name'] : null);
  if (displayName.length === 0) {
    return null;
  }
  const parts = displayName.split(/\s+/);
  const family = parts[parts.length - 1] ?? displayName;
  const given = parts.slice(0, -1).join(' ');
  const rawOrcid = readTextValue(author ? author['orcid'] : null).replace(
    /^https?:\/\/orcid\.org\//i,
    '',
  );
  const orcid = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(rawOrcid) ? rawOrcid : null;
  return { family, given, displayName, orcid };
}

function parseOpenAlexBiblio(biblio: Readonly<Record<string, unknown>> | null): {
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
} {
  const firstPage = readTextValue(biblio?.['first_page']);
  const lastPage = readTextValue(biblio?.['last_page']);
  const pages =
    firstPage.length > 0 && lastPage.length > 0
      ? clampString(`${firstPage}-${lastPage}`, MAX_SHORT_FIELD_LENGTH)
      : null;
  return {
    volume: nonEmptyOrNull(readTextValue(biblio?.['volume']), MAX_SHORT_FIELD_LENGTH),
    issue: nonEmptyOrNull(readTextValue(biblio?.['issue']), MAX_SHORT_FIELD_LENGTH),
    pages,
  };
}

export function parseOpenAlexWork(work: unknown): ProviderPaperCandidate | null {
  const rec = asRecord(work);
  if (!rec) {
    return null;
  }
  const id = clampString(readTextValue(rec['id']), MAX_EXTERNAL_ID_LENGTH);
  const title = clampString(readTextValue(rec['display_name'] ?? rec['title']), MAX_TITLE_LENGTH);
  if (id.length === 0 || title.length === 0) {
    return null;
  }
  const primaryLocation = asRecord(rec['primary_location']);
  const source = asRecord(primaryLocation?.['source']);
  const openAccess = asRecord(rec['open_access']);
  const biblio = parseOpenAlexBiblio(asRecord(rec['biblio']));
  const authors = asArray(rec['authorships'])
    .map(parseOpenAlexAuthor)
    .filter((author): author is ReferenceAuthor => author !== null);
  const topics = asArray(rec['concepts'])
    .map((item) => clampString(readTextValue(asRecord(item)?.['display_name']), 120))
    .filter((topic) => topic.length > 0)
    .slice(0, 15);

  return {
    provider: 'openalex',
    externalId: id,
    title,
    authors,
    year: readValidYearOrNull(rec['publication_year']),
    journal: nonEmptyOrNull(readTextValue(source?.['display_name']), MAX_JOURNAL_LENGTH),
    published: nonEmptyOrNull(readTextValue(rec['publication_date']), 200),
    doi: normalizeDoi(readTextValue(rec['doi'])),
    url: readHttpUrlOrNull(id),
    abstract: reconstructOpenAlexAbstract(rec['abstract_inverted_index']),
    volume: biblio.volume,
    issue: biblio.issue,
    pages: biblio.pages,
    citationCount: readNonNegativeIntOrNull(rec['cited_by_count']),
    pdfUrl: readHttpUrlOrNull(readTextValue(primaryLocation?.['pdf_url'])),
    isOpenAccess: openAccess?.['is_oa'] === true,
    topics,
  };
}

function parseCrossrefAuthor(entry: unknown): ReferenceAuthor | null {
  const rec = asRecord(entry);
  if (!rec) {
    return null;
  }
  const family = readTextValue(rec['family']);
  const given = readTextValue(rec['given']);
  if (family.length === 0) {
    return null;
  }
  const displayName = given.length > 0 ? `${given} ${family}` : family;
  const rawOrcid = readTextValue(rec['ORCID']).replace(/^https?:\/\/orcid\.org\//i, '');
  const orcid = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(rawOrcid) ? rawOrcid : null;
  return { family, given, displayName, orcid };
}

function parseCrossrefYear(rec: Readonly<Record<string, unknown>>): number | null {
  const issued = asRecord(rec['issued'] ?? rec['published']);
  const dateParts = issued ? issued['date-parts'] : null;
  if (!Array.isArray(dateParts) || !Array.isArray(dateParts[0])) {
    return null;
  }
  const firstYear = dateParts[0][0];
  return typeof firstYear === 'number' && firstYear >= 1450 && firstYear <= 2100 ? firstYear : null;
}

export function parseCrossrefWork(item: unknown): ProviderPaperCandidate | null {
  const rec = asRecord(item);
  if (!rec) {
    return null;
  }
  const doi = normalizeDoi(readTextValue(rec['DOI']));
  const title = clampString(readTextValue(asArray(rec['title'])[0]), MAX_TITLE_LENGTH);
  if (title.length === 0) {
    return null;
  }
  const authors = asArray(rec['author'])
    .map(parseCrossrefAuthor)
    .filter((author): author is ReferenceAuthor => author !== null);
  const rawAbstract = readTextValue(rec['abstract']).replace(/<[^>]+>/g, ' ');
  const year = parseCrossrefYear(rec);

  return {
    provider: 'crossref',
    externalId: clampString(doi ?? title.slice(0, 64), MAX_EXTERNAL_ID_LENGTH),
    title,
    authors,
    year,
    journal: nonEmptyOrNull(readTextValue(asArray(rec['container-title'])[0]), MAX_JOURNAL_LENGTH),
    published: year !== null ? String(year) : null,
    doi,
    url: readHttpUrlOrNull(readTextValue(rec['URL'])),
    abstract: nonEmptyOrNull(rawAbstract, MAX_ABSTRACT_LENGTH),
    volume: nonEmptyOrNull(readTextValue(rec['volume']), MAX_SHORT_FIELD_LENGTH),
    issue: nonEmptyOrNull(readTextValue(rec['issue']), MAX_SHORT_FIELD_LENGTH),
    pages: nonEmptyOrNull(readTextValue(rec['page']), MAX_SHORT_FIELD_LENGTH),
    citationCount: readNonNegativeIntOrNull(rec['is-referenced-by-count']),
    pdfUrl: null,
    isOpenAccess: false,
    topics: asArray(rec['subject'])
      .map((subject) => clampString(readTextValue(subject), 120))
      .filter((subject) => subject.length > 0)
      .slice(0, 15),
  };
}

function resolvePageWindow(
  query: LiteratureSearchQuery,
  context: ProviderAdapterCallContext,
): { readonly page: number; readonly pageSize: number } {
  const page = Math.max(1, context.page ?? 1);
  const fallbackSize = Math.min(100, Math.max(1, (query.offset ?? 0) + (query.limit ?? 25)));
  const pageSize = Math.min(100, Math.max(1, context.pageSize ?? fallbackSize));
  return { page, pageSize };
}

function resolveRequestSignal(context: ProviderAdapterCallContext): AbortSignal {
  return context.signal ?? AbortSignal.timeout(context.timeoutMs);
}

export function createOpenAlexAdapter(
  contactEmail: string = DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail,
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<ProviderAdapterPageResult> => {
    const { page, pageSize } = resolvePageWindow(query, context);
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', query.query);
    url.searchParams.set('per-page', String(pageSize));
    url.searchParams.set('page', String(page));
    url.searchParams.set('mailto', contactEmail);
    const response = await fetchFn(url.toString(), {
      headers: context.headers,
      signal: resolveRequestSignal(context),
    });
    if (!response.ok) {
      const retryAfterMs =
        response.status === 429
          ? parseRetryAfterHeaderMs(response.headers.get('retry-after'))
          : null;
      throw createProviderHttpError(`OpenAlex upstream ${response.status}`, {
        status: response.status,
        retryAfterMs,
      });
    }
    const payload: unknown = await response.json();
    const rec = asRecord(payload);
    const meta = asRecord(rec?.['meta']);
    const totalAvailable = readNonNegativeIntOrNull(meta?.['count']);
    const rawItems = asArray(rec ? rec['results'] : null);
    const candidates = rawItems
      .map(parseOpenAlexWork)
      .filter((item): item is ProviderPaperCandidate => item !== null);
    const fetchedSoFar = (page - 1) * pageSize + rawItems.length;
    const hasMore =
      rawItems.length > 0 &&
      (totalAvailable !== null ? fetchedSoFar < totalAvailable : rawItems.length >= pageSize);
    return { candidates, totalAvailable, hasMore };
  };
}

export function createCrossrefAdapter(
  contactEmail: string = DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail,
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<ProviderAdapterPageResult> => {
    const { page, pageSize } = resolvePageWindow(query, context);
    const offset = (page - 1) * pageSize;
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query', query.query);
    url.searchParams.set('rows', String(pageSize));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('mailto', contactEmail);
    const response = await fetchFn(url.toString(), {
      headers: context.headers,
      signal: resolveRequestSignal(context),
    });
    if (!response.ok) {
      const retryAfterMs =
        response.status === 429
          ? parseRetryAfterHeaderMs(response.headers.get('retry-after'))
          : null;
      throw createProviderHttpError(`Crossref upstream ${response.status}`, {
        status: response.status,
        retryAfterMs,
      });
    }
    const payload: unknown = await response.json();
    const rec = asRecord(payload);
    const message = asRecord(rec ? rec['message'] : null);
    const totalAvailable = readNonNegativeIntOrNull(message?.['total-results']);
    const rawItems = asArray(message ? message['items'] : null);
    const candidates = rawItems
      .map(parseCrossrefWork)
      .filter((item): item is ProviderPaperCandidate => item !== null);
    const fetchedSoFar = offset + rawItems.length;
    const hasMore =
      rawItems.length > 0 &&
      (totalAvailable !== null ? fetchedSoFar < totalAvailable : rawItems.length >= pageSize);
    return { candidates, totalAvailable, hasMore };
  };
}

function buildPubMedEsearchUrl(
  queryText: string,
  retstart: number,
  retmax: number,
  options: { readonly contactEmail?: string; readonly apiKey?: string },
): string {
  const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
  searchUrl.searchParams.set('db', 'pubmed');
  searchUrl.searchParams.set('retmode', 'json');
  searchUrl.searchParams.set('retstart', String(retstart));
  searchUrl.searchParams.set('retmax', String(retmax));
  searchUrl.searchParams.set('term', queryText);
  if (options.contactEmail) {
    searchUrl.searchParams.set('email', options.contactEmail);
  }
  if (options.apiKey) {
    searchUrl.searchParams.set('api_key', options.apiKey);
  }
  return searchUrl.toString();
}

async function fetchPubMedXmlCandidates(
  idList: readonly string[],
  options: { readonly contactEmail?: string; readonly apiKey?: string },
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<readonly ProviderPaperCandidate[]> {
  const fetchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
  fetchUrl.searchParams.set('db', 'pubmed');
  fetchUrl.searchParams.set('retmode', 'xml');
  fetchUrl.searchParams.set('id', idList.join(','));
  if (options.apiKey) {
    fetchUrl.searchParams.set('api_key', options.apiKey);
  }
  const xmlResponse = await fetchFn(fetchUrl.toString(), { headers, signal });
  if (!xmlResponse.ok) {
    throw createProviderHttpError(`PubMed efetch upstream ${xmlResponse.status}`, {
      status: xmlResponse.status,
    });
  }
  return parsePubMedXmlCandidates(await xmlResponse.text());
}

function parsePubMedEsearchPayload(payload: unknown): {
  readonly totalAvailable: number | null;
  readonly idList: readonly string[];
} {
  const esearchResult = asRecord(asRecord(payload)?.['esearchresult']);
  const rawCount = Number.parseInt(readTextValue(esearchResult?.['count']), 10);
  const totalAvailable = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : null;
  const idList = asArray(esearchResult ? esearchResult['idlist'] : null)
    .map((id) => readTextValue(id))
    .filter((id) => id.length > 0);
  return { totalAvailable, idList };
}

export function createPubMedAdapter(
  options: { readonly contactEmail?: string; readonly apiKey?: string } = {},
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<ProviderAdapterPageResult> => {
    const { page, pageSize } = resolvePageWindow(query, context);
    const retstart = (page - 1) * pageSize;
    const signal = resolveRequestSignal(context);
    const searchUrl = buildPubMedEsearchUrl(query.query, retstart, pageSize, options);
    const searchResponse = await fetchFn(searchUrl, {
      headers: context.headers,
      signal,
    });
    if (!searchResponse.ok) {
      const retryAfterMs =
        searchResponse.status === 429
          ? parseRetryAfterHeaderMs(searchResponse.headers.get('retry-after'))
          : null;
      throw createProviderHttpError(`PubMed upstream ${searchResponse.status}`, {
        status: searchResponse.status,
        retryAfterMs,
      });
    }
    const { totalAvailable, idList } = parsePubMedEsearchPayload(await searchResponse.json());
    if (idList.length === 0) {
      return { candidates: [], totalAvailable, hasMore: false };
    }
    const candidates = await fetchPubMedXmlCandidates(
      idList,
      options,
      context.headers,
      signal,
      fetchFn,
    );
    const fetchedSoFar = retstart + idList.length;
    const hasMore =
      totalAvailable !== null ? fetchedSoFar < totalAvailable : idList.length >= pageSize;
    return { candidates, totalAvailable, hasMore };
  };
}

export function createDefaultLiteratureAdapters(
  options: { readonly contactEmail?: string; readonly ncbiApiKey?: string } = {},
  fetchFn: typeof fetch = fetch,
): Readonly<Record<LiteratureProvider, ProviderAdapterFn>> {
  const email =
    options.contactEmail ??
    process.env['SUNRISE_LITERATURE_CONTACT_EMAIL'] ??
    DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail;
  const apiKey = options.ncbiApiKey ?? process.env['NCBI_API_KEY'];
  return {
    openalex: createOpenAlexAdapter(email, fetchFn),
    crossref: createCrossrefAdapter(email, fetchFn),
    pubmed: createPubMedAdapter(
      {
        contactEmail: email,
        ...(apiKey && apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      },
      fetchFn,
    ),
  };
}
