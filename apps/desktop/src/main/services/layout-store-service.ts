import {
  err,
  ok,
  UuidSchema,
  WorkspaceLayoutStateSchema,
  type Result,
  type WorkspaceLayoutState,
} from '@sunrise/shared';

export interface LayoutPersistenceAdapter {
  readonly read: (projectId: string) => Promise<WorkspaceLayoutState | null>;
  readonly write: (layout: WorkspaceLayoutState) => Promise<void>;
}

export interface LayoutStoreService {
  readonly saveLayout: (layout: WorkspaceLayoutState) => Promise<Result<WorkspaceLayoutState>>;
  readonly getLayout: (projectId: string) => Promise<Result<WorkspaceLayoutState | null>>;
}

export function createLayoutStoreService(
  persistence: LayoutPersistenceAdapter,
): LayoutStoreService {
  return {
    saveLayout: async (layout): Promise<Result<WorkspaceLayoutState>> => {
      const parsed = WorkspaceLayoutStateSchema.safeParse(layout);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid workspace layout payload',
        });
      }
      try {
        await persistence.write(parsed.data);
        return ok(parsed.data);
      } catch {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Failed to persist workspace layout',
        });
      }
    },

    getLayout: async (projectId): Promise<Result<WorkspaceLayoutState | null>> => {
      const parsedId = UuidSchema.safeParse(projectId);
      if (!parsedId.success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId for layout lookup' });
      }
      try {
        const stored = await persistence.read(parsedId.data);
        if (stored === null) {
          return ok(null);
        }
        const parsedLayout = WorkspaceLayoutStateSchema.safeParse(stored);
        if (!parsedLayout.success) {
          return err({ code: 'INTERNAL_ERROR', message: 'Stored workspace layout is invalid' });
        }
        return ok(parsedLayout.data);
      } catch {
        return err({ code: 'INTERNAL_ERROR', message: 'Failed to load workspace layout' });
      }
    },
  };
}

export function createInMemoryLayoutStoreService(): LayoutStoreService {
  const layouts = new Map<string, WorkspaceLayoutState>();
  return createLayoutStoreService({
    read: async (projectId) => layouts.get(projectId) ?? null,
    write: async (layout) => {
      layouts.set(layout.projectId, layout);
    },
  });
}
