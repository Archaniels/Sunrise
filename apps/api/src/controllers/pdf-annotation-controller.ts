import {
  CreatePdfAnnotationInputSchema,
  ListPdfAnnotationsQuerySchema,
  UpdatePdfAnnotationInputSchema,
  UuidSchema,
  type ProjectAction,
} from '@sunrise/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { PdfActor, PdfAnnotationService } from '../services/pdf-annotation-service.js';
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

function readOptionalQueryPageNumber(query: unknown): number | undefined {
  if (typeof query !== 'object' || query === null || !('pageNumber' in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, 'pageNumber');
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function readOptionalQueryUuid(query: unknown, key: string): string | undefined {
  if (typeof query !== 'object' || query === null || !(key in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, key);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

async function resolvePdfActor(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  projectService: ProjectService,
  projectId: string,
  action: ProjectAction,
): Promise<PdfActor | null> {
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

export function registerPdfAnnotationRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
  annotationService: PdfAnnotationService,
): void {
  app.post('/projects/:projectId/files/:fileId/annotations', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolvePdfActor(
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
    const parsed = CreatePdfAnnotationInputSchema.safeParse({ ...bodyObj, projectId, fileId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid PDF annotation payload',
      );
    }
    const result = await annotationService.createAnnotation(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.get('/projects/:projectId/files/:fileId/annotations', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const fileId = readUuidParam(request.params, 'fileId');
    if (!projectId || !fileId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const actor = await resolvePdfActor(
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
    const referenceId = readOptionalQueryUuid(request.query, 'referenceId');
    const pageNumber = readOptionalQueryPageNumber(request.query);
    const parsed = ListPdfAnnotationsQuerySchema.safeParse({
      projectId,
      fileId,
      ...(referenceId !== undefined ? { referenceId } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
    });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid PDF annotation query',
      );
    }
    const result = await annotationService.listAnnotations(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.patch('/projects/:projectId/annotations/:annotationId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const annotationId = readUuidParam(request.params, 'annotationId');
    if (!projectId || !annotationId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or annotationId parameter',
      );
    }
    const actor = await resolvePdfActor(
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
    const parsed = UpdatePdfAnnotationInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid PDF annotation update payload',
      );
    }
    const result = await annotationService.updateAnnotation(
      actor,
      projectId,
      annotationId,
      parsed.data,
    );
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.delete('/projects/:projectId/annotations/:annotationId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const annotationId = readUuidParam(request.params, 'annotationId');
    if (!projectId || !annotationId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or annotationId parameter',
      );
    }
    const actor = await resolvePdfActor(
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
    const result = await annotationService.deleteAnnotation(actor, projectId, annotationId);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });
}
