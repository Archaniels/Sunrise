import fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes, type HealthProbes } from './controllers/health-controller.js';

export function createApiServer(probes: HealthProbes, version: string): FastifyInstance {
  const app = fastify({ logger: false });
  registerHealthRoutes(app, probes, version);
  return app;
}
