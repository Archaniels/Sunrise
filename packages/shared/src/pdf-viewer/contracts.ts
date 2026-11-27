import { z } from 'zod';
import { canRolePerform, type ProjectRole, UuidSchema } from '../auth/contracts.js';
import { CiteKeySchema } from '../references/contracts.js';

export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 4.0;
export const PDF_DEFAULT_ZOOM = 1.0;

export const PDF_HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;

export const PdfHighlightColorSchema = z.enum(PDF_HIGHLIGHT_COLORS);

export type PdfHighlightColor = z.infer<typeof PdfHighlightColorSchema>;

export const PDF_SELECTION_ACTIONS = ['copy_citation', 'create_note', 'ask_raven'] as const;

export const PdfSelectionActionTypeSchema = z.enum(PDF_SELECTION_ACTIONS);

export type PdfSelectionActionType = z.infer<typeof PdfSelectionActionTypeSchema>;

export const PdfRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
});

export type PdfRect = z.infer<typeof PdfRectSchema>;

export const PdfDeepLinkTargetSchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable(),
  pageNumber: z.number().int().min(1).max(10000),
  highlightId: UuidSchema.nullable(),
  searchExcerpt: z.string().trim().min(1).max(500).nullable(),
});

export type PdfDeepLinkTarget = z.infer<typeof PdfDeepLinkTargetSchema>;

export const PdfAnnotationSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable(),
  pageNumber: z.number().int().min(1).max(10000),
  selectedText: z.string().trim().min(1).max(10000),
  note: z.string().max(20000),
  color: PdfHighlightColorSchema,
  rects: z.array(PdfRectSchema).min(1).max(100),
  createdBy: UuidSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PdfAnnotation = z.infer<typeof PdfAnnotationSchema>;

export const CreatePdfAnnotationInputSchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable().default(null),
  pageNumber: z.number().int().min(1).max(10000),
  selectedText: z.string().trim().min(1).max(10000),
  note: z.string().max(20000).default(''),
  color: PdfHighlightColorSchema.default('yellow'),
  rects: z.array(PdfRectSchema).min(1).max(100),
});

export type CreatePdfAnnotationInput = z.input<typeof CreatePdfAnnotationInputSchema>;

export const UpdatePdfAnnotationInputSchema = z.object({
  note: z.string().max(20000).optional(),
  color: PdfHighlightColorSchema.optional(),
});

export type UpdatePdfAnnotationInput = z.infer<typeof UpdatePdfAnnotationInputSchema>;

export const DeletePdfAnnotationInputSchema = z.object({
  projectId: UuidSchema,
  annotationId: UuidSchema,
});

export type DeletePdfAnnotationInput = z.infer<typeof DeletePdfAnnotationInputSchema>;

export const ListPdfAnnotationsQuerySchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.optional(),
  pageNumber: z.number().int().min(1).max(10000).optional(),
});

export type ListPdfAnnotationsQuery = z.infer<typeof ListPdfAnnotationsQuerySchema>;

export const PdfSearchMatchSchema = z.object({
  pageNumber: z.number().int().min(1).max(10000),
  matchIndex: z.number().int().min(0),
  excerpt: z.string().min(1).max(500),
});

export type PdfSearchMatch = z.infer<typeof PdfSearchMatchSchema>;

export const PdfViewerStateSchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable(),
  currentPage: z.number().int().min(1).max(10000),
  totalPages: z.number().int().min(1).max(10000),
  zoom: z.number().min(PDF_MIN_ZOOM).max(PDF_MAX_ZOOM),
  thumbnailsOpen: z.boolean(),
  searchQuery: z.string().max(300),
  searchMatches: z.array(PdfSearchMatchSchema),
  activeMatchIndex: z.number().int().min(-1),
  isReadOnly: z.boolean(),
});

export type PdfViewerState = z.infer<typeof PdfViewerStateSchema>;

export const GetPdfViewerStateInputSchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
});

export type GetPdfViewerStateInput = z.infer<typeof GetPdfViewerStateInputSchema>;

export const PdfSelectionContextSchema = z.object({
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable(),
  citeKey: CiteKeySchema.nullable(),
  pageNumber: z.number().int().min(1).max(10000),
  selectedText: z.string().trim().min(1).max(10000),
  rects: z.array(PdfRectSchema).min(1).max(100),
});

