import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DownloadFileResponseSchema,
  FilePreviewResponseSchema,
  MAX_UPLOAD_BYTES,
  PHASE1_IPC_CHANNELS,
  ProjectFileNodeSchema,
  type DownloadFileResponse,
  type FilePreviewResponse,
  type ProjectFileNode,
  type ProjectRole,
  type Result,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface FileActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

interface FileExplorerServiceLike {
  readonly createFolder: (
    actor: FileActor,
    input: { readonly projectId: string; readonly parentId: string | null; readonly name: string },
  ) => Promise<Result<ProjectFileNode>>;
  readonly uploadFile: (
    actor: FileActor,
    input: {
      readonly projectId: string;
      readonly parentId: string | null;
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly contentBase64?: string;
    },
  ) => Promise<Result<ProjectFileNode>>;
  readonly renameFile: (
    actor: FileActor,
    input: { readonly fileId: string; readonly newName: string },
  ) => Promise<Result<ProjectFileNode>>;
  readonly moveFile: (
    actor: FileActor,
    input: { readonly fileId: string; readonly targetParentId: string | null },
  ) => Promise<Result<ProjectFileNode>>;
  readonly duplicateFile: (
    actor: FileActor,
    input: { readonly fileId: string; readonly newName?: string },
  ) => Promise<Result<ProjectFileNode>>;
  readonly deleteFile: (
    actor: FileActor,
    input: { readonly fileId: string; readonly softDelete?: boolean },
  ) => Promise<Result<{ readonly deleted: true }>>;
  readonly getDownloadUrl: (
    actor: FileActor,
    fileId: string,
  ) => Promise<Result<DownloadFileResponse>>;
  readonly previewFile: (actor: FileActor, fileId: string) => Promise<Result<FilePreviewResponse>>;
  readonly searchFiles: (
    actor: FileActor,
    input: { readonly projectId: string; readonly query: string },
  ) => Promise<Result<ProjectFileNode[]>>;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

async function assertFileLifecycle(
  explorer: FileExplorerServiceLike,
  projectId: string,
  editor: FileActor,
  viewer: FileActor,
): Promise<string> {
  const folder = await explorer.createFolder(editor, {
    projectId,
    parentId: null,
    name: 'datasets',
  });
  expect(folder.ok && ProjectFileNodeSchema.safeParse(folder.value).success).toBe(true);
  if (!folder.ok) {
    return '';
  }

  const uploaded = await explorer.uploadFile(editor, {
    projectId,
    parentId: folder.value.id,
    fileName: 'experiment.json',
    sizeBytes: 18,
    contentBase64: Buffer.from('{"accuracy":0.94}', 'utf8').toString('base64'),
  });
  expect(uploaded.ok && ProjectFileNodeSchema.safeParse(uploaded.value).success).toBe(true);
  if (!uploaded.ok) {
    return '';
  }

  const preview = await explorer.previewFile(viewer, uploaded.value.id);
  expect(preview.ok && FilePreviewResponseSchema.safeParse(preview.value).success).toBe(true);

  const download = await explorer.getDownloadUrl(viewer, uploaded.value.id);
  expect(download.ok && DownloadFileResponseSchema.safeParse(download.value).success).toBe(true);
  return uploaded.value.id;
}

async function assertFileMutationsAndGuards(
  explorer: FileExplorerServiceLike,
  projectId: string,
  fileId: string,
  editor: FileActor,
  viewer: FileActor,
): Promise<void> {
  const renamed = await explorer.renameFile(editor, { fileId, newName: 'metrics.json' });
  expect(renamed.ok && renamed.value.name === 'metrics.json').toBe(true);

  const duplicated = await explorer.duplicateFile(editor, {
    fileId,
    newName: 'metrics-copy.json',
  });
  expect(duplicated.ok).toBe(true);

  const moved = await explorer.moveFile(editor, { fileId, targetParentId: null });
  expect(moved.ok && moved.value.parentId === null).toBe(true);

  const search = await explorer.searchFiles(viewer, { projectId, query: 'metrics' });
  expect(search.ok && search.value.length >= 2).toBe(true);

  const viewerBlocked = await explorer.deleteFile(viewer, { fileId });
  expect(viewerBlocked.ok).toBe(false);
  if (!viewerBlocked.ok) {
    expect(viewerBlocked.error.code).toBe('FORBIDDEN');
  }

  const traversalBlocked = await explorer.uploadFile(editor, {
    projectId,
    parentId: null,
    fileName: '../evil.txt',
    sizeBytes: 5,
  });
  expect(traversalBlocked.ok).toBe(false);

  const oversizeBlocked = await explorer.uploadFile(editor, {
    projectId,
    parentId: null,
    fileName: 'too-large.pdf',
    sizeBytes: MAX_UPLOAD_BYTES + 1,
  });
  expect(oversizeBlocked.ok).toBe(false);
}

describe('Phase 1.3 Cloud file explorer and native OS IPC bridge acceptance', () => {
  it('provides SQL migration defining project_files table with S3 key and soft-delete columns', () => {
    const migrationsDir = join(REPO_ROOT, 'apps/api/src/db/migrations');
    expect(existsSync(migrationsDir)).toBe(true);

    const allSql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => readFileSync(join(migrationsDir, entry.name), 'utf8'))
      .join('\n');

    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+project_files/i);
    expect(allSql).toMatch(/s3_key/i);
    expect(allSql).toMatch(/deleted_at/i);
  });

