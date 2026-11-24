import { DEFAULT_COLUMN_WIDTHS, MAX_UPLOAD_BYTES } from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../../apps/api/src/server.js';
import { createInMemoryAuthService } from '../../apps/api/src/services/auth-service.js';
import {
  createFileExplorerService,
  createInMemoryFileExplorerService,
  createInMemoryObjectStorageAdapter,
  createS3CopyHandler,
  encodeCopySource,
} from '../../apps/api/src/services/file-explorer-service.js';
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

  it('blocks cross-project BOLA on all :fileId endpoints with HTTP 404 (F1)', async () => {
    const authService = createInMemoryAuthService();
    const aliceSignup = await authService.signup({
      email: 'alice@sunrise.edu',
      password: 'AlicePassword!2026',
      displayName: 'Dr. Alice',
    });
    const bobSignup = await authService.signup({
      email: 'bob@sunrise.edu',
      password: 'BobPassword!2026',
      displayName: 'Dr. Bob',
    });
    expect(aliceSignup.ok && bobSignup.ok).toBe(true);
    if (!aliceSignup.ok || !bobSignup.ok) {
      return;
    }

    const projectService = createInMemoryProjectService([
      aliceSignup.value.user,
      bobSignup.value.user,
    ]);
    const fileExplorerService = createInMemoryFileExplorerService();
    const app = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
      { authService, projectService, fileExplorerService },
    );

    const aliceHeader = { authorization: `Bearer ${aliceSignup.value.tokens.accessToken}` };
    const bobHeader = { authorization: `Bearer ${bobSignup.value.tokens.accessToken}` };

    const projectARes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: aliceHeader,
      payload: { name: 'Project A' },
    });
    const projectBRes = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bobHeader,
      payload: { name: 'Project B' },
    });
    const projectAId: string = projectARes.json().value.id;
    const projectBId: string = projectBRes.json().value.id;

    const bobUpload = await app.inject({
      method: 'POST',
      url: `/projects/${projectBId}/files`,
      headers: bobHeader,
      payload: {
        parentId: null,
        fileName: 'secret-results.json',
        sizeBytes: 17,
        contentBase64: Buffer.from('{"secret":true}', 'utf8').toString('base64'),
      },
    });
    expect(bobUpload.statusCode).toBe(201);
    const bobFileId: string = bobUpload.json().value.id;

    const downloadAttempt = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/files/${bobFileId}/download`,
      headers: aliceHeader,
    });
    expect(downloadAttempt.statusCode).toBe(404);

    const previewAttempt = await app.inject({
      method: 'GET',
      url: `/projects/${projectAId}/files/${bobFileId}/preview`,
      headers: aliceHeader,
    });
    expect(previewAttempt.statusCode).toBe(404);

    const renameAttempt = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectAId}/files/${bobFileId}/rename`,
      headers: aliceHeader,
      payload: { newName: 'hijacked.json' },
    });
    expect(renameAttempt.statusCode).toBe(404);

    const moveAttempt = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectAId}/files/${bobFileId}/move`,
      headers: aliceHeader,
      payload: { targetParentId: null },
    });
    expect(moveAttempt.statusCode).toBe(404);

    const duplicateAttempt = await app.inject({
      method: 'POST',
      url: `/projects/${projectAId}/files/${bobFileId}/duplicate`,
      headers: aliceHeader,
      payload: { newName: 'stolen.json' },
    });
    expect(duplicateAttempt.statusCode).toBe(404);

    const deleteAttempt = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectAId}/files/${bobFileId}`,
      headers: aliceHeader,
      payload: {},
    });
    expect(deleteAttempt.statusCode).toBe(404);

    await app.close();
  });

  it('keeps parent and descendants unchanged when rename or move overflows descendant virtualPath (F2)', async () => {
    const explorer = createInMemoryFileExplorerService();
    const projectId = '11111111-1111-4111-8111-111111111111';
    const actor = { userId: '22222222-2222-4222-8222-222222222222', role: 'owner' as const };

    const rootFolder = await explorer.createFolder(actor, {
      projectId,
      parentId: null,
      name: 'a'.repeat(180),
    });
    expect(rootFolder.ok).toBe(true);
    if (!rootFolder.ok) {
      return;
    }

    const childFolder = await explorer.createFolder(actor, {
      projectId,
      parentId: rootFolder.value.id,
      name: 'b'.repeat(180),
    });
    expect(childFolder.ok).toBe(true);
    if (!childFolder.ok) {
      return;
    }

    const leafFile = await explorer.uploadFile(actor, {
      projectId,
      parentId: childFolder.value.id,
      fileName: `${'c'.repeat(130)}.txt`,
      sizeBytes: 4,
      contentBase64: Buffer.from('data', 'utf8').toString('base64'),
    });
    expect(leafFile.ok).toBe(true);
    if (!leafFile.ok) {
      return;
    }

    const overflowRename = await explorer.renameFile(actor, {
      fileId: rootFolder.value.id,
      newName: 'x'.repeat(240),
    });
    expect(overflowRename.ok).toBe(false);
    if (!overflowRename.ok) {
      expect(overflowRename.error.code).toBe('VALIDATION_ERROR');
    }

    const deepTarget = await explorer.createFolder(actor, {
      projectId,
      parentId: null,
      name: 'z'.repeat(100),
    });
    expect(deepTarget.ok).toBe(true);
    if (!deepTarget.ok) {
      return;
    }

    const overflowMove = await explorer.moveFile(actor, {
      fileId: rootFolder.value.id,
      targetParentId: deepTarget.value.id,
    });
    expect(overflowMove.ok).toBe(false);
    if (!overflowMove.ok) {
      expect(overflowMove.error.code).toBe('VALIDATION_ERROR');
    }

    const afterSearch = await explorer.searchFiles(actor, { projectId, query: '' });
    expect(afterSearch.ok).toBe(true);
    if (afterSearch.ok) {
      const storedRoot = afterSearch.value.find((item) => item.id === rootFolder.value.id);
      const storedLeaf = afterSearch.value.find((item) => item.id === leafFile.value.id);
      expect(storedRoot?.virtualPath).toBe(rootFolder.value.virtualPath);
      expect(storedLeaf?.virtualPath).toBe(leafFile.value.virtualPath);
    }
  });

  it('URI-encodes bucket and path segments in S3 CopySource for special characters (F3)', async () => {
    const capturedCopySources: string[] = [];
    const copyObject = createS3CopyHandler(
      {
        send: async (command: unknown) => {
          if (typeof command === 'object' && command !== null && 'input' in command) {
            const input = Reflect.get(command, 'input');
            if (typeof input === 'object' && input !== null && 'CopySource' in input) {
              const value = Reflect.get(input, 'CopySource');
              if (typeof value === 'string') {
                capturedCopySources.push(value);
              }
            }
          }
          return {};
        },
      },
      'sunrise-artifacts',
    );

    const baseStorage = createInMemoryObjectStorageAdapter();
    const explorer = createFileExplorerService({
      ...baseStorage,
      copyObject,
    });
    const projectId = '11111111-1111-4111-8111-111111111111';
    const actor = { userId: '22222222-2222-4222-8222-222222222222', role: 'owner' as const };

    const uploaded = await explorer.uploadFile(actor, {
      projectId,
      parentId: null,
      fileName: 'My Paper (2025) #1.pdf',
      sizeBytes: 4,
      contentBase64: Buffer.from('%PDF', 'utf8').toString('base64'),
    });
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok || !uploaded.value.s3Key) {
      return;
    }

    const duplicated = await explorer.duplicateFile(actor, {
      fileId: uploaded.value.id,
      newName: 'My Paper (2025) #1-copy.pdf',
    });
    expect(duplicated.ok).toBe(true);
    expect(capturedCopySources).toHaveLength(1);
    const copySource = capturedCopySources[0] ?? '';
    expect(copySource).toBe(encodeCopySource('sunrise-artifacts', uploaded.value.s3Key));
    expect(copySource).toContain('My%20Paper%20(2025)%20%231.pdf');
    expect(copySource).not.toContain(' ');
    expect(copySource).not.toContain('#');
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

  it('issues opaque tokens, sanitizes OS path errors (F4), blocks offline sync, and validates preload inputs', async () => {
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

    const eaccesFs = createNativeFsService({
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: ['/Users/private-researcher/secret/data.csv'],
      }),
      showSaveDialog: async () => ({
        canceled: false,
        filePath: '/Users/private-researcher/protected/out.md',
      }),
      statFileSize: async () => {
        throw new Error(
          "EACCES: permission denied, stat '/Users/private-researcher/secret/data.csv'",
        );
      },
      writeFileBytes: async () => {
        throw new Error(
          "EACCES: permission denied, open '/Users/private-researcher/protected/out.md'",
        );
      },
    });

    const statErr = await eaccesFs.pickFiles({ multiple: false });
    expect(statErr.ok).toBe(false);
    if (!statErr.ok) {
      expect(statErr.error.code).toBe('INTERNAL_ERROR');
      expect(statErr.error.message).not.toContain('private-researcher');
      expect(statErr.error.message).not.toContain('/Users/');
    }

    const writeErr = await eaccesFs.saveFile({
      suggestedName: 'out.md',
      contentBase64: Buffer.from('hello', 'utf8').toString('base64'),
    });
    expect(writeErr.ok).toBe(false);
    if (!writeErr.ok) {
      expect(writeErr.error.code).toBe('INTERNAL_ERROR');
      expect(writeErr.error.message).not.toContain('private-researcher');
      expect(writeErr.error.message).not.toContain('/Users/');
    }

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