export type PdfSelectionContext = z.infer<typeof PdfSelectionContextSchema>;

export const PdfCopyCitationPayloadSchema = z.object({
  action: z.literal('copy_citation'),
  referenceId: UuidSchema.nullable(),
  citeKey: CiteKeySchema.nullable(),
  pageNumber: z.number().int().min(1).max(10000),
  formattedCitation: z.string().trim().min(1).max(500),
  selectedText: z.string().trim().min(1).max(10000),
});

export type PdfCopyCitationPayload = z.infer<typeof PdfCopyCitationPayloadSchema>;

export const PdfCreateNotePayloadSchema = z.object({
  action: z.literal('create_note'),
  projectId: UuidSchema,
  fileId: UuidSchema,
  referenceId: UuidSchema.nullable(),
  pageNumber: z.number().int().min(1).max(10000),
  selectedText: z.string().trim().min(1).max(10000),
  rects: z.array(PdfRectSchema).min(1).max(100),
  color: PdfHighlightColorSchema,
});

export type PdfCreateNotePayload = z.infer<typeof PdfCreateNotePayloadSchema>;

export const PdfAskRavenPayloadSchema = z.object({
  action: z.literal('ask_raven'),
  projectId: UuidSchema,
  attachedFileIds: z.array(UuidSchema).min(1),
  attachedReferenceIds: z.array(UuidSchema),
  sourceContext: z.object({
    fileId: UuidSchema,
    referenceId: UuidSchema.nullable(),
    pageNumber: z.number().int().min(1).max(10000),
    selectedText: z.string().trim().min(1).max(10000),
  }),
});

export type PdfAskRavenPayload = z.infer<typeof PdfAskRavenPayloadSchema>;

export const PdfSelectionActionPayloadSchema = z.discriminatedUnion('action', [
  PdfCopyCitationPayloadSchema,
  PdfCreateNotePayloadSchema,
  PdfAskRavenPayloadSchema,
]);

export type PdfSelectionActionPayload = z.infer<typeof PdfSelectionActionPayloadSchema>;

export function canRoleMutatePdfAnnotations(role: ProjectRole): boolean {
  return canRolePerform(role, 'write_files');
}

export function clampPdfPage(pageNumber: number, totalPages: number): number {
  const safeTotal = Math.max(1, Math.floor(totalPages));
  const safePage = Math.floor(pageNumber);
  return Math.min(safeTotal, Math.max(1, safePage));
}

export function clampPdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return PDF_DEFAULT_ZOOM;
  }
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, Math.round(zoom * 100) / 100));
}

export function buildPdfCopyCitationPayload(
  selection: PdfSelectionContext,
): PdfCopyCitationPayload {
  const formattedCitation =
    selection.citeKey !== null
      ? `[@${selection.citeKey}, p. ${selection.pageNumber}]`
      : `[p. ${selection.pageNumber}]`;
  return {
    action: 'copy_citation',
    referenceId: selection.referenceId,
    citeKey: selection.citeKey,
    pageNumber: selection.pageNumber,
    formattedCitation,
    selectedText: selection.selectedText,
  };
}

export function buildPdfCreateNotePayload(
  selection: PdfSelectionContext,
  color: PdfHighlightColor = 'yellow',
): PdfCreateNotePayload {
  return {
    action: 'create_note',
    projectId: selection.projectId,
    fileId: selection.fileId,
    referenceId: selection.referenceId,
    pageNumber: selection.pageNumber,
    selectedText: selection.selectedText,
    rects: selection.rects,
    color,
  };
}

export function buildPdfAskRavenPayload(selection: PdfSelectionContext): PdfAskRavenPayload {
  return {
    action: 'ask_raven',
    projectId: selection.projectId,
    attachedFileIds: [selection.fileId],
    attachedReferenceIds: selection.referenceId !== null ? [selection.referenceId] : [],
    sourceContext: {
      fileId: selection.fileId,
      referenceId: selection.referenceId,
      pageNumber: selection.pageNumber,
      selectedText: selection.selectedText,
    },
  };
}
