import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_CLIENT_POLICY,
  err,
  FederatedSearchResponseSchema,
  ok,
  type FederatedSearchResponse,
  type LiteratureProvider,
  type LiteratureSearchQuery,
  type ProviderClientPolicy,
  type ProviderPaperCandidate,
  type Result,
  type UserPublic,
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

function createDeferredProviderAdapters(
  gate: Promise<void>,
  startedProviders: LiteratureProvider[],
  capturedHeaders: Record<string, Readonly<Record<string, string>>>,
): Readonly<Record<LiteratureProvider, ProviderAdapterFn>> {
  return {
    openalex: vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      startedProviders.push('openalex');
      capturedHeaders['openalex'] = ctx.headers;
      await gate;
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
    }),
    crossref: vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      startedProviders.push('crossref');
      capturedHeaders['crossref'] = ctx.headers;
      await gate;
      return [
        makeCandidate('crossref', {
          externalId: 'CR-101',
          doi: 'doi:10.1038/s41586-024-12345-6',
          abstract: 'Detailed Crossref abstract with comprehensive evaluation metrics.',
          citationCount: 40,
        }),
      ];
    }),
    pubmed: vi.fn<ProviderAdapterFn>(async (_query, ctx) => {
      startedProviders.push('pubmed');
      capturedHeaders['pubmed'] = ctx.headers;
      await gate;
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
    }),
  };
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

    let releaseProviders: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      releaseProviders = resolveGate;
    });
    const startedProviders: LiteratureProvider[] = [];
    const capturedHeaders: Record<string, Readonly<Record<string, string>>> = {};
    const adapters = createDeferredProviderAdapters(gate, startedProviders, capturedHeaders);

    const factory = (
      loaded as {
        readonly createLiteratureSearchService: (deps: {
          readonly adapters: Readonly<Record<LiteratureProvider, ProviderAdapterFn>>;
          readonly policy?: Partial<ProviderClientPolicy>;
        }) => LiteratureSearchServiceLike;
      }
    ).createLiteratureSearchService;

    const service = factory({
      adapters,
      policy: { ...DEFAULT_PROVIDER_CLIENT_POLICY, baseBackoffMs: 50 },
    });

    const searchPromise = service.search({ query: 'federated academic search' });
    await new Promise<void>((resolveTick) => {
      setImmediate(resolveTick);
    });
    expect([...startedProviders].sort()).toEqual(['crossref', 'openalex', 'pubmed']);
    releaseProviders?.();

    const response = await searchPromise;
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
    const serverPath = join(REPO_ROOT, 'apps/api/src/server.ts');
    expect(
      existsSync(controllerPath),
      'Missing apps/api/src/controllers/literature-controller.ts',
    ).toBe(true);
    expect(existsSync(serverPath), 'Missing apps/api/src/server.ts').toBe(true);

    const loadedController: unknown = await import(pathToFileURL(controllerPath).href);
    const loadedServer: unknown = await import(pathToFileURL(serverPath).href);
    expect(hasFunctionProp(loadedController, 'registerLiteratureRoutes')).toBe(true);
    expect(hasFunctionProp(loadedServer, 'createApiServer')).toBe(true);
    if (
      !hasFunctionProp(loadedController, 'registerLiteratureRoutes') ||
      !hasFunctionProp(loadedServer, 'createApiServer')
    ) {
      return;
    }

    const createApiServer = (
      loadedServer as {
        readonly createApiServer: (
          probes: {
            readonly checkPostgres: () => Promise<number>;
            readonly checkPgvector: () => Promise<number>;
            readonly checkS3: () => Promise<number>;
          },
          version: string,
        ) => FastifyInjectLike;
      }
    ).createApiServer;
    const registerLiteratureRoutes = (
      loadedController as {
        readonly registerLiteratureRoutes: (
          app: FastifyInjectLike,
          authService: {
            readonly getMe: (token: string | undefined) => Promise<Result<UserPublic>>;
          },
          literatureService: LiteratureSearchServiceLike,
        ) => void;
      }
    ).registerLiteratureRoutes;

    const searchSpy = vi.fn(
      async (query: LiteratureSearchQuery): Promise<Result<FederatedSearchResponse>> =>
        ok({
          query: query.query,
          totalResults: 0,
          cached: false,
          results: [],
          warnings: [],
          providerSummaries: [
            { provider: 'openalex', status: 'ok', resultCount: 0, cached: false, latencyMs: 5 },
          ],
        }),
    );

    const app = createApiServer(
      {
        checkPostgres: async () => 1,
        checkPgvector: async () => 1,
        checkS3: async () => 1,
      },
      '0.1.0',
    );
    registerLiteratureRoutes(
      app,
      {
        getMe: async (token) =>
          token === 'Bearer valid-token'
            ? ok({
                id: '11111111-1111-4111-8111-111111111111',
                email: 'ada@sunrise.edu',
                displayName: 'Ada',
                createdAt: '2026-11-25T00:00:00.000Z',
              })
            : err({ code: 'UNAUTHORIZED', message: 'Authentication required' }),
      },
      { search: searchSpy },
    );

    try {
      const unauthRes = await app.inject({
        method: 'POST',
        url: '/literature/search',
        payload: { query: 'federated search' },
      });
      expect(unauthRes.statusCode).toBe(401);
      expect(searchSpy).not.toHaveBeenCalled();

      const authRes = await app.inject({
        method: 'POST',
        url: '/literature/search',
        headers: { authorization: 'Bearer valid-token' },
        payload: { query: 'federated search' },
      });
      expect(authRes.statusCode).toBe(200);
      expect(searchSpy).toHaveBeenCalledTimes(1);
      const body = authRes.json() as { readonly ok?: boolean; readonly value?: unknown };
      expect(body.ok).toBe(true);
      expect(FederatedSearchResponseSchema.safeParse(body.value).success).toBe(true);
    } finally {
      await app.close();
    }
  });
});