  it('supports folder CRUD, upload, move, duplicate, download, preview, search, and rejects attacks', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/file-explorer-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/file-explorer-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryFileExplorerService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryFileExplorerService')) {
      return;
    }

    const factory = (
      loaded as { readonly createInMemoryFileExplorerService: () => FileExplorerServiceLike }
    ).createInMemoryFileExplorerService;
    const explorer = factory();

    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: FileActor = { userId: '22222222-2222-4222-8222-222222222222', role: 'editor' };
    const viewer: FileActor = { userId: '33333333-3333-4333-8333-333333333333', role: 'viewer' };

    const fileId = await assertFileLifecycle(explorer, projectId, editor, viewer);
    expect(fileId.length).toBeGreaterThan(0);
    if (fileId.length > 0) {
      await assertFileMutationsAndGuards(explorer, projectId, fileId, editor, viewer);
    }
  });

  it('validates Phase 1 IPC handlers with Zod and rejects malformed fs payloads before calling services', async () => {
    const routerPath = join(REPO_ROOT, 'apps/desktop/src/main/controllers/phase1-ipc-router.ts');
    expect(
      existsSync(routerPath),
      'Missing apps/desktop/src/main/controllers/phase1-ipc-router.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(routerPath).href);
    expect(hasFunctionProp(loaded, 'createPhase1IpcHandlers')).toBe(true);
    if (!hasFunctionProp(loaded, 'createPhase1IpcHandlers')) {
      return;
    }

    const saveFileSpy = vi.fn(async () => ({
      ok: true as const,
      value: { saved: true, canceled: false, savedFileName: 'paper.pdf' },
    }));

    const factory = (
      loaded as {
        readonly createPhase1IpcHandlers: (
          services: Record<string, unknown>,
        ) => Record<string, (payload?: unknown) => Promise<Result<unknown>>>;
      }
    ).createPhase1IpcHandlers;

    const handlers = factory({
      saveFile: saveFileSpy,
      pickFiles: vi.fn(async () => ({ ok: true, value: { canceled: true, files: [] } })),
      saveSession: vi.fn(async () => ({ ok: true, value: { completed: true } })),
      loadSession: vi.fn(async () => ({ ok: true, value: null })),
      clearSession: vi.fn(async () => ({ ok: true, value: { completed: true } })),
      getLayout: vi.fn(async () => ({ ok: true, value: null })),
      saveLayout: vi.fn(async (layout: unknown) => ({ ok: true, value: layout })),
      putArtifact: vi.fn(async (record: unknown) => ({ ok: true, value: record })),
      getArtifact: vi.fn(async () => ({ ok: true, value: null })),
      saveDraft: vi.fn(async () => ({ ok: true, value: null })),
      listDrafts: vi.fn(async () => ({ ok: true, value: [] })),
      clearDraft: vi.fn(async () => ({ ok: true, value: { completed: true } })),
    });

    const saveHandler = handlers[PHASE1_IPC_CHANNELS.FS_SAVE_FILE];
    expect(saveHandler).toBeDefined();
    if (!saveHandler) {
      return;
    }

    const rejected = await saveHandler({
      suggestedName: '../../escape.exe',
      contentBase64: 'SGVsbG8=',
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('VALIDATION_ERROR');
    }
    expect(saveFileSpy).not.toHaveBeenCalled();
  });
});
