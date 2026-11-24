import { z } from 'zod';
import { UuidSchema } from '../auth/contracts.js';
import { FileKindSchema, SafeVirtualPathSchema } from '../files/contracts.js';

export const QUICK_OPEN_ENTITY_TYPES = ['file', 'document', 'reference', 'figure'] as const;

export const QuickOpenEntityTypeSchema = z.enum(QUICK_OPEN_ENTITY_TYPES);

export type QuickOpenEntityType = z.infer<typeof QuickOpenEntityTypeSchema>;

export const QuickOpenItemSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  entityType: QuickOpenEntityTypeSchema,
  title: z.string().trim().min(1).max(240),
  subtitle: z.string().max(300),
  path: SafeVirtualPathSchema,
  kind: FileKindSchema,
  updatedAt: z.string().datetime(),
});

export type QuickOpenItem = z.infer<typeof QuickOpenItemSchema>;

export const QuickOpenQuerySchema = z.object({
  projectId: UuidSchema,
  query: z.string().max(200),
  limit: z.number().int().min(1).max(100).default(25),
});

export type QuickOpenQuery = z.infer<typeof QuickOpenQuerySchema>;

export const QuickOpenResultItemSchema = z.object({
  item: QuickOpenItemSchema,
  score: z.number().min(0),
});

export type QuickOpenResultItem = z.infer<typeof QuickOpenResultItemSchema>;

function scoreSubsequence(query: string, target: string): number {
  let queryIdx = 0;
  let streak = 0;
  let score = 0;
  for (let i = 0; i < target.length && queryIdx < query.length; i += 1) {
    if (target[i] === query[queryIdx]) {
      streak += 1;
      score += 5 + streak * 2;
      queryIdx += 1;
    } else {
      streak = 0;
    }
  }
  return queryIdx === query.length ? score : 0;
}

export function scoreQuickOpenItem(rawQuery: string, item: QuickOpenItem): number {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return 1;
  }
  const title = item.title.toLowerCase();
  const path = item.path.toLowerCase();
  if (title === query) {
    return 1000;
  }
  if (title.startsWith(query)) {
    return 700 - Math.min(title.length, 200);
  }
  if (title.includes(query)) {
    return 400 - title.indexOf(query);
  }
  if (path.includes(query)) {
    return 250 - path.indexOf(query);
  }
  const fuzzyTitle = scoreSubsequence(query, title);
  if (fuzzyTitle > 0) {
    return fuzzyTitle + 50;
  }
  return scoreSubsequence(query, path);
}

export function searchQuickOpenItems(
  items: readonly QuickOpenItem[],
  query: string,
  limit = 25,
): QuickOpenResultItem[] {
  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const scored: QuickOpenResultItem[] = [];
  for (const item of items) {
    const score = scoreQuickOpenItem(query, item);
    if (score > 0) {
      scored.push({ item, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, cappedLimit);
}

export const CONNECTIVITY_STATUSES = ['online', 'offline', 'reconnecting'] as const;

export const ConnectivityStatusSchema = z.enum(CONNECTIVITY_STATUSES);

export type ConnectivityStatus = z.infer<typeof ConnectivityStatusSchema>;

export const CachedArtifactRecordSchema = z.object({
  projectId: UuidSchema,
  artifactId: UuidSchema,
  artifactType: z.enum(['document', 'pdf', 'file']),
  title: z.string().trim().min(1).max(240),
  contentText: z.string().nullable(),
  localBlobPath: z.string().min(1).max(512).nullable(),
  serverVersion: z.number().int().min(1),
  cachedAt: z.string().datetime(),
  sizeBytes: z.number().int().min(0),
  readOnly: z.literal(true),
});

export type CachedArtifactRecord = z.infer<typeof CachedArtifactRecordSchema>;

export const GetCachedArtifactInputSchema = z.object({
  projectId: UuidSchema,
  artifactId: UuidSchema,
});

export type GetCachedArtifactInput = z.infer<typeof GetCachedArtifactInputSchema>;

export const OfflineDraftSyncStatusSchema = z.enum(['pending_sync', 'conflict', 'synced']);

export type OfflineDraftSyncStatus = z.infer<typeof OfflineDraftSyncStatusSchema>;

export const OfflineDraftRecordSchema = z.object({
  draftId: UuidSchema,
  projectId: UuidSchema,
  documentId: UuidSchema,
  baseServerVersion: z.number().int().min(1),
  payloadJson: z.string().min(2),
  updatedAt: z.string().datetime(),
  syncStatus: OfflineDraftSyncStatusSchema,
});

export type OfflineDraftRecord = z.infer<typeof OfflineDraftRecordSchema>;

export const SaveOfflineDraftInputSchema = z.object({
  draftId: UuidSchema,
  projectId: UuidSchema,
  documentId: UuidSchema,
  baseServerVersion: z.number().int().min(1),
  payloadJson: z.string().min(2),
});

export type SaveOfflineDraftInput = z.infer<typeof SaveOfflineDraftInputSchema>;

export const ListOfflineDraftsInputSchema = z.object({
  projectId: UuidSchema,
});

export type ListOfflineDraftsInput = z.infer<typeof ListOfflineDraftsInputSchema>;

export const ClearOfflineDraftInputSchema = z.object({
  draftId: UuidSchema,
});

export type ClearOfflineDraftInput = z.infer<typeof ClearOfflineDraftInputSchema>;

export const DraftReconciliationResultSchema = z.object({
  draftId: UuidSchema,
  documentId: UuidSchema,
  outcome: z.enum(['synced', 'conflict_requires_review', 'discarded']),
  serverVersion: z.number().int().min(1),
  conflictSummary: z.string().max(400).optional(),
});

export type DraftReconciliationResult = z.infer<typeof DraftReconciliationResultSchema>;
