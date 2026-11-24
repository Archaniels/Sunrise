import type { HealthResponse } from '@sunrise/shared';
import type { FastifyInstance } from 'fastify';
import { evaluateSystemHealth, type HealthProbes } from '../services/health-service.js';

export type { HealthProbes } from '../services/health-service.js';

export interface HealthCheckResult {
  readonly statusCode: 200 | 503;
  readonly body: HealthResponse;
}

export function createHealthCheckHandler(
  probes: HealthProbes,
  version: string,
): () => Promise<HealthCheckResult> {
  return async (): Promise<HealthCheckResult> => evaluateSystemHealth(probes, version);
}

export function registerHealthRoutes(
  app: FastifyInstance,
  probes: HealthProbes,
  version: string,
): void {
  const handleHealth = createHealthCheckHandler(probes, version);
  app.get('/health', async (_request, reply) => {
    const outcome = await handleHealth();
    return reply.code(outcome.statusCode).send(outcome.body);
  });
}
