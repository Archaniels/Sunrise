import {
  AddProjectMemberInputSchema,
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  UuidSchema,
} from '@sunrise/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { ProjectService } from '../services/project-service.js';
import { sendErrorReply } from './auth-controller.js';

function readParamString(params: unknown, key: string): string | null {
  if (typeof params === 'object' && params !== null && key in params) {
    const value = Reflect.get(params, key);
    if (typeof value === 'string' && UuidSchema.safeParse(value).success) {
      return value;
    }
  }
  return null;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  authService: AuthService,
  projectService: ProjectService,
): void {
  app.post('/projects', async (request, reply) => {
    const me = await authService.getMe(request.headers.authorization);
    if (!me.ok) {
      return sendErrorReply(reply, me.error.code, me.error.message);
    }
    const parsed = CreateProjectInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid project payload',
      );
    }
    const created = await projectService.createProject(me.value.id, parsed.data);
    if (!created.ok) {
      return sendErrorReply(reply, created.error.code, created.error.message);
    }
    return reply.code(201).send(created);
  });

  app.get('/projects', async (request, reply) => {
    const me = await authService.getMe(request.headers.authorization);
    if (!me.ok) {
      return sendErrorReply(reply, me.error.code, me.error.message);
    }
    const listed = await projectService.listProjects(me.value.id);
    if (!listed.ok) {
      return sendErrorReply(reply, listed.error.code, listed.error.message);
    }
    return reply.code(200).send(listed);
  });

  app.patch('/projects/:projectId', async (request, reply) => {
    const me = await authService.getMe(request.headers.authorization);
    if (!me.ok) {
      return sendErrorReply(reply, me.error.code, me.error.message);
    }
    const projectId = readParamString(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const parsed = UpdateProjectInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid update payload',
      );
    }
    const updated = await projectService.updateProject(me.value.id, projectId, parsed.data);
    if (!updated.ok) {
      return sendErrorReply(reply, updated.error.code, updated.error.message);
    }
    return reply.code(200).send(updated);
  });

  app.post('/projects/:projectId/members', async (request, reply) => {
    const me = await authService.getMe(request.headers.authorization);
    if (!me.ok) {
      return sendErrorReply(reply, me.error.code, me.error.message);
    }
    const projectId = readParamString(request.params, 'projectId');
    if (!projectId) {
      return sendErrorReply(reply, 'VALIDATION_ERROR', 'Invalid projectId parameter');
    }
    const parsed = AddProjectMemberInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid member payload',
      );
    }
    const added = await projectService.addMember(me.value.id, projectId, parsed.data);
    if (!added.ok) {
      return sendErrorReply(reply, added.error.code, added.error.message);
    }
    return reply.code(201).send(added);
  });
}
