import { z } from 'zod';
import { UuidSchema } from '../auth/contracts.js';
import { err, ok, type Result } from '../result.js';

export const ARTIFACT_CATEGORIES = [
  'data',
  'analysis',
  'reports',
  'figures',
  'references',
  'general',
] as const;

export const ArtifactCategorySchema = z.enum(ARTIFACT_CATEGORIES);

export type ArtifactCategory = z.infer<typeof ArtifactCategorySchema>;

export const FILE_KINDS = [
  'folder',
  'document',
  'pdf',
  'docx',
  'text',
  'markdown',
  'bibtex',
  'ris',
  'csv',
  'xlsx',
  'json',
  'notebook',
  'code',
  'mermaid',
  'image',
  'other',
] as const;

export const FileKindSchema = z.enum(FILE_KINDS);

export type FileKind = z.infer<typeof FileKindSchema>;

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const RESERVED_SEGMENT_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

function isInvalidPathSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') {
    return true;
  }
  if (segment.includes(':') || /[\u0000-\u001F\u007F]/.test(segment)) {
    return true;
  }
  const baseName = segment.split('.')[0]?.toLowerCase() ?? '';
  return RESERVED_SEGMENT_NAMES.has(baseName);
}

export function validateSafeVirtualPath(rawPath: string): Result<string> {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return err({ code: 'VALIDATION_ERROR', message: 'Virtual path length out of bounds' });
  }
  if (trimmed.includes('\\') || trimmed.startsWith('/') || trimmed.endsWith('/')) {
    return err({ code: 'VALIDATION_ERROR', message: 'Virtual path contains forbidden separators' });
  }
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (isInvalidPathSegment(segment)) {
      return err({
        code: 'VALIDATION_ERROR',
        message: 'Virtual path contains invalid or traversal segment',
      });
    }
  }
  return ok(trimmed);
}

export const SafeFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\') && !isInvalidPathSegment(name), {
    message: 'File name contains forbidden path characters or reserved name',
  });

export const SafeVirtualPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => validateSafeVirtualPath(value).ok, {
    message: 'Virtual path must be a normalized relative path without traversal segments',
  });

export interface FileClassification {
  readonly kind: FileKind;
  readonly mimeType: string;
  readonly category: ArtifactCategory;
}

const EXTENSION_MAP: Readonly<Record<string, FileClassification>> = {
  pdf: { kind: 'pdf', mimeType: 'application/pdf', category: 'references' },
  docx: {
    kind: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'reports',
  },
  txt: { kind: 'text', mimeType: 'text/plain', category: 'general' },
  md: { kind: 'markdown', mimeType: 'text/markdown', category: 'reports' },
  markdown: { kind: 'markdown', mimeType: 'text/markdown', category: 'reports' },
  bib: { kind: 'bibtex', mimeType: 'application/x-bibtex', category: 'references' },
  ris: { kind: 'ris', mimeType: 'application/x-research-info-systems', category: 'references' },
  csv: { kind: 'csv', mimeType: 'text/csv', category: 'data' },
  xlsx: {
    kind: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'data',
  },
  json: { kind: 'json', mimeType: 'application/json', category: 'data' },
  ipynb: { kind: 'notebook', mimeType: 'application/x-ipynb+json', category: 'analysis' },
  py: { kind: 'code', mimeType: 'text/x-python', category: 'analysis' },
  r: { kind: 'code', mimeType: 'text/x-r', category: 'analysis' },
  sql: { kind: 'code', mimeType: 'application/sql', category: 'analysis' },
  ts: { kind: 'code', mimeType: 'text/typescript', category: 'analysis' },
  tsx: { kind: 'code', mimeType: 'text/typescript', category: 'analysis' },
  js: { kind: 'code', mimeType: 'text/javascript', category: 'analysis' },
  sh: { kind: 'code', mimeType: 'text/x-shellscript', category: 'analysis' },
  mmd: { kind: 'mermaid', mimeType: 'text/vnd.mermaid', category: 'figures' },
  mermaid: { kind: 'mermaid', mimeType: 'text/vnd.mermaid', category: 'figures' },
  png: { kind: 'image', mimeType: 'image/png', category: 'figures' },
  jpg: { kind: 'image', mimeType: 'image/jpeg', category: 'figures' },
  jpeg: { kind: 'image', mimeType: 'image/jpeg', category: 'figures' },
  svg: { kind: 'image', mimeType: 'image/svg+xml', category: 'figures' },
  webp: { kind: 'image', mimeType: 'image/webp', category: 'figures' },
  gif: { kind: 'image', mimeType: 'image/gif', category: 'figures' },
};

export function classifyFileByName(fileName: string): FileClassification {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { kind: 'other', mimeType: 'application/octet-stream', category: 'general' };
  }
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return (
    EXTENSION_MAP[ext] ?? {
      kind: 'other',
      mimeType: 'application/octet-stream',
      category: 'general',
    }
  );
}

