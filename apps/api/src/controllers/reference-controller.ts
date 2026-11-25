import {
  AttachReferencePdfInputSchema,
  CreateReferenceInputSchema,
  ListReferencesQuerySchema,
  UpdateReferenceInputSchema,
  UuidSchema,
  type ProjectAction,
} from '@sunrise/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { ProjectService } from '../services/project-service.js';
import type { ReferenceActor, ReferenceService } from '../services/reference-service.js';
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

function readOptionalQueryNumber(query: unknown, key: string): number | undefined {
  if (typeof query !== 'object' || query === null || !(key in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, key);
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function readOptionalQueryBoolean(query: unknown, key: string): boolean | undefined {
  if (typeof query !== 'object' || query === null || !(key in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, key);
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return undefined;
}

function readOptionalQueryString(query: unknown, key: string): string | undefined {
  if (typeof query !== 'object' || query === null || !(key in query)) {
    return undefined;
  }
  const raw = Reflect.get(query, key);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

async function resolveReferenceActor(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
  projectService: ProjectService,
  projectId: string,
  action: ProjectAction,
): Promise<ReferenceActor | null> {
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

function buildListQueryObject(projectId: string, rawQuery: unknown): Record<string, unknown> {
  const tag = readOptionalQueryString(rawQuery, 'tag');
  const search = readOptionalQueryString(rawQuery, 'search');
  const sortBy = readOptionalQueryString(rawQuery, 'sortBy');
  const sortOrder = readOptionalQueryString(rawQuery, 'sortOrder');
  const yearFrom = readOptionalQueryNumber(rawQuery, 'yearFrom');
  const yearTo = readOptionalQueryNumber(rawQuery, 'yearTo');
  const hasPdf = readOptionalQueryBoolean(rawQuery, 'hasPdf');
  return {
    projectId,
    ...(tag !== undefined ? { tag } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(sortBy !== undefined ? { sortBy } : {}),
    ...(sortOrder !== undefined ? { sortOrder } : {}),
    ...(yearFrom !== undefined ? { yearFrom } : {}),
    ...(yearTo !== undefined ? { yearTo } : {}),
    ...(hasPdf !== undefined ? { hasPdf } : {}),
  };
}

function resolveCreateStatusCode(status: string): number {
  if (status === 'conflict') {
    return 409;
  }
  return status === 'created' ? 201 : 200;
}

export function registerReferenceRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
  referenceService: ReferenceService,
): void {
  app.post('/projects/:projectId/references', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveReferenceActor(
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
    const parsed = CreateReferenceInputSchema.safeParse({ ...bodyObj, projectId });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid reference payload',
      );
    }
    const result = await referenceService.createReference(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(resolveCreateStatusCode(result.value.status)).send(result);
  });

  app.get('/projects/:projectId/references', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const actor = await resolveReferenceActor(
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
    const parsed = ListReferencesQuerySchema.safeParse(
      buildListQueryObject(projectId, request.query),
    );
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid reference list query',
      );
    }
    const result = await referenceService.listReferences(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.get('/projects/:projectId/references/:referenceId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const referenceId = readUuidParam(request.params, 'referenceId');
    if (!projectId || !referenceId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or referenceId parameter',
      );
    }
    const actor = await resolveReferenceActor(
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
    const result = await referenceService.getReference(actor, projectId, referenceId);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.patch('/projects/:projectId/references/:referenceId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const referenceId = readUuidParam(request.params, 'referenceId');
    if (!projectId || !referenceId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or referenceId parameter',
      );
    }
    const actor = await resolveReferenceActor(
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
    const parsed = UpdateReferenceInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid reference update payload',
      );
    }
    const result = await referenceService.updateReference(
      actor,
      projectId,
      referenceId,
      parsed.data,
    );
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/projects/:projectId/references/:referenceId/attach-pdf', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const referenceId = readUuidParam(request.params, 'referenceId');
    if (!projectId || !referenceId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or referenceId parameter',
      );
    }
    const actor = await resolveReferenceActor(
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
    const parsed = AttachReferencePdfInputSchema.safeParse({
      ...bodyObj,
      projectId,
      referenceId,
    });
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid attach PDF payload',
      );
    }
    const result = await referenceService.attachPdf(actor, parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.delete('/projects/:projectId/references/:referenceId', async (request, reply) => {
    const projectId = readUuidParam(request.params, 'projectId');
    const referenceId = readUuidParam(request.params, 'referenceId');
    if (!projectId || !referenceId) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        'Invalid projectId or referenceId parameter',
      );
    }
    const actor = await resolveReferenceActor(
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
    const result = await referenceService.deleteReference(actor, projectId, referenceId);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });
}
