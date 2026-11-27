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

export interface PdfAnnotationRouteGuardOptions {
  readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
  readonly assertReferenceInProject?: (projectId: string, referenceId: string) => Promise<boolean>;
}

function readUuidParam(params: unknown, key: string): string | null {
  if (typeof params === 'object' && params !== null && key in params) {
    const value = Reflect.get(params, key);
    if (typeof value === 'string' && UuidSchema.safeParse(value).success) {
      return value;
    }
  }
  return null;
}

function parseQueryPageNumber(query: unknown): unknown {
  if (typeof query !== 'object' || query === null || !('pageNumber' in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, 'pageNumber');
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const parsed = Number(trimmed);
    return trimmed.length > 0 && Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

function readOptionalQueryValue(query: unknown, key: string): unknown {
  if (typeof query !== 'object' || query === null || !(key in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, key);
  return raw === undefined || raw === '' ? undefined : raw;
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

async function ensureAnnotationTargetsOwned(
  reply: FastifyReply,
  guards: PdfAnnotationRouteGuardOptions | undefined,
  projectId: string,
  fileId: string,
  referenceId: string | null | undefined,
): Promise<boolean> {
  if (!guards?.assertFileInProject) {
    sendErrorReply(reply, 'NOT_FOUND', 'PDF file not found in this project');
    return false;
  }
  const fileOk = await guards.assertFileInProject(projectId, fileId);
  if (!fileOk) {
    sendErrorReply(reply, 'NOT_FOUND', 'PDF file not found in this project');
    return false;
  }
  if (referenceId) {
    if (!guards.assertReferenceInProject) {
      sendErrorReply(reply, 'NOT_FOUND', 'Reference not found in this project');
      return false;
    }
    const refOk = await guards.assertReferenceInProject(projectId, referenceId);
    if (!refOk) {
      sendErrorReply(reply, 'NOT_FOUND', 'Reference not found in this project');
      return false;
    }
  }
  return true;
}

function readProjectAndFileIds(
  params: unknown,
): { readonly projectId: string; readonly fileId: string } | null {
  const projectId = readUuidParam(params, 'projectId');
  const fileId = readUuidParam(params, 'fileId');
  return projectId && fileId ? { projectId, fileId } : null;
}

export function registerPdfAnnotationRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
  annotationService: PdfAnnotationService,
  guards?: PdfAnnotationRouteGuardOptions,
): void {
  app.post('/projects/:projectId/files/:fileId/annotations', async (request, reply) => {
    const ids = readProjectAndFileIds(request.params);
    if (!ids) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const { projectId, fileId } = ids;
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
    const owned = await ensureAnnotationTargetsOwned(
      reply,
      guards,
      projectId,
      fileId,
      parsed.data.referenceId,
    );
    if (!owned) {
      return reply;
    }
    const result = await annotationService.createAnnotation(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.get('/projects/:projectId/files/:fileId/annotations', async (request, reply) => {
    const ids = readProjectAndFileIds(request.params);
    if (!ids) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId or fileId parameter');
    }
    const { projectId, fileId } = ids;
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
    const referenceId = readOptionalQueryValue(request.query, 'referenceId');
    const pageNumber = parseQueryPageNumber(request.query);
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
    const owned = await ensureAnnotationTargetsOwned(
      reply,
      guards,
      projectId,
      fileId,
      parsed.data.referenceId,
    );
    if (!owned) {
      return reply;
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
