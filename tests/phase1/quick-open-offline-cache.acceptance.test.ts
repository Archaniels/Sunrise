import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CachedArtifactRecordSchema,
  DraftReconciliationResultSchema,
  OfflineDraftRecordSchema,
  type CachedArtifactRecord,
  type ConnectivityStatus,
  type DraftReconciliationResult,
  type OfflineDraftRecord,
  type QuickOpenItem,
  type QuickOpenResultItem,
  type Result,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface QuickOpenIndexLike {
  readonly search: (query: string, limit?: number) => QuickOpenResultItem[];
}

interface LocalCacheRepositoryLike {
  readonly putArtifact: (record: CachedArtifactRecord) => CachedArtifactRecord;
  readonly getArtifact: (projectId: string, artifactId: string) => CachedArtifactRecord | null;
  readonly saveDraft: (input: {
    readonly draftId: string;
    readonly projectId: string;
    readonly documentId: string;
    readonly baseServerVersion: number;
    readonly payloadJson: string;
  }) => OfflineDraftRecord;
  readonly listDrafts: (projectId: string) => OfflineDraftRecord[];
  readonly clearDraft: (draftId: string) => boolean;
}

interface ConnectivitySyncServiceLike {
  readonly getStatus: () => ConnectivityStatus;
  readonly setConnectivity: (status: ConnectivityStatus) => ConnectivityStatus;
  readonly reconcileDrafts: (projectId: string) => Promise<Result<DraftReconciliationResult[]>>;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

function buildOneThousandItems(projectId: string): QuickOpenItem[] {
  const items: QuickOpenItem[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const suffix = String(i).padStart(12, '0');
    items.push({
      id: `00000000-0000-4000-8000-${suffix}`,
      projectId,
      entityType: i % 4 === 0 ? 'document' : i % 4 === 1 ? 'reference' : i % 4 === 2 ? 'figure' : 'file',
      title: i === 512 ? 'Quantum_Error_Correction_Review.pdf' : `Item_${i}.md`,
      subtitle: 'Project artifact',
      path: i === 512 ? 'literature/Quantum_Error_Correction_Review.pdf' : `notes/Item_${i}.md`,
      kind: i === 512 ? 'pdf' : 'markdown',
      updatedAt: '2026-11-24T09:00:00.000Z',
    });
  }
  return items;
}

describe('Phase 1.4 Quick Open (Ctrl+P) and online-resilient local cache acceptance', () => {
  it('queries a 1,000-item project via Quick Open index in under 150ms', async () => {
    const indexPath = join(REPO_ROOT, 'apps/desktop/src/renderer/quick-open/quick-open-index.ts');
    expect(
      existsSync(indexPath),
      'Missing apps/desktop/src/renderer/quick-open/quick-open-index.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(indexPath).href);
    expect(hasFunctionProp(loaded, 'createQuickOpenIndex')).toBe(true);
    if (!hasFunctionProp(loaded, 'createQuickOpenIndex')) {
      return;
    }

    const factory = (
      loaded as { readonly createQuickOpenIndex: (items: readonly QuickOpenItem[]) => QuickOpenIndexLike }
    ).createQuickOpenIndex;
    const projectId = '11111111-1111-4111-8111-111111111111';
    const index = factory(buildOneThousandItems(projectId));

    const start = performance.now();
    const hits = index.search('quantum_error', 15);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(150);
    expect(hits[0]?.item.title).toBe('Quantum_Error_Correction_Review.pdf');
    expect(index.search('zzzz_no_match_999')).toEqual([]);
  });

  it('persists read-only cached artifacts and offline drafts in local SQLite cache repository', async () => {
    const repoPath = join(REPO_ROOT, 'apps/desktop/src/main/db/local-cache-repository.ts');
    expect(
      existsSync(repoPath),
      'Missing apps/desktop/src/main/db/local-cache-repository.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(repoPath).href);
    expect(hasFunctionProp(loaded, 'createLocalCacheRepository')).toBe(true);
    if (!hasFunctionProp(loaded, 'createLocalCacheRepository')) {
      return;
    }

    const factory = (
      loaded as { readonly createLocalCacheRepository: (dbPath: string) => LocalCacheRepositoryLike }
    ).createLocalCacheRepository;
    const repo = factory(':memory:');

    const projectId = '11111111-1111-4111-8111-111111111111';
    const artifactId = '22222222-2222-4222-8222-222222222222';
    const draftId = '33333333-3333-4333-8333-333333333333';

    const cached = repo.putArtifact({
      projectId,
      artifactId,
      artifactType: 'document',
      title: 'Chapter1.md',
      contentText: '# Chapter 1',
      localBlobPath: null,
      serverVersion: 2,
      cachedAt: '2026-11-24T09:00:00.000Z',
      sizeBytes: 11,
      readOnly: true,
    });
    expect(CachedArtifactRecordSchema.safeParse(cached).success).toBe(true);
    expect(repo.getArtifact(projectId, artifactId)?.readOnly).toBe(true);

    const draft = repo.saveDraft({
      draftId,
      projectId,
      documentId: artifactId,
      baseServerVersion: 2,
      payloadJson: '{"type":"doc","content":[]}',
    });
    expect(OfflineDraftRecordSchema.safeParse(draft).success).toBe(true);
    expect(repo.listDrafts(projectId)).toHaveLength(1);

    expect(repo.clearDraft(draftId)).toBe(true);
    expect(repo.listDrafts(projectId)).toHaveLength(0);
  });

  it('reconciles offline drafts safely on reconnect and flags version conflicts without overwriting', async () => {
    const syncPath = join(
      REPO_ROOT,
      'apps/desktop/src/main/services/connectivity-sync-service.ts',
    );
    expect(
      existsSync(syncPath),
      'Missing apps/desktop/src/main/services/connectivity-sync-service.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(syncPath).href);
    expect(hasFunctionProp(loaded, 'createConnectivitySyncService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createConnectivitySyncService')) {
      return;
    }

    const projectId = '11111111-1111-4111-8111-111111111111';
    const docClean = '22222222-2222-4222-8222-222222222222';
    const docConflict = '33333333-3333-4333-8333-333333333333';

    const pendingDrafts: OfflineDraftRecord[] = [
      {
        draftId: '44444444-4444-4444-8444-444444444444',
        projectId,
        documentId: docClean,
        baseServerVersion: 2,
        payloadJson: '{"type":"doc"}',
        updatedAt: '2026-11-24T09:05:00.000Z',
        syncStatus: 'pending_sync',
      },
      {
        draftId: '55555555-5555-4555-8555-555555555555',
        projectId,
        documentId: docConflict,
        baseServerVersion: 2,
        payloadJson: '{"type":"doc"}',
        updatedAt: '2026-11-24T09:06:00.000Z',
        syncStatus: 'pending_sync',
      },
    ];

    const factory = (
      loaded as {
        readonly createConnectivitySyncService: (deps: {
          readonly listDrafts: (pid: string) => Promise<OfflineDraftRecord[]>;
          readonly getRemoteVersion: (docId: string) => Promise<number>;
          readonly pushDraft: (draft: OfflineDraftRecord) => Promise<number>;
          readonly clearDraft: (draftId: string) => Promise<void>;
        }) => ConnectivitySyncServiceLike;
      }
    ).createConnectivitySyncService;

    const syncService = factory({
      listDrafts: async () => pendingDrafts,
      getRemoteVersion: async (docId) => (docId === docClean ? 2 : 5),
      pushDraft: async (draft) => draft.baseServerVersion + 1,
      clearDraft: async () => undefined,
    });

    expect(syncService.setConnectivity('offline')).toBe('offline');
    expect(syncService.setConnectivity('online')).toBe('online');

    const reconciled = await syncService.reconcileDrafts(projectId);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) {
      return;
    }

    expect(reconciled.value).toHaveLength(2);
    for (const item of reconciled.value) {
      expect(DraftReconciliationResultSchema.safeParse(item).success).toBe(true);
    }
    const cleanOutcome = reconciled.value.find((entry) => entry.documentId === docClean);
    const conflictOutcome = reconciled.value.find((entry) => entry.documentId === docConflict);
    expect(cleanOutcome?.outcome).toBe('synced');
    expect(conflictOutcome?.outcome).toBe('conflict_requires_review');
  });
});
