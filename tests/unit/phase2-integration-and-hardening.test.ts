import { readFileSync } from 'node:fs';
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
  createIngestionService,
  parseXmpPacketMetadata,
} from '../../apps/api/src/services/ingestion-service.js';
import {
  createLiteratureSearchService,
  parsePubMedXmlCandidates,
} from '../../apps/api/src/services/literature-service.js';
import { createInMemoryPdfAnnotationService } from '../../apps/api/src/services/pdf-annotation-service.js';
import { createInMemoryProjectService } from '../../apps/api/src/services/project-service.js';
import { createInMemoryReferenceService } from '../../apps/api/src/services/reference-service.js';
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

describe('Phase 2 integration and bundled Phase 1 hardening carry-forwards', () => {
  it('enforces tightened production CSP with worker-src self and splits dev vs production navigation origins', () => {
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
    expect(workerUrl).toContain('pdf.worker.min.mjs');
    expect(workerUrl.startsWith('https://')).toBe(false);
  });

  it('commits and rolls back PoolClient transactions via withTransaction and uses FOR UPDATE during refresh rotation', async () => {
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

    const refRepo = createPostgresReferenceRepository(fakePool);
    expect(typeof refRepo.runInTransaction).toBe('function');
  });

  it('prevents concurrent refresh token double-spend in memory and verifies SQL migration indexes', async () => {
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
    const okCount = [first, second].filter((item) => item.ok).length;
    expect(okCount).toBe(1);

    const migrationSql = readFileSync(
      join(REPO_ROOT, 'apps/api/src/db/migrations/0003_references_and_pdf_annotations.sql'),
      'utf8',
    );
    expect(migrationSql).toContain('uq_project_files_active_sibling');
    expect(migrationSql).toContain('WHERE deleted_at IS NULL');
    expect(migrationSql).toContain('uq_project_references_project_cite_key');
    expect(migrationSql).toContain('uq_project_references_project_doi');
    expect(migrationSql).toContain('WHERE doi IS NOT NULL');
  });

  it('parses PubMed XML and PDF XMP packets and serves Phase 2 HTTP routes with RBAC', async () => {
    const pubmedResults = parsePubMedXmlCandidates(SAMPLE_PUBMED_XML);
    expect(pubmedResults).toHaveLength(1);
    expect(pubmedResults[0]?.doi).toBe('10.1093/jbd/2025.001');
    expect(pubmedResults[0]?.authors[0]?.family).toBe('Patel');

    const xmp = parseXmpPacketMetadata(SAMPLE_XMP_XML);
    expect(xmp.xmpTitle).toBe('XMP Extracted Paper Title');
    expect(xmp.xmpAuthors).toEqual(['Mei Lin']);
    expect(xmp.xmpDoi).toBe('10.1145/3544548.3589999');

    const authService = createInMemoryAuthService();
    const owner = await authService.signup({
      email: 'p2-owner@sunrise.edu',
      password: 'OwnerPassword!2026',
      displayName: 'Dr. Owner',
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) {
      return;
    }
    const projectService = createInMemoryProjectService([owner.value.user]);
    const fileExplorerService = createInMemoryFileExplorerService();
    const referenceService = createInMemoryReferenceService();
    const literatureService = createLiteratureSearchService({
      adapters: {
        openalex: async () => pubmedResults,
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
    const pdfAnnotationService = createInMemoryPdfAnnotationService();

    const app = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
      { authService, projectService, fileExplorerService },
      { literatureService, referenceService, ingestionService, pdfAnnotationService },
    );

    const authHeader = { authorization: `Bearer ${owner.value.tokens.accessToken}` };
    const searchRes = await app.inject({
      method: 'POST',
      url: '/literature/search',
      headers: authHeader,
      payload: { query: 'clinical literature' },
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().value.results).toHaveLength(1);

    const projectRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeader,
      payload: { name: 'Phase 2 Study' },
    });
    const projectId: string = projectRes.json().value.id;

    const createRefRes = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/references`,
      headers: authHeader,
      payload: { title: 'API Reference', year: 2025 },
    });
    expect(createRefRes.statusCode).toBe(201);

    const fileId = '22222222-2222-4222-8222-222222222222';
    const annRes = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/files/${fileId}/annotations`,
      headers: authHeader,
      payload: {
        pageNumber: 1,
        selectedText: 'Key sentence',
        rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
      },
    });
    expect(annRes.statusCode).toBe(201);

    await app.close();
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
