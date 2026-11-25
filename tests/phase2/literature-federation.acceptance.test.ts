import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_CLIENT_POLICY,
  FederatedSearchResponseSchema,
  type FederatedSearchResponse,
  type LiteratureProvider,
  type LiteratureSearchQuery,
  type ProviderClientPolicy,
  type ProviderPaperCandidate,
  type Result,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface ProviderAdapterCallContext {
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

type ProviderAdapterFn = (
  query: LiteratureSearchQuery,
  context: ProviderAdapterCallContext,
) => Promise<readonly ProviderPaperCandidate[]>;

interface LiteratureSearchServiceLike {
  readonly search: (query: LiteratureSearchQuery) => Promise<Result<FederatedSearchResponse>>;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

function makeCandidate(
  provider: LiteratureProvider,
  overrides: Partial<ProviderPaperCandidate>,
): ProviderPaperCandidate {
  return {
    provider,
    externalId: `${provider}-1`,
    title: 'Federated Academic Search and Deduplication',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    journal: 'Journal of Research Systems',
    published: '2024-04-01',
    doi: '10.1038/s41586-024-12345-6',
    url: 'https://example.org/paper',
    abstract: 'Baseline abstract.',
    volume: '10',
    issue: '2',
    pages: '12-28',
    citationCount: 25,
    pdfUrl: null,
    isOpenAccess: false,
    topics: ['Information Retrieval'],
    ...overrides,
  };
}

function assertFederatedDedupOutcome(
  response: Result<FederatedSearchResponse>,
  capturedHeaders: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    return;
  }
  expect(FederatedSearchResponseSchema.safeParse(response.value).success).toBe(true);
  expect(response.value.warnings).toEqual([]);
  expect(response.value.results).toHaveLength(2);

  const mergedPaper = response.value.results.find(
    (item) => item.doi === '10.1038/s41586-024-12345-6',
  );
  expect(mergedPaper?.providers).toEqual(['openalex', 'crossref']);
  expect(mergedPaper?.citationCount).toBe(92);
  expect(mergedPaper?.abstract).toContain('Detailed Crossref abstract');
  expect(mergedPaper?.availableActions).toEqual(['open', 'save', 'pdf', 'add_to_project']);

  const openAlexUserAgent = capturedHeaders['openalex']?.['User-Agent'] ?? '';
  const crossrefUserAgent = capturedHeaders['crossref']?.['User-Agent'] ?? '';
  expect(openAlexUserAgent).toContain(DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail);
  expect(crossrefUserAgent).toContain(DEFAULT_PROVIDER_CLIENT_POLICY.contactEmail);
}

describe('Phase 2.1 Federated literature search and deduplication acceptance', () => {
  it('queries OpenAlex, Crossref, and PubMed concurrently with polite-pool headers and deduplicates results', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/literature-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/literature-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createLiteratureSearchService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createLiteratureSearchService')) {
      return;
    }

    const capturedHeaders: Record<string, Readonly<Record<string, string>>> = {};
    const openalexAdapter = vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      capturedHeaders['openalex'] = ctx.headers;
      return [
        makeCandidate('openalex', {
          externalId: 'W-101',
          doi: 'https://doi.org/10.1038/S41586-024-12345-6',
          citationCount: 92,
          pdfUrl: 'https://arxiv.org/pdf/2404.00001.pdf',
          isOpenAccess: true,
          topics: ['Information Retrieval', 'Bibliometrics'],
        }),
      ];
    });
    const crossrefAdapter = vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      capturedHeaders['crossref'] = ctx.headers;
      return [
        makeCandidate('crossref', {
          externalId: 'CR-101',
          doi: 'doi:10.1038/s41586-024-12345-6',
          abstract: 'Detailed Crossref abstract with comprehensive evaluation metrics.',
          citationCount: 40,
        }),
      ];
    });
    const pubmedAdapter = vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      capturedHeaders['pubmed'] = ctx.headers;
      return [
        makeCandidate('pubmed', {
          externalId: 'PMID-202',
          title: 'Clinical Trial Synthesis Using Retrieval Pipelines',
          authors: [{ family: 'Patel', given: 'Asha', displayName: 'Asha Patel', orcid: null }],
          year: 2022,
          journal: 'BMJ Open',
          doi: null,
          citationCount: 14,
          topics: ['Clinical Research'],
        }),
      ];
    });

    const factory = (
      loaded as {
        readonly createLiteratureSearchService: (deps: {
          readonly adapters: Readonly<Record<LiteratureProvider, ProviderAdapterFn>>;
          readonly policy?: Partial<ProviderClientPolicy>;
        }) => LiteratureSearchServiceLike;
      }
    ).createLiteratureSearchService;

    const service = factory({
      adapters: {
        openalex: openalexAdapter,
        crossref: crossrefAdapter,
        pubmed: pubmedAdapter,
      },
      policy: { ...DEFAULT_PROVIDER_CLIENT_POLICY, baseBackoffMs: 50 },
    });

    const response = await service.search({ query: 'federated academic search' });
    assertFederatedDedupOutcome(response, capturedHeaders);
  });

  it('returns healthy deduplicated results with a non-blocking warning on partial outage and caches identical queries', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/literature-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/literature-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createLiteratureSearchService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createLiteratureSearchService')) {
      return;
    }

    const openalexAdapter = vi.fn<ProviderAdapterFn>(async () => [
      makeCandidate('openalex', {
        externalId: 'W-300',
        year: 2024,
        citationCount: 65,
        pdfUrl: 'https://open.example.org/w300.pdf',
        isOpenAccess: true,
        topics: ['Machine Learning'],
      }),
    ]);
    const crossrefAdapter = vi.fn<ProviderAdapterFn>(async () => []);
    const pubmedAdapter = vi.fn<ProviderAdapterFn>(async () => {
      throw new Error('PubMed upstream 503 timeout');
    });

    const factory = (
      loaded as {
        readonly createLiteratureSearchService: (deps: {
          readonly adapters: Readonly<Record<LiteratureProvider, ProviderAdapterFn>>;
          readonly policy?: Partial<ProviderClientPolicy>;
        }) => LiteratureSearchServiceLike;
      }
    ).createLiteratureSearchService;

    const service = factory({
      adapters: {
        openalex: openalexAdapter,
        crossref: crossrefAdapter,
        pubmed: pubmedAdapter,
      },
      policy: {
        timeoutMs: 1000,
        maxRetries: 1,
        baseBackoffMs: 50,
        cacheTtlMs: 60000,
        contactEmail: 'polite-pool@sunrise.research',
      },
    });

    const query: LiteratureSearchQuery = {
      query: 'machine learning',
      filters: {
        yearFrom: 2023,
        yearTo: 2025,
        minCitationCount: 50,
        fieldOrTopic: 'machine learning',
        openAccessOnly: true,
        pdfAvailableOnly: true,
      },
    };

    const first = await service.search(query);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.value.results).toHaveLength(1);
    expect(first.value.warnings).toHaveLength(1);
    expect(first.value.warnings[0]?.provider).toBe('pubmed');
    expect(pubmedAdapter).toHaveBeenCalledTimes(2);

    const second = await service.search(query);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.cached).toBe(true);
      expect(openalexAdapter).toHaveBeenCalledTimes(1);
    }
  });

  it('registers authenticated literature search HTTP controller routes', async () => {
    const controllerPath = join(REPO_ROOT, 'apps/api/src/controllers/literature-controller.ts');
    expect(
      existsSync(controllerPath),
      'Missing apps/api/src/controllers/literature-controller.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(hasFunctionProp(loaded, 'registerLiteratureRoutes')).toBe(true);
  });
});
