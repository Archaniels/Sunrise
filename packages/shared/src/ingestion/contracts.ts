import { z } from 'zod';
import { UuidSchema } from '../auth/contracts.js';
import { SafeFileNameSchema } from '../files/contracts.js';
import {
  CanonicalDoiSchema,
  DuplicateReferenceConflictSchema,
  DuplicateReferenceResolutionSchema,
  normalizeDoi,
  ReferenceAuthorSchema,
  ReferenceSchema,
  ReferenceTagSchema,
} from '../references/contracts.js';

export const BIBLIOGRAPHY_FORMATS = ['bibtex', 'ris'] as const;

export const BibliographyFormatSchema = z.enum(BIBLIOGRAPHY_FORMATS);

export type BibliographyFormat = z.infer<typeof BibliographyFormatSchema>;

export const PDF_EXTRACTION_METHODS = [
  'doi_hydrated',
  'xmp_and_text_heuristic',
  'byok_llm_fallback',
] as const;

export const PdfExtractionMethodSchema = z.enum(PDF_EXTRACTION_METHODS);

export type PdfExtractionMethod = z.infer<typeof PdfExtractionMethodSchema>;

export const IngestDoiInputSchema = z.object({
  projectId: UuidSchema,
  doi: z.string().trim().min(1).max(256),
  tags: z.array(ReferenceTagSchema).max(50).default([]),
  onDuplicate: DuplicateReferenceResolutionSchema.default('prompt'),
});

export type IngestDoiInput = z.input<typeof IngestDoiInputSchema>;

export const IngestDoiResponseSchema = z.object({
  status: z.enum(['created', 'merged', 'updated', 'skipped', 'conflict']),
  canonicalDoi: CanonicalDoiSchema,
  hydratedFrom: z.enum(['crossref', 'openalex']),
  reference: ReferenceSchema.nullable(),
  conflict: DuplicateReferenceConflictSchema.nullable(),
});

export type IngestDoiResponse = z.infer<typeof IngestDoiResponseSchema>;

export const MAX_BIBLIOGRAPHY_IMPORT_CHARS = 5 * 1024 * 1024;

export const ImportBibliographyInputSchema = z.object({
  projectId: UuidSchema,
  format: BibliographyFormatSchema,
  content: z.string().min(1).max(MAX_BIBLIOGRAPHY_IMPORT_CHARS),
  onDuplicate: DuplicateReferenceResolutionSchema.default('prompt'),
});

export type ImportBibliographyInput = z.input<typeof ImportBibliographyInputSchema>;

export const ImportBibliographyEntryErrorSchema = z.object({
  entryIndex: z.number().int().min(0),
  rawCiteKey: z.string().max(128).nullable(),
  message: z.string().min(1).max(500),
});

export type ImportBibliographyEntryError = z.infer<typeof ImportBibliographyEntryErrorSchema>;

export const ImportBibliographyResponseSchema = z.object({
  format: BibliographyFormatSchema,
  imported: z.array(ReferenceSchema),
  merged: z.array(ReferenceSchema),
  conflicts: z.array(DuplicateReferenceConflictSchema),
  errors: z.array(ImportBibliographyEntryErrorSchema),
});

export type ImportBibliographyResponse = z.infer<typeof ImportBibliographyResponseSchema>;

export const ExportBibliographyInputSchema = z.object({
  projectId: UuidSchema,
  format: BibliographyFormatSchema,
  referenceIds: z.array(UuidSchema).min(1).max(2000).optional(),
});

export type ExportBibliographyInput = z.infer<typeof ExportBibliographyInputSchema>;

export const ExportBibliographyResponseSchema = z.object({
  format: BibliographyFormatSchema,
  content: z.string(),
  entryCount: z.number().int().min(0),
  suggestedFileName: SafeFileNameSchema,
});

export type ExportBibliographyResponse = z.infer<typeof ExportBibliographyResponseSchema>;

export const PdfMetadataDraftSchema = z.object({
  title: z.string().trim().min(1).max(1000).nullable(),
  authors: z.array(ReferenceAuthorSchema).max(200),
  year: z.number().int().min(1450).max(2100).nullable(),
  journal: z.string().trim().max(500).nullable(),
  doi: CanonicalDoiSchema.nullable(),
  abstract: z.string().max(20000).nullable(),
  detectedDois: z.array(CanonicalDoiSchema).max(20),
  method: PdfExtractionMethodSchema,
  needsLlmFallback: z.boolean(),
});

export type PdfMetadataDraft = z.infer<typeof PdfMetadataDraftSchema>;

export const IngestPdfInputSchema = z.object({
  projectId: UuidSchema,
  localPdfFileId: UuidSchema,
  fileName: SafeFileNameSchema,
  pdfBase64: z
    .string()
    .min(1)
    .max(70 * 1024 * 1024)
    .optional(),
  allowByokFallback: z.boolean().default(false),
  tags: z.array(ReferenceTagSchema).max(50).default([]),
  onDuplicate: DuplicateReferenceResolutionSchema.default('prompt'),
});

export type IngestPdfInput = z.input<typeof IngestPdfInputSchema>;

export const IngestPdfResponseSchema = z.object({
  status: z.enum(['created', 'merged', 'updated', 'skipped', 'conflict']),
  extractionMethod: PdfExtractionMethodSchema,
  detectedDoi: CanonicalDoiSchema.nullable(),
  hydratedFrom: z.enum(['crossref', 'openalex', 'none']),
  byokFallbackUsed: z.boolean(),
  needsLlmFallback: z.boolean(),
  reference: ReferenceSchema.nullable(),
  conflict: DuplicateReferenceConflictSchema.nullable(),
  unverifiedCandidateDois: z.array(CanonicalDoiSchema).max(20).optional(),
});

export type IngestPdfResponse = z.infer<typeof IngestPdfResponseSchema>;

const EMBEDDED_DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"'<>]+/gi;

export function extractDoisFromText(text: string): string[] {
  const matches = text.match(EMBEDDED_DOI_PATTERN);
  if (matches === null) {
    return [];
  }
  const unique = new Set<string>();
  const ordered: string[] = [];
  for (const rawMatch of matches) {
    const normalized = normalizeDoi(rawMatch);
    if (normalized !== null && !unique.has(normalized)) {
      unique.add(normalized);
      ordered.push(normalized);
    }
  }
  return ordered;
}
