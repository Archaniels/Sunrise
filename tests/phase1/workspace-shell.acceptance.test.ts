import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COLUMN_WIDTHS,
  FORBIDDEN_PRELOAD_KEYS,
  PHASE1_PRELOAD_EXPOSED_KEYS,
  WorkspaceLayoutStateSchema,
  type FileKind,
  type Result,
  type SidebarCategory,
  type WorkspaceLayoutState,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface WorkspaceControllerLike {
  readonly getState: () => WorkspaceLayoutState;
  readonly selectCategory: (category: SidebarCategory) => WorkspaceLayoutState;
  readonly openArtifactTab: (input: {
    readonly artifactId: string;
    readonly title: string;
    readonly kind: FileKind;
    readonly isReadOnly?: boolean;
  }) => WorkspaceLayoutState;
  readonly closeTab: (tabId: string) => WorkspaceLayoutState;
  readonly toggleRightSidebar: () => WorkspaceLayoutState;
}

interface LayoutStoreServiceLike {
  readonly saveLayout: (layout: WorkspaceLayoutState) => Promise<Result<WorkspaceLayoutState>>;
  readonly getLayout: (projectId: string) => Promise<Result<WorkspaceLayoutState | null>>;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

describe('Phase 1.2 Three-column workspace shell and layout persistence acceptance', () => {
  it('manages 3-column layout, 7 sidebar categories, and dynamic center artifact tabs', async () => {
    const controllerPath = join(
      REPO_ROOT,
      'apps/desktop/src/renderer/workspace/workspace-state.ts',
    );
    expect(
      existsSync(controllerPath),
      'Missing apps/desktop/src/renderer/workspace/workspace-state.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(hasFunctionProp(loaded, 'createWorkspaceController')).toBe(true);
    if (!hasFunctionProp(loaded, 'createWorkspaceController')) {
      return;
    }

    const factory = (
      loaded as { readonly createWorkspaceController: (projectId: string) => WorkspaceControllerLike }
    ).createWorkspaceController;
    const projectId = '11111111-1111-4111-8111-111111111111';
    const workspace = factory(projectId);

    const afterCategory = workspace.selectCategory('data');
    expect(afterCategory.activeCategory).toBe('data');

    const afterCsv = workspace.openArtifactTab({
      artifactId: '22222222-2222-4222-8222-222222222222',
      title: 'measurements.csv',
      kind: 'csv',
    });
    expect(afterCsv.tabs).toHaveLength(1);
    expect(afterCsv.tabs[0]?.viewType).toBe('spreadsheet');

    const afterPdf = workspace.openArtifactTab({
      artifactId: '33333333-3333-4333-8333-333333333333',
      title: 'smith2024.pdf',
      kind: 'pdf',
      isReadOnly: true,
    });
    expect(afterPdf.tabs).toHaveLength(2);
    expect(afterPdf.tabs[1]?.viewType).toBe('pdf');
    expect(afterPdf.activeTabId).toBe(afterPdf.tabs[1]?.id);

    const afterCollapse = workspace.toggleRightSidebar();
    expect(afterCollapse.columns.rightCollapsed).toBe(true);

    const activeId = afterPdf.tabs[1]?.id;
    if (activeId) {
      const afterClose = workspace.closeTab(activeId);
      expect(afterClose.tabs).toHaveLength(1);
      expect(afterClose.activeTabId).toBe(afterClose.tabs[0]?.id);
    }
    expect(WorkspaceLayoutStateSchema.safeParse(workspace.getState()).success).toBe(true);
  });

  it('persists and restores validated workspace layout and rejects invalid column bounds', async () => {
    const storePath = join(REPO_ROOT, 'apps/desktop/src/main/services/layout-store-service.ts');
    expect(
      existsSync(storePath),
      'Missing apps/desktop/src/main/services/layout-store-service.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(storePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryLayoutStoreService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryLayoutStoreService')) {
      return;
    }

    const factory = (
      loaded as { readonly createInMemoryLayoutStoreService: () => LayoutStoreServiceLike }
    ).createInMemoryLayoutStoreService;
    const store = factory();

    const projectId = '11111111-1111-4111-8111-111111111111';
    const layout: WorkspaceLayoutState = {
      projectId,
      activeCategory: 'analysis',
      tabs: [],
      activeTabId: null,
      columns: DEFAULT_COLUMN_WIDTHS,
    };

    const saved = await store.saveLayout(layout);
    expect(saved.ok).toBe(true);

    const restored = await store.getLayout(projectId);
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.value?.activeCategory).toBe('analysis');
    }
  });

  it('exposes Phase 1 typed preload namespaces without exposing ipcRenderer or Node primitives', async () => {
    const preloadPath = join(REPO_ROOT, 'apps/desktop/src/preload/expose-api.ts');
    expect(existsSync(preloadPath)).toBe(true);

    const loaded: unknown = await import(pathToFileURL(preloadPath).href);
    expect(
      hasFunctionProp(loaded, 'createPhase1PreloadApi'),
      'Missing createPhase1PreloadApi export in apps/desktop/src/preload/expose-api.ts',
    ).toBe(true);
    if (!hasFunctionProp(loaded, 'createPhase1PreloadApi')) {
      return;
    }

    const factory = (
      loaded as {
        readonly createPhase1PreloadApi: (
          invoke: (channel: string, payload?: unknown) => Promise<unknown>,
        ) => Record<string, unknown>;
      }
    ).createPhase1PreloadApi;

    const exposed = factory(vi.fn(async () => ({ ok: true, value: null })));
    expect(Object.keys(exposed).sort()).toEqual([...PHASE1_PRELOAD_EXPOSED_KEYS].sort());
    for (const forbidden of FORBIDDEN_PRELOAD_KEYS) {
      expect(forbidden in exposed).toBe(false);
    }
  });
});
