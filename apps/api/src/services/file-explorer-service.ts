import { createHash, randomUUID } from 'node:crypto';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  canRolePerform,
  classifyFileByName,
  CreateFolderInputSchema,
  DeleteFileInputSchema,
  DownloadFileResponseSchema,
  DuplicateFileInputSchema,
  err,
  FilePreviewResponseSchema,
  MAX_PREVIEW_BYTES,
  MAX_UPLOAD_BYTES,
  MoveFileInputSchema,
  ok,
  ProjectFileNodeSchema,
  RenameFileInputSchema,
  SearchFilesInputSchema,
  UploadFileInputSchema,
  UuidSchema,
  validateSafeVirtualPath,
  type CreateFolderInput,
  type DownloadFileResponse,
  type DuplicateFileInput,
  type FileKind,
  type FilePreviewResponse,
  type MoveFileInput,
  type ProjectFileNode,
  type ProjectRole,
  type RenameFileInput,
  type Result,
  type SearchFilesInput,
  type UploadFileInput,
} from '@sunrise/shared';
import type { z } from 'zod';

export interface FileActor {
  readonly userId: string;
  readonly role: ProjectRole;
  readonly projectId?: string;
}

export interface ObjectStorageAdapter {
  readonly putObject: (key: string, body: Buffer, mimeType: string) => Promise<void>;
  readonly getObject: (key: string) => Promise<Buffer | null>;
  readonly copyObject: (sourceKey: string, targetKey: string) => Promise<void>;
  readonly deleteObject: (key: string) => Promise<void>;
  readonly getSignedDownloadUrl: (key: string, expiresInSeconds: number) => Promise<string>;
}

export interface FileExplorerService {
  readonly createFolder: (
    actor: FileActor,
    input: CreateFolderInput,
  ) => Promise<Result<ProjectFileNode>>;
  readonly uploadFile: (
    actor: FileActor,
    input: UploadFileInput,
  ) => Promise<Result<ProjectFileNode>>;
  readonly renameFile: (
    actor: FileActor,
    input: RenameFileInput,
  ) => Promise<Result<ProjectFileNode>>;
  readonly moveFile: (actor: FileActor, input: MoveFileInput) => Promise<Result<ProjectFileNode>>;
  readonly duplicateFile: (
    actor: FileActor,
    input: DuplicateFileInput,
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
    input: {
      readonly projectId: string;
      readonly query: string;
      readonly category?: SearchFilesInput['category'];
      readonly kind?: SearchFilesInput['kind'];
      readonly limit?: number;
    },
  ) => Promise<Result<ProjectFileNode[]>>;
}

const TEXT_PREVIEW_KINDS: ReadonlySet<FileKind> = new Set([
  'text',
  'markdown',
  'csv',
  'bibtex',
  'ris',
  'code',
  'mermaid',
  'document',
  'notebook',
]);

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

function formatZodError(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0]?.message;
  return issue && issue.trim().length > 0 ? issue.trim().slice(0, 500) : fallback;
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function buildS3Key(projectId: string, fileId: string, fileName: string): string {
  return `projects/${projectId}/${fileId}/${fileName}`;
}

function composeVirtualPath(parentPath: string | null, name: string): Result<string> {
  const raw = parentPath ? `${parentPath}/${name}` : name;
  return validateSafeVirtualPath(raw);
}

function deriveDuplicateName(originalName: string): string {
  const dotIndex = originalName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return `${originalName}-copy`;
  }
  return `${originalName.slice(0, dotIndex)}-copy${originalName.slice(dotIndex)}`;
}

async function readStreamToBuffer(body: unknown): Promise<Buffer> {
  if (
    typeof body === 'object' &&
    body !== null &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    const bytes: unknown = await body.transformToByteArray();
    if (bytes instanceof Uint8Array) {
      return Buffer.from(bytes);
    }
  }
  return Buffer.alloc(0);
}

export interface S3CommandExecutor {
  readonly send: (command: CopyObjectCommand) => Promise<unknown>;
}

