import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_PRELOAD_KEYS,
  PdfAnnotationSchema,
  PdfAskRavenPayloadSchema,
  PdfCopyCitationPayloadSchema,
  PdfCreateNotePayloadSchema,
  PdfViewerStateSchema,
  PHASE2_IPC_CHANNELS,
  PHASE2_PRELOAD_EXPOSED_KEYS,
  type CreatePdfAnnotationInput,
  type ListPdfAnnotationsQuery,
  type PdfAnnotation,
  type PdfAskRavenPayload,
  type PdfCopyCitationPayload,
  type PdfCreateNotePayload,
  type PdfDeepLinkTarget,
  type PdfSelectionContext,
  type PdfViewerState,
  type ProjectRole,
  type Result,
  type UpdatePdfAnnotationInput,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface PdfActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

interface PdfAnnotationServiceLike {
  readonly createAnnotation: (
    actor: PdfActor,
    input: CreatePdfAnnotationInput,
  ) => Promise<Result<PdfAnnotation>>;
  readonly listAnnotations: (
    actor: PdfActor,
    query: ListPdfAnnotationsQuery,
  ) => Promise<Result<PdfAnnotation[]>>;
  readonly updateAnnotation: (
    actor: PdfActor,
    projectId: string,
    annotationId: string,
    input: UpdatePdfAnnotationInput,
  ) => Promise<Result<PdfAnnotation>>;
  readonly deleteAnnotation: (
    actor: PdfActor,
    projectId: string,
    annotationId: string,
  ) => Promise<Result<{ readonly deleted: true }>>;
}

interface PdfViewerControllerLike {
  readonly getState: () => PdfViewerState;
  readonly setZoom: (zoom: number) => PdfViewerState;
  readonly goToPage: (pageNumber: number) => PdfViewerState;
  readonly toggleThumbnails: () => PdfViewerState;
  readonly openDeepLink: (target: PdfDeepLinkTarget) => PdfViewerState;
  readonly searchDocument: (query: string, pageTexts: readonly string[]) => PdfViewerState;
  readonly createSelectionAction: (
    action: 'copy_citation' | 'create_note' | 'ask_raven',
    selection: PdfSelectionContext,
  ) => PdfCopyCitationPayload | PdfCreateNotePayload | PdfAskRavenPayload;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

describe('Phase 2.4 Integrated Academic PDF Viewer and persistent annotations acceptance', () => {
  it('provides SQL migration defining pdf_annotations table with file, reference, page, and rects columns', () => {
    const migrationsDir = join(REPO_ROOT, 'apps/api/src/db/migrations');
    expect(existsSync(migrationsDir)).toBe(true);

    const allSql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => readFileSync(join(migrationsDir, entry.name), 'utf8'))
      .join('\n');

    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+pdf_annotations/i);
    expect(allSql).toMatch(/file_id/i);
    expect(allSql).toMatch(/reference_id/i);
    expect(allSql).toMatch(/page_number/i);
    expect(allSql).toMatch(/rects/i);
  });

  it('persists PDF highlights and notes per reference/file and enforces RBAC and project isolation', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/pdf-annotation-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/pdf-annotation-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryPdfAnnotationService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryPdfAnnotationService')) {
      return;
    }

    const factory = (
      loaded as { readonly createInMemoryPdfAnnotationService: () => PdfAnnotationServiceLike }
    ).createInMemoryPdfAnnotationService;
    const service = factory();

    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '99999999-9999-4999-8999-999999999999';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const referenceId = '33333333-3333-4333-8333-333333333333';
    const editor: PdfActor = { userId: '44444444-4444-4444-8444-444444444444', role: 'editor' };
    const viewer: PdfActor = { userId: '55555555-5555-4555-8555-555555555555', role: 'viewer' };

    const created = await service.createAnnotation(editor, {
      projectId: projectA,
      fileId,
      referenceId,
      pageNumber: 7,
      selectedText: 'Results hold across 12 benchmarks.',
      note: 'Important quantitative support',
      color: 'yellow',
      rects: [{ x: 0.1, y: 0.25, width: 0.65, height: 0.03 }],
    });
    expect(created.ok && PdfAnnotationSchema.safeParse(created.value).success).toBe(true);
    if (!created.ok) {
      return;
    }

    const viewerList = await service.listAnnotations(viewer, { projectId: projectA, fileId });
    expect(viewerList.ok && viewerList.value.length === 1).toBe(true);