export const ProjectFileNodeSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: SafeFileNameSchema,
  virtualPath: SafeVirtualPathSchema,
  isFolder: z.boolean(),
  kind: FileKindSchema,
  category: ArtifactCategorySchema,
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  s3Key: z.string().min(1).max(512).nullable(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  version: z.number().int().min(1),
  createdBy: UuidSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

export type ProjectFileNode = z.infer<typeof ProjectFileNodeSchema>;

export const CreateFolderInputSchema = z.object({
  projectId: UuidSchema,
  parentId: UuidSchema.nullable(),
  name: SafeFileNameSchema,
});

export type CreateFolderInput = z.infer<typeof CreateFolderInputSchema>;

export const UploadFileInputSchema = z.object({
  projectId: UuidSchema,
  parentId: UuidSchema.nullable(),
  fileName: SafeFileNameSchema,
  mimeType: z.string().min(1).max(160).optional(),
  sizeBytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  contentBase64: z.string().max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4).optional(),
});

export type UploadFileInput = z.infer<typeof UploadFileInputSchema>;

export const RenameFileInputSchema = z.object({
  fileId: UuidSchema,
  newName: SafeFileNameSchema,
});

export type RenameFileInput = z.infer<typeof RenameFileInputSchema>;

export const MoveFileInputSchema = z.object({
  fileId: UuidSchema,
  targetParentId: UuidSchema.nullable(),
});

export type MoveFileInput = z.infer<typeof MoveFileInputSchema>;

export const DuplicateFileInputSchema = z.object({
  fileId: UuidSchema,
  targetParentId: UuidSchema.nullable().optional(),
  newName: SafeFileNameSchema.optional(),
});

export type DuplicateFileInput = z.infer<typeof DuplicateFileInputSchema>;

export const DeleteFileInputSchema = z.object({
  fileId: UuidSchema,
  softDelete: z.boolean().default(true),
});

export type DeleteFileInput = z.infer<typeof DeleteFileInputSchema>;

export const SearchFilesInputSchema = z.object({
  projectId: UuidSchema,
  query: z.string().trim().max(200),
  category: ArtifactCategorySchema.optional(),
  kind: FileKindSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>;

export const DownloadFileResponseSchema = z.object({
  fileId: UuidSchema,
  fileName: SafeFileNameSchema,
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().min(0),
  downloadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export type DownloadFileResponse = z.infer<typeof DownloadFileResponseSchema>;

export const FilePreviewResponseSchema = z.discriminatedUnion('previewType', [
  z.object({
    previewType: z.literal('text'),
    fileId: UuidSchema,
    mimeType: z.string().min(1).max(160),
    content: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    previewType: z.literal('json'),
    fileId: UuidSchema,
    mimeType: z.literal('application/json'),
    formattedJson: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    previewType: z.literal('image'),
    fileId: UuidSchema,
    mimeType: z.string().min(1).max(160),
    previewUrl: z.string().url(),
    truncated: z.literal(false),
  }),
  z.object({
    previewType: z.literal('binary'),
    fileId: UuidSchema,
    mimeType: z.string().min(1).max(160),
    sizeBytes: z.number().int().min(0),
    truncated: z.literal(false),
  }),
]);

export type FilePreviewResponse = z.infer<typeof FilePreviewResponseSchema>;

export const PickLocalFilesInputSchema = z.object({
  multiple: z.boolean().default(true),
  allowedExtensions: z.array(z.string().regex(/^[a-zA-Z0-9]{1,16}$/)).max(32).optional(),
});

export type PickLocalFilesInput = z.infer<typeof PickLocalFilesInputSchema>;

export const PickedLocalFileSchema = z.object({
  fileToken: z.string().min(8).max(128),
  fileName: SafeFileNameSchema,
  sizeBytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  mimeType: z.string().min(1).max(160),
});

export type PickedLocalFile = z.infer<typeof PickedLocalFileSchema>;

export const PickLocalFilesOutputSchema = z.object({
  canceled: z.boolean(),
  files: z.array(PickedLocalFileSchema),
});

export type PickLocalFilesOutput = z.infer<typeof PickLocalFilesOutputSchema>;

export const SaveLocalFileInputSchema = z.object({
  suggestedName: SafeFileNameSchema,
  contentBase64: z.string().min(1).max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4),
});

export type SaveLocalFileInput = z.infer<typeof SaveLocalFileInputSchema>;

export const SaveLocalFileOutputSchema = z.object({
  saved: z.boolean(),
  canceled: z.boolean(),
  savedFileName: SafeFileNameSchema.optional(),
});

export type SaveLocalFileOutput = z.infer<typeof SaveLocalFileOutputSchema>;
