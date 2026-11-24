import {
  CreateFolderInputSchema,
  DeleteFileInputSchema,
  DuplicateFileInputSchema,
  MoveFileInputSchema,
  RenameFileInputSchema,
  SearchFilesInputSchema,
  UploadFileInputSchema,
  UuidSchema,
  type ProjectAction,
} from '@sunrise/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { FileActor, FileExplorerService } from '../services/file-explorer-service.js';
import type { ProjectService } from '../services/project-service.js';
import { sendErrorReply } from './auth-controller.js';

function readUuidParam(params: unknown, key: string): string | null {
  if (typeof params === 'object' && params !== null && key in params) {
    const value = Reflect.get(params, key);
    if (typeof value === 'string' && UuidSchema.safeParse(value).success) {
      return value;
    }
  }
  return null;
}

async function resolveProjectActor(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  projectService: ProjectService,
  projectId: string,
  action: ProjectAction,
): Promise<FileActor | null> {
  const me = await authService.getMe(request.headers.authorization);
  if (!me.ok) {
    sendErrorReply(reply, me.error.code, me.error.message);
    return null;
  }
  const access = await projectService.assertAccess(me.value.id, projectId, action);
  if (!access.ok) {
    sendErrorReply(reply, access.error.code, access.error.message);
    return null;
  }
  return { userId: me.value.id, role: access.value.role };
}

export function registerFileRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
  fileExplorerService: FileExplorerService,
): void {
  app.post('/projects/:projectId/folders', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = CreateFolderInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid folder request',
      );
    }
    const result = await fileExplorerService.createFolder(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.post('/projects/:projectId/files', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = UploadFileInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid file upload request',
      );
    }
    const result = await fileExplorerService.uploadFile(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.post('/projects/:projectId/files/search', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'read',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = SearchFilesInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid search request',
      );
    }
    const result = await fileExplorerService.searchFiles(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.patch('/projects/:projectId/files/:fileId/rename', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = RenameFileInputSchema.safeParse({ ...bodyObj, fileId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid rename request',
      );
    }
    const result = await fileExplorerService.renameFile(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.patch('/projects/:projectId/files/:fileId/move', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = MoveFileInputSchema.safeParse({ ...bodyObj, fileId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid move request',
      );
    }
    const result = await fileExplorerService.moveFile(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/projects/:projectId/files/:fileId/duplicate', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = DuplicateFileInputSchema.safeParse({ ...bodyObj, fileId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid duplicate request',
      );
    }
    const result = await fileExplorerService.duplicateFile(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.delete('/projects/:projectId/files/:fileId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'write_files',
    );
    if (!actor) {
      return reply;
    }
    const bodyObj = typeof request.body === 'object' && request.body !== null ? request.body : {};
    const parsed = DeleteFileInputSchema.safeParse({ ...bodyObj, fileId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid delete request',
      );
    }
    const result = await fileExplorerService.deleteFile(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.get('/projects/:projectId/files/:fileId/download', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'read',
    );
    if (!actor) {
      return reply;
    }
    const result = await fileExplorerService.getDownloadUrl(actor, fileId);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.get('/projects/:projectId/files/:fileId/preview', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolveProjectActor(
      request,
      reply,
      authService,
      projectService,
      projectId,
      'read',
    );
    if (!actor) {
      return reply;
    }
    const result = await fileExplorerService.previewFile(actor, fileId);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });
}