    const viewerCreateBlocked = await service.createAnnotation(viewer, {
      projectId: projectA,
      fileId,
      referenceId,
      pageNumber: 2,
      selectedText: 'Blocked highlight',
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.03 }],
    });
    expect(viewerCreateBlocked.ok).toBe(false);
    if (!viewerCreateBlocked.ok) {
      expect(viewerCreateBlocked.error.code).toBe('FORBIDDEN');
    }

    const crossProjectBola = await service.updateAnnotation(editor, projectB, created.value.id, {
      note: 'Cross-project overwrite attempt',
    });
    expect(crossProjectBola.ok).toBe(false);
    if (!crossProjectBola.ok) {
      expect(crossProjectBola.error.code).toBe('NOT_FOUND');
    }
  });

  it('supports zoom, thumbnails, text search, fileId+pageNumber deep-linking, and selection popover hooks', async () => {
    const controllerPath = join(
      REPO_ROOT,
      'apps/desktop/src/renderer/pdf-viewer/pdf-viewer-state.ts',
    );
    expect(
      existsSync(controllerPath),
      'Missing apps/desktop/src/renderer/pdf-viewer/pdf-viewer-state.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(hasFunctionProp(loaded, 'createPdfViewerController')).toBe(true);
    if (!hasFunctionProp(loaded, 'createPdfViewerController')) {
      return;
    }

    const factory = (
      loaded as {
        readonly createPdfViewerController: (input: {
          readonly projectId: string;
          readonly fileId: string;
          readonly referenceId: string | null;
          readonly totalPages: number;
          readonly role: ProjectRole;
        }) => PdfViewerControllerLike;
      }
    ).createPdfViewerController;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const referenceId = '33333333-3333-4333-8333-333333333333';

    const viewer = factory({
      projectId,
      fileId,
      referenceId,
      totalPages: 15,
      role: 'editor',
    });

    const zoomed = viewer.setZoom(1.5);
    expect(zoomed.zoom).toBe(1.5);

    const toggled = viewer.toggleThumbnails();
    expect(toggled.thumbnailsOpen).toBe(true);

    const deepLinked = viewer.openDeepLink({
      projectId,
      fileId,
      referenceId,
      pageNumber: 11,
      highlightId: null,
      searchExcerpt: 'ablation study',
    });
    expect(deepLinked.currentPage).toBe(11);

    const searched = viewer.searchDocument('ablation', [
      'Introduction overview',
      'Section 2 ablation study results',
      'Conclusion',
    ]);
    expect(searched.searchMatches).toHaveLength(1);
    expect(searched.searchMatches[0]?.pageNumber).toBe(2);
    expect(PdfViewerStateSchema.safeParse(viewer.getState()).success).toBe(true);

    const selection: PdfSelectionContext = {
      projectId,
      fileId,
      referenceId,
      citeKey: 'smith2024',
      pageNumber: 11,
      selectedText: 'Ablation confirms deduplication improves precision.',
      rects: [{ x: 0.1, y: 0.4, width: 0.7, height: 0.03 }],
    };

    const copyHook = viewer.createSelectionAction('copy_citation', selection);
    const noteHook = viewer.createSelectionAction('create_note', selection);
    const ravenHook = viewer.createSelectionAction('ask_raven', selection);

    expect(PdfCopyCitationPayloadSchema.safeParse(copyHook).success).toBe(true);
    expect(PdfCreateNotePayloadSchema.safeParse(noteHook).success).toBe(true);
    expect(PdfAskRavenPayloadSchema.safeParse(ravenHook).success).toBe(true);
  });

  it('exposes Phase 2 preload namespaces safely and validates Phase 2 IPC handlers with Zod', async () => {
    const preloadPath = join(REPO_ROOT, 'apps/desktop/src/preload/expose-api.ts');
    const routerPath = join(REPO_ROOT, 'apps/desktop/src/main/controllers/phase2-ipc-router.ts');
    expect(existsSync(preloadPath)).toBe(true);
    expect(
      existsSync(routerPath),
      'Missing apps/desktop/src/main/controllers/phase2-ipc-router.ts',
    ).toBe(true);

    const preloadLoaded: unknown = await import(pathToFileURL(preloadPath).href);
    expect(hasFunctionProp(preloadLoaded, 'createPhase2PreloadApi')).toBe(true);
    if (hasFunctionProp(preloadLoaded, 'createPhase2PreloadApi')) {
      const preloadFactory = (
        preloadLoaded as {
          readonly createPhase2PreloadApi: (
            invoke: (channel: string, payload?: unknown) => Promise<unknown>,
          ) => Record<string, unknown>;
        }
      ).createPhase2PreloadApi;
      const exposed = preloadFactory(vi.fn(async () => ({ ok: true, value: null })));
      expect(Object.keys(exposed).sort()).toEqual([...PHASE2_PRELOAD_EXPOSED_KEYS].sort());
      for (const forbidden of FORBIDDEN_PRELOAD_KEYS) {
        expect(forbidden in exposed).toBe(false);
      }
      const pdfNamespace = exposed['pdf'] as Record<string, unknown> | undefined;
      expect(typeof pdfNamespace?.['onDeepLinkOpened']).toBe('function');
    }

    const routerLoaded: unknown = await import(pathToFileURL(routerPath).href);
    expect(hasFunctionProp(routerLoaded, 'createPhase2IpcHandlers')).toBe(true);
    if (!hasFunctionProp(routerLoaded, 'createPhase2IpcHandlers')) {
      return;
    }

    const deepLinkSpy = vi.fn(async (target: unknown) => ({ ok: true as const, value: target }));
    const routerFactory = (
      routerLoaded as {
        readonly createPhase2IpcHandlers: (
          services: Record<string, unknown>,
        ) => Record<string, (payload?: unknown) => Promise<Result<unknown>>>;
      }
    ).createPhase2IpcHandlers;

    const handlers = routerFactory({
      copyCitation: vi.fn(async () => ({ ok: true, value: { completed: true } })),
      getViewerState: vi.fn(async () => ({ ok: true, value: null })),
      saveViewerState: vi.fn(async (state: unknown) => ({ ok: true, value: state })),
      openDeepLink: deepLinkSpy,
    });

    const deepLinkHandler = handlers[PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK];
    expect(deepLinkHandler).toBeDefined();
    if (!deepLinkHandler) {
      return;
    }

    const rejected = await deepLinkHandler({
      projectId: '11111111-1111-4111-8111-111111111111',
      fileId: '22222222-2222-4222-8222-222222222222',
      referenceId: null,
      pageNumber: 0,
      highlightId: null,
      searchExcerpt: null,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('VALIDATION_ERROR');
    }
    expect(deepLinkSpy).not.toHaveBeenCalled();
  });
});
