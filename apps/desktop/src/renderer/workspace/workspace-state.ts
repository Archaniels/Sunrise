import {
  ColumnWidthsSchema,
  DEFAULT_COLUMN_WIDTHS,
  matchesSidebarCategory,
  resolveArtifactViewType,
  SidebarCategorySchema,
  UuidSchema,
  WorkspaceLayoutStateSchema,
  WorkspaceTabSchema,
  type ArtifactCategory,
  type ColumnWidths,
  type FileKind,
  type SidebarCategory,
  type WorkspaceLayoutState,
  type WorkspaceTab,
} from '@sunrise/shared';

export interface OpenArtifactTabInput {
  readonly artifactId: string;
  readonly title: string;
  readonly kind: FileKind;
  readonly isReadOnly?: boolean;
}

export interface WorkspaceController {
  readonly getState: () => WorkspaceLayoutState;
  readonly selectCategory: (category: SidebarCategory) => WorkspaceLayoutState;
  readonly openArtifactTab: (input: OpenArtifactTabInput) => WorkspaceLayoutState;
  readonly activateTab: (tabId: string) => WorkspaceLayoutState;
  readonly closeTab: (tabId: string) => WorkspaceLayoutState;
  readonly setTabDirty: (tabId: string, isDirty: boolean) => WorkspaceLayoutState;
  readonly toggleLeftSidebar: () => WorkspaceLayoutState;
  readonly toggleRightSidebar: () => WorkspaceLayoutState;
  readonly setColumnWidths: (patch: Partial<ColumnWidths>) => WorkspaceLayoutState;
  readonly filterArtifacts: <T extends { readonly category: ArtifactCategory }>(
    items: readonly T[],
  ) => T[];
}

const MAX_WORKSPACE_TABS = 30;

function cloneLayoutState(state: WorkspaceLayoutState): WorkspaceLayoutState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
    columns: { ...state.columns },
    ...(state.windowBounds ? { windowBounds: { ...state.windowBounds } } : {}),
  };
}

function buildInitialLayout(
  projectId: string,
  initialLayout?: WorkspaceLayoutState,
): WorkspaceLayoutState {
  const validProjectId = UuidSchema.parse(projectId);
  if (initialLayout) {
    const parsed = WorkspaceLayoutStateSchema.safeParse(initialLayout);
    if (parsed.success && parsed.data.projectId === validProjectId) {
      return cloneLayoutState(parsed.data);
    }
  }
  return WorkspaceLayoutStateSchema.parse({
    projectId: validProjectId,
    activeCategory: 'overview',
    tabs: [],
    activeTabId: null,
    columns: DEFAULT_COLUMN_WIDTHS,
  });
}

function evictTabIfAtCapacity(tabs: readonly WorkspaceTab[]): WorkspaceTab[] {
  if (tabs.length < MAX_WORKSPACE_TABS) {
    return [...tabs];
  }
  const evictIndex = tabs.findIndex((tab) => !tab.isPinned);
  const indexToDrop = evictIndex >= 0 ? evictIndex : 0;
  return tabs.filter((_tab, idx) => idx !== indexToDrop);
}

export function createWorkspaceController(
  projectId: string,
  initialLayout?: WorkspaceLayoutState,
): WorkspaceController {
  let state = buildInitialLayout(projectId, initialLayout);

  return {
    getState: (): WorkspaceLayoutState => cloneLayoutState(state),

    selectCategory: (category): WorkspaceLayoutState => {
      const parsed = SidebarCategorySchema.parse(category);
      state = { ...state, activeCategory: parsed };
      return cloneLayoutState(state);
    },

    openArtifactTab: (input): WorkspaceLayoutState => {
      const existing = state.tabs.find((tab) => tab.artifactId === input.artifactId);
      if (existing) {
        state = { ...state, activeTabId: existing.id };
        return cloneLayoutState(state);
      }
      const nextTab = WorkspaceTabSchema.parse({
        id: `tab:${input.artifactId}`,
        projectId: state.projectId,
        artifactId: input.artifactId,
        title: input.title,
        viewType: resolveArtifactViewType(input.kind),
        isDirty: false,
        isPinned: false,
        isReadOnly: input.isReadOnly ?? false,
      });
      const nextTabs = [...evictTabIfAtCapacity(state.tabs), nextTab];
      state = { ...state, tabs: nextTabs, activeTabId: nextTab.id };
      return cloneLayoutState(state);
    },

    activateTab: (tabId): WorkspaceLayoutState => {
      if (state.tabs.some((tab) => tab.id === tabId)) {
        state = { ...state, activeTabId: tabId };
      }
      return cloneLayoutState(state);
    },

    closeTab: (tabId): WorkspaceLayoutState => {
      const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
      if (closedIndex < 0) {
        return cloneLayoutState(state);
      }
      const remaining = state.tabs.filter((tab) => tab.id !== tabId);
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        const fallbackIndex = Math.min(closedIndex, remaining.length - 1);
        nextActiveId = fallbackIndex >= 0 ? (remaining[fallbackIndex]?.id ?? null) : null;
      }
      state = { ...state, tabs: remaining, activeTabId: nextActiveId };
      return cloneLayoutState(state);
    },

    setTabDirty: (tabId, isDirty): WorkspaceLayoutState => {
      state = {
        ...state,
        tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, isDirty } : tab)),
      };
      return cloneLayoutState(state);
    },

    toggleLeftSidebar: (): WorkspaceLayoutState => {
      state = {
        ...state,
        columns: { ...state.columns, leftCollapsed: !state.columns.leftCollapsed },
      };
      return cloneLayoutState(state);
    },

    toggleRightSidebar: (): WorkspaceLayoutState => {
      state = {
        ...state,
        columns: { ...state.columns, rightCollapsed: !state.columns.rightCollapsed },
      };
      return cloneLayoutState(state);
    },

    setColumnWidths: (patch): WorkspaceLayoutState => {
      const parsed = ColumnWidthsSchema.parse({ ...state.columns, ...patch });
      state = { ...state, columns: parsed };
      return cloneLayoutState(state);
    },

    filterArtifacts: (items) =>
      items.filter((item) => matchesSidebarCategory(state.activeCategory, item.category)),
  };
}
