import {
  ExportBibliographyInputSchema,
  ImportBibliographyInputSchema,
  IngestDoiInputSchema,
  IngestPdfInputSchema,
  UuidSchema,
  type ProjectAction,
} from '@sunrise/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { IngestionActor, IngestionService } from '../services/ingestion-service.js';
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

async function resolveIngestionActor(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  projectService: ProjectService,
  projectId: string,
  action: ProjectAction,
): Promise<IngestionActor | null> {
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

function resolveIngestionStatusCode(status: string): number {
  if (status === 'conflict') {
    return 409;
  }
  return status === 'created' ? 201 : 200;
}

export interface IngestionRouteGuardOptions {
  readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
}

function readObjectBody(body: unknown): object {
  return typeof body === 'object' && body !== null ? body : {};
}

async function ensureIngestionFileOwned(
  reply: FastifyReply,
  guards: IngestionRouteGuardOptions | undefined,
  projectId: string,
  fileId: string,
): Promise<boolean> {
  if (!guards?.assertFileInProject) {
    return true;
  }
  const owned = await guards.assertFileInProject(projectId, fileId);
  if (!owned) {
    sendErrorReply(reply, 'NOT_FOUND', 'File not found in project');
    return false;
  }
  return true;
}

export function registerIngestionRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
  ingestionService: IngestionService,
  guards?: IngestionRouteGuardOptions,
): void {
  app.post('/projects/:projectId/ingestion/doi', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveIngestionActor(
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
    const parsed = IngestDoiInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid DOI ingestion payload',
      );
    }
    const result = await ingestionService.ingestDoi(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(resolveIngestionStatusCode(result.value.status)).send(result);
  });

  app.post('/projects/:projectId/ingestion/bibliography/import', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveIngestionActor(
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
    const parsed = ImportBibliographyInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid bibliography import payload',
      );
    }
    const result = await ingestionService.importBibliography(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/projects/:projectId/ingestion/bibliography/export', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveIngestionActor(
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
    const parsed = ExportBibliographyInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid bibliography export payload',
      );
    }
    const result = await ingestionService.exportBibliography(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/projects/:projectId/ingestion/pdf', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveIngestionActor(
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
    const parsed = IngestPdfInputSchema.safeParse({ ...readObjectBody(request.body), projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid PDF ingestion payload',
      );
    }
    if (!(await ensureIngestionFileOwned(reply, guards, projectId, parsed.data.localPdfFileId))) {
      return reply;
    }
    const result = await ingestionService.ingestPdf(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(resolveIngestionStatusCode(result.value.status)).send(result);
  });
}
