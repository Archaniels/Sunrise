import { DEFAULT_COLUMN_WIDTHS, MAX_UPLOAD_BYTES } from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../apps/api/src/server.js';
import { createInMemoryAuthService } from '../../apps/api/src/services/auth-service.js';
import { createInMemoryFileExplorerService } from '../../apps/api/src/services/file-explorer-service.js';
import { createInMemoryProjectService } from '../../apps/api/src/services/project-service.js';
import { createConnectivitySyncService } from '../../apps/desktop/src/main/services/connectivity-sync-service.js';
import { createKeychainSessionService } from '../../apps/desktop/src/main/services/keychain-session-service.js';
import { createInMemoryLayoutStoreService } from '../../apps/desktop/src/main/services/layout-store-service.js';
import { createNativeFsService } from '../../apps/desktop/src/main/services/native-fs-service.js';
import { createPhase1PreloadApi } from '../../apps/desktop/src/preload/expose-api.js';

describe('Phase 1 end-to-end API routes, RBAC, native bridge, and offline guardrails', () => {
  it('enforces auth, RBAC, and file explorer HTTP routes through Fastify', async () => {
    const authService = createInMemoryAuthService();
    const ownerSignup = await authService.signup({
      email: 'owner@sunrise.edu',
      password: 'OwnerPassword!2026',
      displayName: 'Dr. Owner',
    });
    const viewerSignup = await authService.signup({
      email: 'viewer@sunrise.edu',
      password: 'ViewerPassword!2026',
      displayName: 'Student Viewer',
    });
    expect(ownerSignup.ok && viewerSignup.ok).toBe(true);
    if (!ownerSignup.ok || !viewerSignup.ok) {
      return;
    }

    const projectService = createInMemoryProjectService([
      ownerSignup.value.user,
      viewerSignup.value.user,
    ]);
    const fileExplorerService = createInMemoryFileExplorerService();

    const app = createApiServer(
      {
        checkPostgres: async () => 2,
        checkPgvector: async () => 1,
        checkS3: async () => 3,
      },
      '0.1.0',
      { authService, projectService, fileExplorerService },
    );

    const unauthMe = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(unauthMe.statusCode).toBe(401);

    const createProjectRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${ownerSignup.value.tokens.accessToken}` },
      payload: { name: 'Genomics Study' },
    });
    expect(createProjectRes.statusCode).toBe(201);
    const projectId: string = createProjectRes.json().value.id;

    const addViewerRes = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${ownerSignup.value.tokens.accessToken}` },
      payload: { email: 'viewer@sunrise.edu', role: 'viewer' },
    });
    expect(addViewerRes.statusCode).toBe(201);

    const uploadRes = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/files`,
      headers: { authorization: `Bearer ${ownerSignup.value.tokens.accessToken}` },
      payload: {
        parentId: null,
        fileName: 'notes.md',
        sizeBytes: 12,
        contentBase64: Buffer.from('# Lab Notes\n', 'utf8').toString('base64'),
      },
    });
    expect(uploadRes.statusCode).toBe(201);
    const fileId: string = uploadRes.json().value.id;

    const viewerPreview = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/files/${fileId}/preview`,
      headers: { authorization: `Bearer ${viewerSignup.value.tokens.accessToken}` },
    });
    expect(viewerPreview.statusCode).toBe(200);
    expect(viewerPreview.json().value.previewType).toBe('text');

    const viewerDelete = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}/files/${fileId}`,
      headers: { authorization: `Bearer ${viewerSignup.value.tokens.accessToken}` },
      payload: {},
    });
    expect(viewerDelete.statusCode).toBe(403);

    await app.close();
  });

  it('refuses plaintext storage when keychain encryption is unavailable and rejects invalid layouts', async () => {
    const keychain = createKeychainSessionService({
      isEncryptionAvailable: () => false,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (cipher) => cipher.toString('utf8'),
      writeBlob: vi.fn(async () => undefined),
      readBlob: vi.fn(async () => null),
      deleteBlob: vi.fn(async () => undefined),
    });

    const saveAttempt = await keychain.saveSession({
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'ada@uni.edu',
      accessToken: 'secret-access-token-1234',
      refreshToken: 'secret-refresh-token-1234',
      expiresAt: '2026-11-24T12:00:00.000Z',
    });
    expect(saveAttempt.ok).toBe(false);
    if (!saveAttempt.ok) {
      expect(saveAttempt.error.code).toBe('SECURITY_POLICY_VIOLATION');
    }

    const store = createInMemoryLayoutStoreService();
    const invalidLayout = await store.saveLayout({
      projectId: '11111111-1111-4111-8111-111111111111',
      activeCategory: 'overview',
      tabs: [],
      activeTabId: null,
      columns: { ...DEFAULT_COLUMN_WIDTHS, leftSidebarPx: 50 },
    });
    expect(invalidLayout.ok).toBe(false);
    if (!invalidLayout.ok) {
      expect(invalidLayout.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('issues opaque tokens in native FS bridge, blocks offline reconciliation, and validates preload inputs', async () => {
    const writeFileBytes = vi.fn(async () => undefined);
    const nativeFs = createNativeFsService({
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: ['/Users/researcher/papers/study.pdf'],
      }),
      showSaveDialog: async () => ({
        canceled: false,
        filePath: '/Users/researcher/exports/report.md',
      }),
      statFileSize: async () => 2048,
      writeFileBytes,
    });

    const picked = await nativeFs.pickFiles({ multiple: true });
    expect(picked.ok).toBe(true);
    if (picked.ok) {
      expect(picked.value.files).toHaveLength(1);
      const token = picked.value.files[0]?.fileToken ?? '';
      expect(token).not.toContain('/Users/researcher');
      expect(nativeFs.resolveFileToken(token)).toBe('/Users/researcher/papers/study.pdf');
    }

    const saved = await nativeFs.saveFile({
      suggestedName: 'report.md',
      contentBase64: Buffer.from('# Report', 'utf8').toString('base64'),
    });
    expect(saved.ok && saved.value.saved).toBe(true);
    expect(writeFileBytes).toHaveBeenCalledTimes(1);

    const oversizeFs = createNativeFsService({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/huge.pdf'] }),
      showSaveDialog: async () => ({ canceled: true }),
      statFileSize: async () => MAX_UPLOAD_BYTES + 1,
      writeFileBytes,
    });
    const oversizePick = await oversizeFs.pickFiles({ multiple: false });
    expect(oversizePick.ok).toBe(false);

    const syncService = createConnectivitySyncService(
      {
        listDrafts: async () => [],
        getRemoteVersion: async () => 1,
        pushDraft: async () => 2,
        clearDraft: async () => undefined,
      },
      'offline',
    );
    const offlineSync = await syncService.reconcileDrafts('11111111-1111-4111-8111-111111111111');
    expect(offlineSync.ok).toBe(false);
    if (!offlineSync.ok) {
      expect(offlineSync.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }

    const invoke = vi.fn(async () => ({ ok: true, value: { completed: true } }));
    const preloadApi = createPhase1PreloadApi(invoke);
    const badSave = await preloadApi.files.saveFile({
      suggestedName: '../escape.sh',
      contentBase64: 'SGVsbG8=',
    });
    expect(badSave.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
