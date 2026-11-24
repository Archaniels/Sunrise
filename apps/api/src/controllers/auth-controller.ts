import {
  LoginInputSchema,
  LogoutInputSchema,
  RefreshSessionInputSchema,
  SignupInputSchema,
  type ErrorCode,
} from '@sunrise/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthService } from '../services/auth-service.js';

export function errorCodeToHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'SECURITY_POLICY_VIOLATION':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'DEPENDENCY_UNAVAILABLE':
      return 503;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

export function sendErrorReply(
  reply: FastifyReply,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.code(errorCodeToHttpStatus(code)).send({ ok: false, error: { code, message } });
}

export function registerAuthRoutes(app: FastifyInstance, authService: AuthService): void {
  app.post('/auth/signup', async (request, reply) => {
    const parsed = SignupInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid signup request',
      );
    }
    const result = await authService.signup(parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(201).send(result);
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid login request',
      );
    }
    const result = await authService.login(parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = RefreshSessionInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid refresh request',
      );
    }
    const result = await authService.refresh(parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = LogoutInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid logout request',
      );
    }
    const result = await authService.logout(parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });

  app.get('/auth/me', async (request, reply) => {
    const result = await authService.getMe(request.headers.authorization);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });
}
