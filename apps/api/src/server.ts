import fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './controllers/auth-controller.js';
import { registerFileRoutes } from './controllers/file-controller.js';
import { registerHealthRoutes, type HealthProbes } from './controllers/health-controller.js';
import { registerIngestionRoutes } from './controllers/ingestion-controller.js';
import { registerLiteratureRoutes } from './controllers/literature-controller.js';
import { registerPdfAnnotationRoutes } from './controllers/pdf-annotation-controller.js';
import { registerProjectRoutes } from './controllers/project-controller.js';
import { registerReferenceRoutes } from './controllers/reference-controller.js';
import type { AuthService } from './services/auth-service.js';
import type { FileExplorerService } from './services/file-explorer-service.js';
import type { IngestionService } from './services/ingestion-service.js';
import type { LiteratureSearchService } from './services/literature-service.js';
import type { PdfAnnotationService } from './services/pdf-annotation-service.js';
import type { ProjectService } from './services/project-service.js';
import type { ReferenceService } from './services/reference-service.js';

export interface ApiPhase1Services {
  readonly authService: AuthService;
  readonly projectService: ProjectService;
  readonly fileExplorerService: FileExplorerService;
}

export interface ApiPhase2Services {
  readonly literatureService?: LiteratureSearchService;
  readonly referenceService?: ReferenceService;
  readonly ingestionService?: IngestionService;
  readonly pdfAnnotationService?: PdfAnnotationService;
}

function buildPhase2OwnershipGuards(
  fileExplorerService: FileExplorerService,
  referenceService?: ReferenceService,
): {
  readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
  readonly assertReferenceInProject?: (projectId: string, referenceId: string) => Promise<boolean>;
} {
  const hasFileInProject = fileExplorerService.hasFileInProject;
  return {
    ...(hasFileInProject
      ? {
          assertFileInProject: (projectId: string, fileId: string) =>
            hasFileInProject(projectId, fileId),
        }
      : {}),
    ...(referenceService
      ? {
          assertReferenceInProject: async (projectId: string, referenceId: string) => {
            const result = await referenceService.getReference(
              { userId: '00000000-0000-4000-8000-000000000000', role: 'viewer' },
              projectId,
              referenceId,
            );
            return result.ok;
          },
        }
      : {}),
  };
}

function registerPhase2ServerRoutes(
  app: FastifyInstance,
  phase1Services: ApiPhase1Services,
  phase2Services: ApiPhase2Services,
): void {
  const guards = buildPhase2OwnershipGuards(
    phase1Services.fileExplorerService,
    phase2Services.referenceService,
  );
  if (phase2Services.literatureService) {
    registerLiteratureRoutes(app, phase1Services.authService, phase2Services.literatureService);
  }
  if (phase2Services.referenceService) {
    registerReferenceRoutes(
      app,
      phase1Services.authService,
      phase1Services.projectService,
      phase2Services.referenceService,
      guards,
    );
  }
  if (phase2Services.ingestionService) {
    registerIngestionRoutes(
      app,
      phase1Services.authService,
      phase1Services.projectService,
      phase2Services.ingestionService,
      guards,
    );
  }
  if (phase2Services.pdfAnnotationService) {
    registerPdfAnnotationRoutes(
      app,
      phase1Services.authService,
      phase1Services.projectService,
      phase2Services.pdfAnnotationService,
      guards,
    );
  }
}

export function createApiServer(
  probes: HealthProbes,
  version: string,
  phase1Services?: ApiPhase1Services,
  phase2Services?: ApiPhase2Services,
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
    if (phase2Services) {
      registerPhase2ServerRoutes(app, phase1Services, phase2Services);
    }
  }
  return app;
}
