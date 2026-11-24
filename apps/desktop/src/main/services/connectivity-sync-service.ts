import {
  ConnectivityStatusSchema,
  DraftReconciliationResultSchema,
  err,
  ok,
  UuidSchema,
  type ConnectivityStatus,
  type DraftReconciliationResult,
  type OfflineDraftRecord,
  type Result,
} from '@sunrise/shared';

export interface ConnectivitySyncDeps {
  readonly listDrafts: (projectId: string) => Promise<OfflineDraftRecord[]>;
  readonly getRemoteVersion: (documentId: string) => Promise<number>;
  readonly pushDraft: (draft: OfflineDraftRecord) => Promise<number>;
  readonly clearDraft: (draftId: string) => Promise<void>;
}

export interface ConnectivitySyncService {
  readonly getStatus: () => ConnectivityStatus;
  readonly setConnectivity: (status: ConnectivityStatus) => ConnectivityStatus;
  readonly reconcileDrafts: (projectId: string) => Promise<Result<DraftReconciliationResult[]>>;
}

async function reconcileSingleDraft(
  draft: OfflineDraftRecord,
  deps: ConnectivitySyncDeps,
): Promise<DraftReconciliationResult> {
  const remoteVersion = await deps.getRemoteVersion(draft.documentId);
  if (remoteVersion > draft.baseServerVersion) {
    return DraftReconciliationResultSchema.parse({
      draftId: draft.draftId,
      documentId: draft.documentId,
      outcome: 'conflict_requires_review',
      serverVersion: remoteVersion,
      conflictSummary: `Remote version ${remoteVersion} is newer than draft base version ${draft.baseServerVersion}`,
    });
  }
  const nextVersion = await deps.pushDraft(draft);
  await deps.clearDraft(draft.draftId);
  return DraftReconciliationResultSchema.parse({
    draftId: draft.draftId,
    documentId: draft.documentId,
    outcome: 'synced',
    serverVersion: nextVersion,
  });
}

export function createConnectivitySyncService(
  deps: ConnectivitySyncDeps,
  initialStatus: ConnectivityStatus = 'online',
): ConnectivitySyncService {
  let status: ConnectivityStatus = ConnectivityStatusSchema.parse(initialStatus);

  return {
    getStatus: (): ConnectivityStatus => status,

    setConnectivity: (nextStatus): ConnectivityStatus => {
      status = ConnectivityStatusSchema.parse(nextStatus);
      return status;
    },

    reconcileDrafts: async (projectId): Promise<Result<DraftReconciliationResult[]>> => {
      const validProjectId = UuidSchema.safeParse(projectId);
      if (!validProjectId.success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId for draft sync' });
      }
      if (status !== 'online') {
        return err({
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Cannot reconcile offline drafts while disconnected',
        });
      }
      try {
        const drafts = await deps.listDrafts(validProjectId.data);
        const outcomes: DraftReconciliationResult[] = [];
        for (const draft of drafts) {
          outcomes.push(await reconcileSingleDraft(draft, deps));
        }
        return ok(outcomes);
      } catch {
        return err({
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Failed to reconcile offline drafts with remote API',
        });
      }
    },
  };
}
