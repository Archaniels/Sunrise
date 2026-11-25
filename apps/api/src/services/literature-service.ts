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
}

export type ProviderAdapterFn = (
  query: LiteratureSearchQuery,
  context: ProviderAdapterCallContext,
) => Promise<readonly ProviderPaperCandidate[]>;

export interface LiteratureSearchServiceDeps {
  readonly adapters: Readonly<Record<LiteratureProvider, ProviderAdapterFn>>;
  readonly policy?: Partial<ProviderClientPolicy>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LiteratureSearchService {
  readonly search: (query: LiteratureSearchQuery) => Promise<Result<FederatedSearchResponse>>;
}

interface ProviderRunOutcome {
  readonly provider: LiteratureProvider;
  readonly candidates: readonly ProviderPaperCandidate[];
  readonly summary: ProviderExecutionSummary;
  readonly warning: ProviderWarning | null;
}

interface CachedSearchEntry {
  readonly expiresAt: number;
  readonly response: FederatedSearchResponse;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

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
} {
  const rawMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim().slice(0, 480)
      : 'Unexpected provider error';
  const lowered = rawMessage.toLowerCase();
  if (matchesAnyToken(lowered, ['timeout', 'timed out', 'abort'])) {
    return { code: 'TIMEOUT', message: rawMessage, retryable: true };
  }
  if (matchesAnyToken(lowered, ['429', 'rate limit'])) {
    return { code: 'RATE_LIMITED', message: rawMessage, retryable: true };
  }
  if (matchesAnyToken(lowered, ['invalid', 'parse', 'xml'])) {
    return { code: 'INVALID_RESPONSE', message: rawMessage, retryable: false };
  }
  if (matchesAnyToken(lowered, ['500', '502', '503', '504', 'upstream'])) {
    return { code: 'UPSTREAM_ERROR', message: rawMessage, retryable: true };
  }
  return { code: 'NETWORK_ERROR', message: rawMessage, retryable: true };
}

async function runWithTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Provider request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function executeProviderWithRetries(
  provider: LiteratureProvider,
  adapter: ProviderAdapterFn,
  query: LiteratureSearchQuery,
  policy: ProviderClientPolicy,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<ProviderRunOutcome> {
  const startedAt = now();
  const context: ProviderAdapterCallContext = {
    headers: buildPolitePoolHeaders(provider, policy.contactEmail),
    timeoutMs: policy.timeoutMs,
  };
  let lastFailure: {
    readonly code: ProviderWarningCode;
    readonly message: string;
    readonly retryable: boolean;
  } = { code: 'NETWORK_ERROR', message: 'Provider failed', retryable: true };

  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    try {
      const candidates = await runWithTimeout(() => adapter(query, context), policy.timeoutMs);
      const latencyMs = Math.max(0, Math.round(now() - startedAt));
      return {
        provider,
        candidates,
        summary: {
          provider,
          status: 'ok',
          resultCount: candidates.length,
          cached: false,
          latencyMs,
        },
        warning: null,
      };
    } catch (error: unknown) {
      lastFailure = classifyProviderError(error);
      const shouldRetry = lastFailure.retryable && attempt < policy.maxRetries;
      if (shouldRetry) {
        const delayMs = policy.baseBackoffMs * Math.pow(2, attempt);
        await sleep(delayMs);
      } else {
        break;
      }
    }
  }

  const latencyMs = Math.max(0, Math.round(now() - startedAt));
  return {
    provider,
    candidates: [],
    summary: {
      provider,
      status: 'failed',
      resultCount: 0,
      cached: false,
      latencyMs,
    },
    warning: {
      provider,
      code: lastFailure.code,
      message: lastFailure.message,
      retryable: lastFailure.retryable,
    },
  };
}

function buildCacheKey(
  query: string,
  providers: readonly LiteratureProvider[],
  filters: LiteratureSearchQuery['filters'],
  limit: number,
  offset: number,
): string {
  return JSON.stringify({
    query: query.trim().toLowerCase(),
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

function aggregateProviderOutcomes(outcomes: readonly ProviderRunOutcome[]): {
  readonly allCandidates: ProviderPaperCandidate[];
  readonly warnings: ProviderWarning[];
  readonly providerSummaries: ProviderExecutionSummary[];
} {
  const allCandidates: ProviderPaperCandidate[] = [];
  const warnings: ProviderWarning[] = [];
  const providerSummaries: ProviderExecutionSummary[] = [];
  for (const outcome of outcomes) {
    allCandidates.push(...outcome.candidates);
    providerSummaries.push(outcome.summary);
    if (outcome.warning !== null) {
      warnings.push(outcome.warning);
    }
  }
  return { allCandidates, warnings, providerSummaries };
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

      const providers: readonly LiteratureProvider[] =
        parsed.data.providers ?? LITERATURE_PROVIDERS;
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

      const outcomes = await Promise.all(
        providers.map((provider) =>
          executeProviderWithRetries(
            provider,
            deps.adapters[provider],
            parsed.data,
            policy,
            now,
            sleep,
          ),
        ),
      );

      const { allCandidates, warnings, providerSummaries } = aggregateProviderOutcomes(outcomes);
      const deduplicated = deduplicatePaperCandidates(allCandidates);
      const filters = parsed.data.filters;
      const filtered = filters
        ? deduplicated.filter((paper) => matchesLiteratureFilters(paper, filters))
        : deduplicated;
      const paged = filtered.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);

      const response = FederatedSearchResponseSchema.parse({
        query: parsed.data.query,
        totalResults: filtered.length,
        cached: false,
        results: paged,
        warnings,
        providerSummaries,
      });

      if (providerSummaries.some((summary) => summary.status === 'ok')) {
        cache.set(cacheKey, {
          expiresAt: now() + policy.cacheTtlMs,
          response,
        });
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

function parsePubMedAuthors(authorListNode: unknown): ReferenceAuthor[] {
  const listRecord = asRecord(authorListNode);
  const rawAuthors = asArray(listRecord ? listRecord['Author'] : null);
  const authors: ReferenceAuthor[] = [];
  for (const item of rawAuthors) {
    const rec = asRecord(item);
    if (!rec) {
      continue;
    }
    const family = readTextValue(rec['LastName']);
    const given = readTextValue(rec['ForeName'] ?? rec['Initials']);
    if (family.length === 0) {
      continue;
    }
    const displayName = given.length > 0 ? `${given} ${family}` : family;
    authors.push({ family, given, displayName, orcid: null });
  }
  return authors;
}

function parsePubMedDoi(articleIdsNode: unknown): string | null {
  const rec = asRecord(articleIdsNode);
  const rawIds = asArray(rec ? rec['ArticleId'] : null);
  for (const idNode of rawIds) {
    const idRec = asRecord(idNode);
    if (idRec && idRec['@_IdType'] === 'doi') {
      const normalized = normalizeDoi(readTextValue(idRec));
      if (normalized !== null) {
        return normalized;
      }
    }
  }
  return null;
}

function parsePubMedAbstract(abstractNode: unknown): string | null {
  const rec = asRecord(abstractNode);
  if (!rec) {
    return null;
  }
  const sections = asArray(rec['AbstractText'])
    .map((entry) => readTextValue(entry))
    .filter((line) => line.length > 0);
  return sections.length > 0 ? sections.join('\n') : null;
}

function parsePubMedYear(pubDateNode: unknown): number | null {
  const rec = asRecord(pubDateNode);
  if (!rec) {
    return null;
  }
  const yearText = readTextValue(rec['Year'] ?? rec['MedlineDate']).slice(0, 4);
  const parsed = Number.parseInt(yearText, 10);
  return Number.isInteger(parsed) && parsed >= 1450 && parsed <= 2100 ? parsed : null;
}

function nonEmptyOrNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

function readHttpUrlOrNull(value: string): string | null {
  return value.startsWith('https://') || value.startsWith('http://') ? value : null;
}

function readNonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? Math.floor(value) : null;
}

function readValidYearOrNull(value: unknown): number | null {
  return typeof value === 'number' && value >= 1450 && value <= 2100 ? value : null;
}

function extractPubMedJournalMeta(article: Readonly<Record<string, unknown>>): {
  readonly year: number | null;
  readonly journal: string | null;
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
} {
  const journalRec = asRecord(article['Journal']);
  const issueRec = asRecord(journalRec?.['JournalIssue']);
  const pagination = asRecord(article['Pagination']);
  return {
    year: parsePubMedYear(issueRec?.['PubDate']),
    journal: nonEmptyOrNull(readTextValue(journalRec?.['Title'])),
    volume: nonEmptyOrNull(readTextValue(issueRec?.['Volume'])),
    issue: nonEmptyOrNull(readTextValue(issueRec?.['Issue'])),
    pages: nonEmptyOrNull(readTextValue(pagination?.['MedlinePgn'])),
  };
}

function extractPubMedArticleCandidate(entry: unknown): ProviderPaperCandidate | null {
  const articleRec = asRecord(entry);
  const medline = asRecord(articleRec?.['MedlineCitation']);
  const article = asRecord(medline?.['Article']);
  if (!medline || !article) {
    return null;
  }
  const pmid = readTextValue(medline['PMID']);
  const title = readTextValue(article['ArticleTitle']).replace(/\.$/, '');
  if (pmid.length === 0 || title.length === 0) {
    return null;
  }
  const pubmedData = asRecord(articleRec?.['PubmedData']);
  const meta = extractPubMedJournalMeta(article);

  return {
    provider: 'pubmed',
    externalId: pmid,
    title,
    authors: parsePubMedAuthors(article['AuthorList']),
    year: meta.year,
    journal: meta.journal,
    published: meta.year !== null ? String(meta.year) : null,
    doi: parsePubMedDoi(pubmedData?.['ArticleIdList']),
    url: `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`,
    abstract: parsePubMedAbstract(article['Abstract']),
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
  const parsed: unknown = XML_PARSER.parse(xmlText);
  const root = asRecord(parsed);
  const articleSet = asRecord(root ? root['PubmedArticleSet'] : null);
  const articles = asArray(articleSet ? articleSet['PubmedArticle'] : null);
  const candidates: ProviderPaperCandidate[] = [];
  for (const entry of articles) {
    const candidate = extractPubMedArticleCandidate(entry);
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
  return pairs.map((item) => item.word).join(' ');
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
  const pages = firstPage.length > 0 && lastPage.length > 0 ? `${firstPage}-${lastPage}` : null;
  return {
    volume: nonEmptyOrNull(readTextValue(biblio?.['volume'])),
    issue: nonEmptyOrNull(readTextValue(biblio?.['issue'])),
    pages,
  };
}

function parseOpenAlexWork(work: unknown): ProviderPaperCandidate | null {
  const rec = asRecord(work);
  if (!rec) {
    return null;
  }
  const id = readTextValue(rec['id']);
  const title = readTextValue(rec['display_name'] ?? rec['title']);
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
    .map((item) => readTextValue(asRecord(item)?.['display_name']))
    .filter((topic) => topic.length > 0)
    .slice(0, 15);

  return {
    provider: 'openalex',
    externalId: id,
    title,
    authors,
    year: readValidYearOrNull(rec['publication_year']),
    journal: nonEmptyOrNull(readTextValue(source?.['display_name'])),
    published: nonEmptyOrNull(readTextValue(rec['publication_date'])),
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
  const title = readTextValue(asArray(rec['title'])[0]);
  if (title.length === 0) {
    return null;
  }
  const authors = asArray(rec['author'])
    .map(parseCrossrefAuthor)
    .filter((author): author is ReferenceAuthor => author !== null);
  const rawAbstract = readTextValue(rec['abstract'])
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const year = parseCrossrefYear(rec);

  return {
    provider: 'crossref',
    externalId: doi ?? title.slice(0, 64),
    title,
    authors,
    year,
    journal: nonEmptyOrNull(readTextValue(asArray(rec['container-title'])[0])),
    published: year !== null ? String(year) : null,
    doi,
    url: readHttpUrlOrNull(readTextValue(rec['URL'])),
    abstract: nonEmptyOrNull(rawAbstract),
    volume: nonEmptyOrNull(readTextValue(rec['volume'])),
    issue: nonEmptyOrNull(readTextValue(rec['issue'])),
    pages: nonEmptyOrNull(readTextValue(rec['page'])),
    citationCount: readNonNegativeIntOrNull(rec['is-referenced-by-count']),
    pdfUrl: null,
    isOpenAccess: false,
    topics: asArray(rec['subject'])
      .map((subject) => readTextValue(subject))
      .filter((subject) => subject.length > 0)
      .slice(0, 15),
  };
}

export function createOpenAlexAdapter(
  contactEmail: string = DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail,
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<readonly ProviderPaperCandidate[]> => {
    const limit = query.limit ?? 25;
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', query.query);
    url.searchParams.set('per-page', String(limit));
    url.searchParams.set('mailto', contactEmail);
    const response = await fetchFn(url.toString(), {
      headers: context.headers,
      signal: AbortSignal.timeout(context.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OpenAlex upstream ${response.status}`);
    }
    const payload: unknown = await response.json();
    const rec = asRecord(payload);
    return asArray(rec ? rec['results'] : null)
      .map(parseOpenAlexWork)
      .filter((item): item is ProviderPaperCandidate => item !== null);
  };
}

export function createCrossrefAdapter(
  contactEmail: string = DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail,
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<readonly ProviderPaperCandidate[]> => {
    const limit = query.limit ?? 25;
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query', query.query);
    url.searchParams.set('rows', String(limit));
    url.searchParams.set('mailto', contactEmail);
    const response = await fetchFn(url.toString(), {
      headers: context.headers,
      signal: AbortSignal.timeout(context.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Crossref upstream ${response.status}`);
    }
    const payload: unknown = await response.json();
    const rec = asRecord(payload);
    const message = asRecord(rec ? rec['message'] : null);
    return asArray(message ? message['items'] : null)
      .map(parseCrossrefWork)
      .filter((item): item is ProviderPaperCandidate => item !== null);
  };
}

export function createPubMedAdapter(
  options: { readonly contactEmail?: string; readonly apiKey?: string } = {},
  fetchFn: typeof fetch = fetch,
): ProviderAdapterFn {
  return async (query, context): Promise<readonly ProviderPaperCandidate[]> => {
    const limit = query.limit ?? 25;
    const searchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    searchUrl.searchParams.set('db', 'pubmed');
    searchUrl.searchParams.set('retmode', 'json');
    searchUrl.searchParams.set('retmax', String(limit));
    searchUrl.searchParams.set('term', query.query);
    if (options.contactEmail) {
      searchUrl.searchParams.set('email', options.contactEmail);
    }
    if (options.apiKey) {
      searchUrl.searchParams.set('api_key', options.apiKey);
    }
    const searchResponse = await fetchFn(searchUrl.toString(), {
      headers: context.headers,
      signal: AbortSignal.timeout(context.timeoutMs),
    });
    if (!searchResponse.ok) {
      throw new Error(`PubMed upstream ${searchResponse.status}`);
    }
    const searchPayload: unknown = await searchResponse.json();
    const esearchResult = asRecord(asRecord(searchPayload)?.['esearchresult']);
    const idList = asArray(esearchResult ? esearchResult['idlist'] : null)
      .map((id) => readTextValue(id))
      .filter((id) => id.length > 0);
    if (idList.length === 0) {
      return [];
    }

    const fetchUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi');
    fetchUrl.searchParams.set('db', 'pubmed');
    fetchUrl.searchParams.set('retmode', 'xml');
    fetchUrl.searchParams.set('id', idList.join(','));
    if (options.apiKey) {
      fetchUrl.searchParams.set('api_key', options.apiKey);
    }
    const xmlResponse = await fetchFn(fetchUrl.toString(), {
      headers: context.headers,
      signal: AbortSignal.timeout(context.timeoutMs),
    });
    if (!xmlResponse.ok) {
      throw new Error(`PubMed efetch upstream ${xmlResponse.status}`);
    }
    return parsePubMedXmlCandidates(await xmlResponse.text());
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
