import { z } from 'zod';
import { UuidSchema } from '../auth/contracts.js';
import { type ArtifactCategory, type FileKind } from '../files/contracts.js';
import { WindowStateSchema } from '../ipc/contracts.js';

export const SIDEBAR_CATEGORIES = [
  'overview',
  'references',
  'data',
  'analysis',
  'reports',
  'figures',
  'all_files',
] as const;

export const SidebarCategorySchema = z.enum(SIDEBAR_CATEGORIES);

export type SidebarCategory = z.infer<typeof SidebarCategorySchema>;

export const ARTIFACT_VIEW_TYPES = [
  'overview',
  'document',
  'pdf',
  'spreadsheet',
  'notebook',
  'code',
  'image',
  'diagram',
  'text_preview',
  'json_preview',
  'references',
  'literature_map',
  'unsupported',
] as const;

export const ArtifactViewTypeSchema = z.enum(ARTIFACT_VIEW_TYPES);

export type ArtifactViewType = z.infer<typeof ArtifactViewTypeSchema>;

const FILE_KIND_TO_VIEW_TYPE: Readonly<Record<FileKind, ArtifactViewType>> = {
  folder: 'overview',
  document: 'document',
  pdf: 'pdf',
  docx: 'document',
  text: 'text_preview',
  markdown: 'document',
  bibtex: 'references',
  ris: 'references',
  csv: 'spreadsheet',
  xlsx: 'spreadsheet',
  json: 'json_preview',
  notebook: 'notebook',
  code: 'code',
  mermaid: 'diagram',
  image: 'image',
  other: 'unsupported',
};

export function resolveArtifactViewType(kind: FileKind): ArtifactViewType {
  return FILE_KIND_TO_VIEW_TYPE[kind];
}

export function matchesSidebarCategory(
  sidebarCategory: SidebarCategory,
  artifactCategory: ArtifactCategory,
): boolean {
  if (sidebarCategory === 'all_files' || sidebarCategory === 'overview') {
    return true;
  }
  return sidebarCategory === artifactCategory;
}

export const WorkspaceTabSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: UuidSchema,
  artifactId: UuidSchema,
  title: z.string().trim().min(1).max(200),
  viewType: ArtifactViewTypeSchema,
  isDirty: z.boolean(),
  isPinned: z.boolean(),
  isReadOnly: z.boolean(),
});

export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;

export const ColumnWidthsSchema = z.object({
  leftSidebarPx: z.number().int().min(180).max(480),
  rightSidebarPx: z.number().int().min(240).max(640),
  leftCollapsed: z.boolean(),
  rightCollapsed: z.boolean(),
});

export type ColumnWidths = z.infer<typeof ColumnWidthsSchema>;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  leftSidebarPx: 260,
  rightSidebarPx: 360,
  leftCollapsed: false,
  rightCollapsed: false,
};

export const WorkspaceLayoutStateSchema = z.object({
  projectId: UuidSchema,
  activeCategory: SidebarCategorySchema,
  tabs: z.array(WorkspaceTabSchema).max(30),
  activeTabId: z.string().min(1).max(128).nullable(),
  columns: ColumnWidthsSchema,
  windowBounds: WindowStateSchema.optional(),
});

export type WorkspaceLayoutState = z.infer<typeof WorkspaceLayoutStateSchema>;

export const GetWorkspaceLayoutInputSchema = z.object({
  projectId: UuidSchema,
});

export type GetWorkspaceLayoutInput = z.infer<typeof GetWorkspaceLayoutInputSchema>;
