import Database from 'better-sqlite3';
import {
  CachedArtifactRecordSchema,
  OfflineDraftRecordSchema,
  SaveOfflineDraftInputSchema,
  UuidSchema,
  type CachedArtifactRecord,
  type OfflineDraftRecord,
  type SaveOfflineDraftInput,
} from '@sunrise/shared';

export interface LocalCacheRepository {
  readonly putArtifact: (record: CachedArtifactRecord) => CachedArtifactRecord;
  readonly getArtifact: (projectId: string, artifactId: string) => CachedArtifactRecord | null;
  readonly saveDraft: (input: SaveOfflineDraftInput) => OfflineDraftRecord;
  readonly listDrafts: (projectId: string) => OfflineDraftRecord[];
  readonly clearDraft: (draftId: string) => boolean;
  readonly close: () => void;
}

const INIT_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cached_artifacts (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_text TEXT,
  local_blob_path TEXT,
  server_version INTEGER NOT NULL,
  cached_at TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 1 CHECK (read_only = 1),
  PRIMARY KEY (project_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS offline_drafts (
  draft_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  base_server_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sync_status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offline_drafts_project ON offline_drafts(project_id, updated_at);
`;

function mapArtifactRow(row: unknown): CachedArtifactRecord | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const parsed = CachedArtifactRecordSchema.safeParse({
    projectId: Reflect.get(row, 'project_id'),
    artifactId: Reflect.get(row, 'artifact_id'),
    artifactType: Reflect.get(row, 'artifact_type'),
    title: Reflect.get(row, 'title'),
    contentText: Reflect.get(row, 'content_text'),
    localBlobPath: Reflect.get(row, 'local_blob_path'),
    serverVersion: Reflect.get(row, 'server_version'),
    cachedAt: Reflect.get(row, 'cached_at'),
    sizeBytes: Reflect.get(row, 'size_bytes'),
    readOnly: Reflect.get(row, 'read_only') === 1,
  });
  return parsed.success ? parsed.data : null;
}

function mapDraftRow(row: unknown): OfflineDraftRecord | null {
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const parsed = OfflineDraftRecordSchema.safeParse({
    draftId: Reflect.get(row, 'draft_id'),
    projectId: Reflect.get(row, 'project_id'),
    documentId: Reflect.get(row, 'document_id'),
    baseServerVersion: Reflect.get(row, 'base_server_version'),
    payloadJson: Reflect.get(row, 'payload_json'),
    updatedAt: Reflect.get(row, 'updated_at'),
    syncStatus: Reflect.get(row, 'sync_status'),
  });
  return parsed.success ? parsed.data : null;
}

export function createLocalCacheRepository(
  dbPath: string,
  now: () => Date = () => new Date(),
): LocalCacheRepository {
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(INIT_CACHE_SCHEMA_SQL);

  const upsertArtifactStmt = db.prepare(`
    INSERT INTO cached_artifacts (
      project_id, artifact_id, artifact_type, title, content_text,
      local_blob_path, server_version, cached_at, size_bytes, read_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT (project_id, artifact_id) DO UPDATE SET
      artifact_type = excluded.artifact_type,
      title = excluded.title,
      content_text = excluded.content_text,
      local_blob_path = excluded.local_blob_path,
      server_version = excluded.server_version,
      cached_at = excluded.cached_at,
      size_bytes = excluded.size_bytes,
      read_only = 1
  `);

  const selectArtifactStmt = db.prepare(`
    SELECT project_id, artifact_id, artifact_type, title, content_text,
           local_blob_path, server_version, cached_at, size_bytes, read_only
    FROM cached_artifacts
    WHERE project_id = ? AND artifact_id = ?
  `);

  const upsertDraftStmt = db.prepare(`
    INSERT INTO offline_drafts (
      draft_id, project_id, document_id, base_server_version,
      payload_json, updated_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (draft_id) DO UPDATE SET
      base_server_version = excluded.base_server_version,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at,
      sync_status = excluded.sync_status
  `);

  const listDraftsStmt = db.prepare(`
    SELECT draft_id, project_id, document_id, base_server_version,
           payload_json, updated_at, sync_status
    FROM offline_drafts
    WHERE project_id = ?
    ORDER BY updated_at DESC
  `);

  const deleteDraftStmt = db.prepare('DELETE FROM offline_drafts WHERE draft_id = ?');

  return {
    putArtifact: (record): CachedArtifactRecord => {
      const parsed = CachedArtifactRecordSchema.parse(record);
      upsertArtifactStmt.run(
        parsed.projectId,
        parsed.artifactId,
        parsed.artifactType,
        parsed.title,
        parsed.contentText,
        parsed.localBlobPath,
        parsed.serverVersion,
        parsed.cachedAt,
        parsed.sizeBytes,
      );
      return parsed;
    },

    getArtifact: (projectId, artifactId): CachedArtifactRecord | null => {
      if (!UuidSchema.safeParse(projectId).success || !UuidSchema.safeParse(artifactId).success) {
        return null;
      }
      return mapArtifactRow(selectArtifactStmt.get(projectId, artifactId));
    },

    saveDraft: (input): OfflineDraftRecord => {
      const parsed = SaveOfflineDraftInputSchema.parse(input);
      const record = OfflineDraftRecordSchema.parse({
        ...parsed,
        updatedAt: now().toISOString(),
        syncStatus: 'pending_sync',
      });
      upsertDraftStmt.run(
        record.draftId,
        record.projectId,
        record.documentId,
        record.baseServerVersion,
        record.payloadJson,
        record.updatedAt,
        record.syncStatus,
      );
      return record;
    },

    listDrafts: (projectId): OfflineDraftRecord[] => {
      if (!UuidSchema.safeParse(projectId).success) {
        return [];
      }
      const rows = listDraftsStmt.all(projectId);
      const results: OfflineDraftRecord[] = [];
      for (const row of rows) {
        const mapped = mapDraftRow(row);
        if (mapped) {
          results.push(mapped);
        }
      }
      return results;
    },

    clearDraft: (draftId): boolean => {
      if (!UuidSchema.safeParse(draftId).success) {
        return false;
      }
      const info = deleteDraftStmt.run(draftId);
      return info.changes > 0;
    },

    close: (): void => {
      db.close();
    },
  };
}
