import { LiteratureSearchQuerySchema } from '@sunrise/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../services/auth-service.js';
import type { LiteratureSearchService } from '../services/literature-service.js';
import { sendErrorReply } from './auth-controller.js';

export function registerLiteratureRoutes(
  app: FastifyInstance,
  authService: AuthService,
  literatureService: LiteratureSearchService,
): void {
  app.post('/literature/search', async (request, reply) => {
    const me = await authService.getMe(request.headers.authorization);
    if (!me.ok) {
      return sendErrorReply(reply, me.error.code, me.error.message);
    }
    const parsed = LiteratureSearchQuerySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendErrorReply(
        reply,
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'Invalid literature search query',
      );
    }
    const result = await literatureService.search(parsed.data);
    if (!result.ok) {
      return sendErrorReply(reply, result.error.code, result.error.message);
    }
    return reply.code(200).send(result);
  });
}
