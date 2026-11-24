import fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './controllers/auth-controller.js';
import { registerFileRoutes } from './controllers/file-controller.js';
import { registerHealthRoutes, type HealthProbes } from './controllers/health-controller.js';
import { registerProjectRoutes } from './controllers/project-controller.js';
import type { AuthService } from './services/auth-service.js';
import type { FileExplorerService } from './services/file-explorer-service.js';
import type { ProjectService } from './services/project-service.js';

export interface ApiPhase1Services {
  readonly authService: AuthService;
  readonly projectService: ProjectService;
  readonly fileExplorerService: FileExplorerService;
}

export function createApiServer(
  probes: HealthProbes,
  version: string,
  phase1Services?: ApiPhase1Services,
): FastifyInstance {
  const app = fastify({ logger: false });
  registerHealthRoutes(app, probes, version);
  if (phase1Services) {
    registerAuthRoutes(app, phase1Services.authService);
    registerProjectRoutes(app, phase1Services.authService, phase1Services.projectService);
    registerFileRoutes(
      app,
      phase1Services.authService,
      phase1Services.projectService,
      phase1Services.fileExplorerService,
    );
  }
  return app;
}