export function encodeCopySource(bucket: string, sourceKey: string): string {
  const encodedKey = sourceKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${encodeURIComponent(bucket)}/${encodedKey}`;
}

export function createS3CopyHandler(
  executor: S3CommandExecutor,
  bucket: string,
): (sourceKey: string, targetKey: string) => Promise<void> {
  return async (sourceKey: string, targetKey: string): Promise<void> => {
    await executor.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: encodeCopySource(bucket, sourceKey),
        Key: targetKey,
      }),
    );
  };
}

export function createS3ObjectStorageAdapter(
  client: S3Client,
  bucket: string,
): ObjectStorageAdapter {
  const copyObject = createS3CopyHandler(client, bucket);
  return {
    putObject: async (key, body, mimeType) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
        }),
      );
    },
    getObject: async (key) => {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await readStreamToBuffer(res.Body);
      } catch {
        return null;
      }
    },
    copyObject,
    deleteObject: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    getSignedDownloadUrl: async (key, expiresInSeconds) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      }),
  };
}

export function createInMemoryObjectStorageAdapter(
  baseUrl = 'https://storage.sunrise.local',
): ObjectStorageAdapter {
  const objects = new Map<string, Buffer>();
  return {
    putObject: async (key, body) => {
      objects.set(key, Buffer.from(body));
    },
    getObject: async (key) => {
      const existing = objects.get(key);
      return existing ? Buffer.from(existing) : null;
    },
    copyObject: async (sourceKey, targetKey) => {
      const existing = objects.get(sourceKey);
      if (existing) {
        objects.set(targetKey, Buffer.from(existing));
      }
    },
    deleteObject: async (key) => {
      objects.delete(key);
    },
    getSignedDownloadUrl: async (key, expiresInSeconds) =>
      `${baseUrl}/${encodeURI(key)}?expiresIn=${expiresInSeconds}`,
  };
}

function assertRolePermission(actor: FileActor, action: 'read' | 'write_files'): Result<true> {
  if (!UuidSchema.safeParse(actor.userId).success) {
    return err({ code: 'UNAUTHORIZED', message: 'Valid actor userId is required' });
  }
  if (!canRolePerform(actor.role, action)) {
    return err({
      code: 'FORBIDDEN',
      message: `Role "${actor.role}" is not allowed to perform "${action}"`,
    });
  }
  return ok(true);
}

function parseAuthorizedInput<TOutput>(
  actor: FileActor,
  action: 'read' | 'write_files',
  schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  input: unknown,
  fallbackMessage: string,
): Result<TOutput> {
  const perm = assertRolePermission(actor, action);
  if (!perm.ok) {
    return perm;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: 'VALIDATION_ERROR',
      message: formatZodError(parsed.error, fallbackMessage),
    });
  }
  return ok(parsed.data);
}

function assertProjectScope(actor: FileActor, targetProjectId: string): Result<true> {
  if (actor.projectId !== undefined && actor.projectId !== targetProjectId) {
    return err({ code: 'FORBIDDEN', message: 'Actor is not authorized for target project' });
  }
  return ok(true);
}

function findActiveNode(
  nodes: Map<string, ProjectFileNode>,
  fileId: string,
  expectedProjectId?: string,
): Result<ProjectFileNode> {
  const existing = nodes.get(fileId);
  if (!existing || existing.deletedAt !== null) {
    return err({ code: 'NOT_FOUND', message: 'File or folder not found' });
  }
  if (expectedProjectId !== undefined && existing.projectId !== expectedProjectId) {
    return err({ code: 'NOT_FOUND', message: 'File or folder not found' });
  }
  return ok(existing);
}

function hasSiblingConflict(
  nodes: Map<string, ProjectFileNode>,
  projectId: string,
  parentId: string | null,
  name: string,
  excludeFileId?: string,
): boolean {
  const target = name.toLowerCase();
  for (const node of nodes.values()) {
    const sameLocation =
      node.projectId === projectId && node.parentId === parentId && node.deletedAt === null;
    if (sameLocation && node.id !== excludeFileId && node.name.toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

function isDescendantFolder(
  nodes: Map<string, ProjectFileNode>,
  ancestorId: string,
  candidateId: string | null,
): boolean {
  let cursor = candidateId;
  while (cursor !== null) {
    if (cursor === ancestorId) {
      return true;
    }
    cursor = nodes.get(cursor)?.parentId ?? null;
  }
  return false;
}

function computeDescendantPathUpdates(
  nodes: Map<string, ProjectFileNode>,
  oldPrefix: string,
  newPrefix: string,
  projectId: string,
  updatedAt: string,
): Result<ReadonlyArray<{ readonly id: string; readonly node: ProjectFileNode }>> {
  const prefixWithSlash = `${oldPrefix}/`;
  const updates: Array<{ readonly id: string; readonly node: ProjectFileNode }> = [];
  for (const [id, node] of nodes.entries()) {
    const isChild =
      node.projectId === projectId &&
      node.deletedAt === null &&
      node.virtualPath.startsWith(prefixWithSlash);
    if (!isChild) {
      continue;
    }
    const checked = validateSafeVirtualPath(
      `${newPrefix}${node.virtualPath.slice(oldPrefix.length)}`,
    );
    if (!checked.ok) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Descendant virtual path exceeds safety constraints',
      });
    }
    updates.push({ id, node: { ...node, virtualPath: checked.value, updatedAt } });
  }
  return ok(updates);
}

function applyNodeAndDescendantUpdates(
  nodes: Map<string, ProjectFileNode>,
  updated: ProjectFileNode,
  descendantUpdates: ReadonlyArray<{ readonly id: string; readonly node: ProjectFileNode }>,
): void {
  nodes.set(updated.id, updated);
  for (const entry of descendantUpdates) {
    nodes.set(entry.id, entry.node);
  }
}

function resolveActiveParent(
  nodes: Map<string, ProjectFileNode>,
  projectId: string,
  parentId: string | null,
): Result<ProjectFileNode | null> {
  if (parentId === null) {
    return ok(null);
  }
  const parent = nodes.get(parentId);
  if (!parent || parent.projectId !== projectId || parent.deletedAt !== null) {
    return err({ code: 'NOT_FOUND', message: 'Parent folder not found' });
  }
  if (!parent.isFolder) {
    return err({ code: 'VALIDATION_ERROR', message: 'Target parent must be a folder' });
  }
  return ok(parent);
}

function resolveTargetLocation(
  nodes: Map<string, ProjectFileNode>,
  projectId: string,
  parentId: string | null,
  name: string,
  excludeFileId?: string,
): Result<string> {
  const parentRes = resolveActiveParent(nodes, projectId, parentId);
  if (!parentRes.ok) {
    return parentRes;
  }
  if (hasSiblingConflict(nodes, projectId, parentId, name, excludeFileId)) {
    return err({ code: 'CONFLICT', message: 'An item with this name already exists here' });
  }
  return composeVirtualPath(parentRes.value?.virtualPath ?? null, name);
}

function decodeUploadBytes(contentBase64: string | undefined): Result<Buffer> {
  const payloadBuffer = contentBase64 ? Buffer.from(contentBase64, 'base64') : Buffer.alloc(0);
  if (payloadBuffer.length > MAX_UPLOAD_BYTES) {
    return err({ code: 'VALIDATION_ERROR', message: 'Decoded payload exceeds upload limit' });
  }
  return ok(payloadBuffer);
}

function collectDeletionTargets(
  nodes: Map<string, ProjectFileNode>,
  target: ProjectFileNode,
): string[] {
  const prefix = `${target.virtualPath}/`;
  const ids: string[] = [];
  for (const [id, node] of nodes.entries()) {
    const isDescendant =
      target.isFolder && node.projectId === target.projectId && node.virtualPath.startsWith(prefix);
    if (id === target.id || isDescendant) {
      ids.push(id);
    }
  }
  return ids;
}

async function applyDeletionToNodes(
  nodes: Map<string, ProjectFileNode>,
  storage: ObjectStorageAdapter,
  ids: readonly string[],
  softDelete: boolean,
  timestamp: string,
): Promise<void> {
  for (const id of ids) {
    const current = nodes.get(id);
    if (!current) {
      continue;
    }
    if (softDelete) {
      nodes.set(id, { ...current, deletedAt: timestamp, updatedAt: timestamp });
      continue;
    }
    if (current.s3Key !== null) {
      await storage.deleteObject(current.s3Key);
    }
    nodes.delete(id);
  }
}

function matchesSearchFilter(
  node: ProjectFileNode,
  filter: SearchFilesInput,
  queryLower: string,
): boolean {
  if (node.projectId !== filter.projectId || node.deletedAt !== null) {
    return false;
  }
  if (filter.category !== undefined && node.category !== filter.category) {
    return false;
  }
  if (filter.kind !== undefined && node.kind !== filter.kind) {
    return false;
  }
  if (queryLower.length === 0) {
    return true;
  }
  return (
    node.name.toLowerCase().includes(queryLower) ||
    node.virtualPath.toLowerCase().includes(queryLower)
  );
}

async function buildJsonPreview(
  node: ProjectFileNode,
  storage: ObjectStorageAdapter,
  s3Key: string,
): Promise<FilePreviewResponse> {
  const bytes = (await storage.getObject(s3Key)) ?? Buffer.alloc(0);
  const truncated = bytes.length > MAX_PREVIEW_BYTES;
  const rawText = bytes.subarray(0, MAX_PREVIEW_BYTES).toString('utf8');
  let formattedJson = rawText;
  try {
    formattedJson = JSON.stringify(JSON.parse(rawText), null, 2);
  } catch {
    formattedJson = rawText;
  }
  return FilePreviewResponseSchema.parse({
    previewType: 'json',
    fileId: node.id,
    mimeType: 'application/json',
    formattedJson,
    truncated,
  });
}

async function buildFilePreview(
  node: ProjectFileNode,
  storage: ObjectStorageAdapter,
): Promise<Result<FilePreviewResponse>> {
  if (node.isFolder || node.s3Key === null) {
    return err({ code: 'VALIDATION_ERROR', message: 'Folders cannot be previewed as files' });
  }
  if (node.kind === 'image') {
    const previewUrl = await storage.getSignedDownloadUrl(
      node.s3Key,
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    return ok(
      FilePreviewResponseSchema.parse({
        previewType: 'image',
        fileId: node.id,
        mimeType: node.mimeType,
        previewUrl,
        truncated: false,
      }),
    );
  }
  if (node.kind === 'json') {
    return ok(await buildJsonPreview(node, storage, node.s3Key));
  }
  if (TEXT_PREVIEW_KINDS.has(node.kind)) {
    const bytes = (await storage.getObject(node.s3Key)) ?? Buffer.alloc(0);
    return ok(
      FilePreviewResponseSchema.parse({
        previewType: 'text',
        fileId: node.id,
        mimeType: node.mimeType,
        content: bytes.subarray(0, MAX_PREVIEW_BYTES).toString('utf8'),
        truncated: bytes.length > MAX_PREVIEW_BYTES,
      }),
    );
  }
  return ok(
    FilePreviewResponseSchema.parse({
      previewType: 'binary',
      fileId: node.id,
      mimeType: node.mimeType,
      sizeBytes: node.sizeBytes,
      truncated: false,
    }),
  );
}

export function createFileExplorerService(
  storage: ObjectStorageAdapter,
  now: () => Date = () => new Date(),
): FileExplorerService {
  const nodes = new Map<string, ProjectFileNode>();

  return {
    createFolder: async (actor, input): Promise<Result<ProjectFileNode>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        CreateFolderInputSchema,
        input,
        'Invalid folder payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const scope = assertProjectScope(actor, validated.value.projectId);
      if (!scope.ok) {
        return scope;
      }
      const pathRes = resolveTargetLocation(
        nodes,
        validated.value.projectId,
        validated.value.parentId,
        validated.value.name,
      );
      if (!pathRes.ok) {
        return pathRes;
      }
      const timestamp = now().toISOString();
      const folder = ProjectFileNodeSchema.parse({
        id: randomUUID(),
        projectId: validated.value.projectId,
        parentId: validated.value.parentId,
        name: validated.value.name,
        virtualPath: pathRes.value,
        isFolder: true,
        kind: 'folder',
        category: 'general',
        mimeType: 'inode/directory',
        sizeBytes: 0,
        s3Key: null,
        checksumSha256: null,
        version: 1,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
      nodes.set(folder.id, folder);
      return ok(folder);
    },

    uploadFile: async (actor, input): Promise<Result<ProjectFileNode>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        UploadFileInputSchema,
        input,
        'Invalid upload payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const scope = assertProjectScope(actor, validated.value.projectId);
      if (!scope.ok) {
        return scope;
      }
      const pathRes = resolveTargetLocation(
        nodes,
        validated.value.projectId,
        validated.value.parentId,
        validated.value.fileName,
      );
      if (!pathRes.ok) {
        return pathRes;
      }
      const bytesRes = decodeUploadBytes(validated.value.contentBase64);
      if (!bytesRes.ok) {
        return bytesRes;
      }
      const classified = classifyFileByName(validated.value.fileName);
      const fileId = randomUUID();
      const s3Key = buildS3Key(validated.value.projectId, fileId, validated.value.fileName);
      const mimeType = validated.value.mimeType ?? classified.mimeType;
      const effectiveSizeBytes =
        validated.value.contentBase64 !== undefined
          ? bytesRes.value.length
          : validated.value.sizeBytes;
      await storage.putObject(s3Key, bytesRes.value, mimeType);
      const timestamp = now().toISOString();
      const fileNode = ProjectFileNodeSchema.parse({
        id: fileId,
        projectId: validated.value.projectId,
        parentId: validated.value.parentId,
        name: validated.value.fileName,
        virtualPath: pathRes.value,
        isFolder: false,
        kind: classified.kind,
        category: classified.category,
        mimeType,
        sizeBytes: effectiveSizeBytes,
        s3Key,
        checksumSha256: sha256Buffer(bytesRes.value),
        version: 1,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
      nodes.set(fileNode.id, fileNode);
      return ok(fileNode);
    },

    renameFile: async (actor, input): Promise<Result<ProjectFileNode>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        RenameFileInputSchema,
        input,
        'Invalid rename payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const existingRes = findActiveNode(nodes, validated.value.fileId, actor.projectId);
      if (!existingRes.ok) {
        return existingRes;
      }
      const existing = existingRes.value;
      const pathRes = resolveTargetLocation(
        nodes,
        existing.projectId,
        existing.parentId,
        validated.value.newName,
        existing.id,
      );
      if (!pathRes.ok) {
        return pathRes;
      }
      const updatedAt = now().toISOString();
      const descendantUpdatesRes = existing.isFolder
        ? computeDescendantPathUpdates(
            nodes,
            existing.virtualPath,
            pathRes.value,
            existing.projectId,
            updatedAt,
          )
        : ok([]);
      if (!descendantUpdatesRes.ok) {
        return descendantUpdatesRes;
      }
      const classified = existing.isFolder ? null : classifyFileByName(validated.value.newName);
      const updated = ProjectFileNodeSchema.parse({
        ...existing,
        name: validated.value.newName,
        virtualPath: pathRes.value,
        kind: classified ? classified.kind : existing.kind,
        category: classified ? classified.category : existing.category,
        mimeType: classified ? classified.mimeType : existing.mimeType,
        version: existing.version + 1,
        updatedAt,
      });
      applyNodeAndDescendantUpdates(nodes, updated, descendantUpdatesRes.value);
      return ok(updated);
    },

    moveFile: async (actor, input): Promise<Result<ProjectFileNode>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        MoveFileInputSchema,
        input,
        'Invalid move payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const existingRes = findActiveNode(nodes, validated.value.fileId, actor.projectId);
      if (!existingRes.ok) {
        return existingRes;
      }
      const existing = existingRes.value;
      if (
        existing.isFolder &&
        isDescendantFolder(nodes, existing.id, validated.value.targetParentId)
      ) {
        return err({ code: 'VALIDATION_ERROR', message: 'Cannot move a folder into itself' });
      }
      const pathRes = resolveTargetLocation(
        nodes,
        existing.projectId,
        validated.value.targetParentId,
        existing.name,
        existing.id,
      );
      if (!pathRes.ok) {
        return pathRes;
      }
      const updatedAt = now().toISOString();
      const descendantUpdatesRes = existing.isFolder
        ? computeDescendantPathUpdates(
            nodes,
            existing.virtualPath,
            pathRes.value,
            existing.projectId,
            updatedAt,
          )
        : ok([]);
      if (!descendantUpdatesRes.ok) {
        return descendantUpdatesRes;
      }
      const updated = ProjectFileNodeSchema.parse({
        ...existing,
        parentId: validated.value.targetParentId,
        virtualPath: pathRes.value,
        version: existing.version + 1,
        updatedAt,
      });
      applyNodeAndDescendantUpdates(nodes, updated, descendantUpdatesRes.value);
      return ok(updated);
    },

    duplicateFile: async (actor, input): Promise<Result<ProjectFileNode>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        DuplicateFileInputSchema,
        input,
        'Invalid duplicate payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const sourceRes = findActiveNode(nodes, validated.value.fileId, actor.projectId);
      if (!sourceRes.ok) {
        return sourceRes;
      }
      const source = sourceRes.value;
      if (source.isFolder || source.s3Key === null) {
        return err({ code: 'VALIDATION_ERROR', message: 'Only files can be duplicated directly' });
      }
      const targetParentId =
        validated.value.targetParentId !== undefined
          ? validated.value.targetParentId
          : source.parentId;
      const nextName = validated.value.newName ?? deriveDuplicateName(source.name);
      const pathRes = resolveTargetLocation(nodes, source.projectId, targetParentId, nextName);
      if (!pathRes.ok) {
        return pathRes;
      }
      const copyId = randomUUID();
      const copyKey = buildS3Key(source.projectId, copyId, nextName);
      await storage.copyObject(source.s3Key, copyKey);
      const timestamp = now().toISOString();
      const duplicated = ProjectFileNodeSchema.parse({
        ...source,
        id: copyId,
        parentId: targetParentId,
        name: nextName,
        virtualPath: pathRes.value,
        s3Key: copyKey,
        version: 1,
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
      nodes.set(duplicated.id, duplicated);
      return ok(duplicated);
    },

    deleteFile: async (actor, input): Promise<Result<{ readonly deleted: true }>> => {
      const validated = parseAuthorizedInput(
        actor,
        'write_files',
        DeleteFileInputSchema,
        input,
        'Invalid delete payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const targetRes = findActiveNode(nodes, validated.value.fileId, actor.projectId);
      if (!targetRes.ok) {
        return targetRes;
      }
      const ids = collectDeletionTargets(nodes, targetRes.value);
      await applyDeletionToNodes(
        nodes,
        storage,
        ids,
        validated.value.softDelete,
        now().toISOString(),
      );
      return ok({ deleted: true });
    },

    getDownloadUrl: async (actor, fileId): Promise<Result<DownloadFileResponse>> => {
      const validated = parseAuthorizedInput(actor, 'read', UuidSchema, fileId, 'Invalid fileId');
      if (!validated.ok) {
        return validated;
      }
      const nodeRes = findActiveNode(nodes, validated.value, actor.projectId);
      if (!nodeRes.ok || nodeRes.value.isFolder || nodeRes.value.s3Key === null) {
        return err({ code: 'NOT_FOUND', message: 'Downloadable file not found' });
      }
      const downloadUrl = await storage.getSignedDownloadUrl(
        nodeRes.value.s3Key,
        DEFAULT_SIGNED_URL_TTL_SECONDS,
      );
      const expiresAt = new Date(
        now().getTime() + DEFAULT_SIGNED_URL_TTL_SECONDS * 1000,
      ).toISOString();
      return ok(
        DownloadFileResponseSchema.parse({
          fileId: nodeRes.value.id,
          fileName: nodeRes.value.name,
          mimeType: nodeRes.value.mimeType,
          sizeBytes: nodeRes.value.sizeBytes,
          downloadUrl,
          expiresAt,
        }),
      );
    },

    previewFile: async (actor, fileId): Promise<Result<FilePreviewResponse>> => {
      const validated = parseAuthorizedInput(actor, 'read', UuidSchema, fileId, 'Invalid fileId');
      if (!validated.ok) {
        return validated;
      }
      const nodeRes = findActiveNode(nodes, validated.value, actor.projectId);
      if (!nodeRes.ok) {
        return nodeRes;
      }
      return buildFilePreview(nodeRes.value, storage);
    },

    searchFiles: async (actor, input): Promise<Result<ProjectFileNode[]>> => {
      const validated = parseAuthorizedInput(
        actor,
        'read',
        SearchFilesInputSchema,
        input,
        'Invalid search payload',
      );
      if (!validated.ok) {
        return validated;
      }
      const scope = assertProjectScope(actor, validated.value.projectId);
      if (!scope.ok) {
        return scope;
      }
      const queryLower = validated.value.query.toLowerCase();
      const matches = Array.from(nodes.values()).filter((node) =>
        matchesSearchFilter(node, validated.value, queryLower),
      );
      matches.sort((a, b) => a.virtualPath.localeCompare(b.virtualPath));
      return ok(matches.slice(0, validated.value.limit));
    },
  };
}

export function createInMemoryFileExplorerService(now?: () => Date): FileExplorerService {
  return createFileExplorerService(createInMemoryObjectStorageAdapter(), now);
}
