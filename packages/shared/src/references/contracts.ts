import { z } from 'zod';
import { canRolePerform, type ProjectRole, UuidSchema } from '../auth/contracts.js';

export const REFERENCE_SOURCE_PROVIDERS = [
  'openalex',
  'crossref',
  'pubmed',
  'doi',
  'pdf',
  'bibtex',
  'ris',
  'manual',
] as const;

export const ReferenceSourceProviderSchema = z.enum(REFERENCE_SOURCE_PROVIDERS);

export type ReferenceSourceProvider = z.infer<typeof ReferenceSourceProviderSchema>;

export const DUPLICATE_REFERENCE_RESOLUTIONS = ['prompt', 'merge', 'update', 'skip'] as const;

export const DuplicateReferenceResolutionSchema = z.enum(DUPLICATE_REFERENCE_RESOLUTIONS);

export type DuplicateReferenceResolution = z.infer<typeof DuplicateReferenceResolutionSchema>;

export const REFERENCE_SORT_FIELDS = [
  'updatedAt',
  'createdAt',
  'year',
  'title',
  'citationCount',
] as const;

export const ReferenceSortFieldSchema = z.enum(REFERENCE_SORT_FIELDS);

export type ReferenceSortField = z.infer<typeof ReferenceSortFieldSchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']);

export type SortOrder = z.infer<typeof SortOrderSchema>;

export const CANONICAL_DOI_REGEX = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/;

export const CanonicalDoiSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(256)
  .regex(CANONICAL_DOI_REGEX);

export const CiteKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);

export const ReferenceTagSchema = z.string().trim().min(1).max(64);

export const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(
    (value) => value.startsWith('https://') || value.startsWith('http://'),
    'URL must use http or https protocol',
  );

export const OrcidSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/);

export const ReferenceAuthorSchema = z.object({
  family: z.string().trim().min(1).max(160),
  given: z.string().trim().max(160),
  displayName: z.string().trim().min(1).max(320),
  orcid: OrcidSchema.nullable(),
});

export type ReferenceAuthor = z.infer<typeof ReferenceAuthorSchema>;

export const ReferenceSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  citeKey: CiteKeySchema,
  title: z.string().trim().min(1).max(1000),
  authors: z.array(ReferenceAuthorSchema).max(200),
  year: z.number().int().min(1450).max(2100).nullable(),
  journal: z.string().trim().max(500).nullable(),
  published: z.string().trim().max(200).nullable(),
  doi: CanonicalDoiSchema.nullable(),
  url: HttpUrlSchema.nullable(),
  abstract: z.string().max(20000).nullable(),
  volume: z.string().trim().max(64).nullable(),
  issue: z.string().trim().max(64).nullable(),
  pages: z.string().trim().max(64).nullable(),
  citationCount: z.number().int().min(0).nullable(),
  pdfUrl: HttpUrlSchema.nullable(),
  localPdfFileId: UuidSchema.nullable(),
  tags: z.array(ReferenceTagSchema).max(50),
  notes: z.string().max(50000),
  sourceProvider: ReferenceSourceProviderSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Reference = z.infer<typeof ReferenceSchema>;

export const CreateReferenceInputSchema = z.object({
  projectId: UuidSchema,
  citeKey: CiteKeySchema.optional(),
  title: z.string().trim().min(1).max(1000),
  authors: z.array(ReferenceAuthorSchema).max(200).default([]),
  year: z.number().int().min(1450).max(2100).nullable().default(null),
  journal: z.string().trim().max(500).nullable().default(null),
  published: z.string().trim().max(200).nullable().default(null),
  doi: z.string().trim().max(256).nullable().default(null),
  url: HttpUrlSchema.nullable().default(null),
  abstract: z.string().max(20000).nullable().default(null),
  volume: z.string().trim().max(64).nullable().default(null),
  issue: z.string().trim().max(64).nullable().default(null),
  pages: z.string().trim().max(64).nullable().default(null),
  citationCount: z.number().int().min(0).nullable().default(null),
  pdfUrl: HttpUrlSchema.nullable().default(null),
  localPdfFileId: UuidSchema.nullable().default(null),
  tags: z.array(ReferenceTagSchema).max(50).default([]),
  notes: z.string().max(50000).default(''),
  sourceProvider: ReferenceSourceProviderSchema.default('manual'),
  onDuplicate: DuplicateReferenceResolutionSchema.default('prompt'),
});

export type CreateReferenceInput = z.input<typeof CreateReferenceInputSchema>;

export const UpdateReferenceInputSchema = z.object({
  citeKey: CiteKeySchema.optional(),
  title: z.string().trim().min(1).max(1000).optional(),
  authors: z.array(ReferenceAuthorSchema).max(200).optional(),
  year: z.number().int().min(1450).max(2100).nullable().optional(),
  journal: z.string().trim().max(500).nullable().optional(),
  published: z.string().trim().max(200).nullable().optional(),
  doi: z.string().trim().max(256).nullable().optional(),
  url: HttpUrlSchema.nullable().optional(),
  abstract: z.string().max(20000).nullable().optional(),
  volume: z.string().trim().max(64).nullable().optional(),
  issue: z.string().trim().max(64).nullable().optional(),
  pages: z.string().trim().max(64).nullable().optional(),
  citationCount: z.number().int().min(0).nullable().optional(),
  pdfUrl: HttpUrlSchema.nullable().optional(),
  localPdfFileId: UuidSchema.nullable().optional(),
  tags: z.array(ReferenceTagSchema).max(50).optional(),
  notes: z.string().max(50000).optional(),
});

export type UpdateReferenceInput = z.infer<typeof UpdateReferenceInputSchema>;

export const AttachReferencePdfInputSchema = z.object({
  projectId: UuidSchema,
  referenceId: UuidSchema,
  localPdfFileId: UuidSchema,
});

export type AttachReferencePdfInput = z.infer<typeof AttachReferencePdfInputSchema>;

export const DuplicateReferenceConflictSchema = z.object({
  code: z.literal('DUPLICATE_DOI_CONFLICT'),
  doi: CanonicalDoiSchema,
  existingReference: ReferenceSchema,
  incomingTitle: z.string().trim().min(1).max(1000),
  incomingSourceProvider: ReferenceSourceProviderSchema,
  conflictingFields: z.array(z.string().min(1).max(64)),
  suggestedAction: z.enum(['merge', 'update']),
});

export type DuplicateReferenceConflict = z.infer<typeof DuplicateReferenceConflictSchema>;

export const CreateReferenceOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('created'),
    reference: ReferenceSchema,
  }),
  z.object({
    status: z.literal('merged'),
    reference: ReferenceSchema,
  }),
  z.object({
    status: z.literal('updated'),
    reference: ReferenceSchema,
  }),
  z.object({
    status: z.literal('skipped'),
    reference: ReferenceSchema,
  }),
  z.object({
    status: z.literal('conflict'),
    conflict: DuplicateReferenceConflictSchema,
  }),
]);

export type CreateReferenceOutcome = z.infer<typeof CreateReferenceOutcomeSchema>;

export const ListReferencesQuerySchema = z
  .object({
    projectId: UuidSchema,
    tag: ReferenceTagSchema.optional(),
    search: z.string().trim().min(1).max(300).optional(),
    yearFrom: z.number().int().min(1450).max(2100).optional(),
    yearTo: z.number().int().min(1450).max(2100).optional(),
    hasPdf: z.boolean().optional(),
    sortBy: ReferenceSortFieldSchema.default('updatedAt'),
    sortOrder: SortOrderSchema.default('desc'),
  })
  .refine(
    (query) =>
      query.yearFrom === undefined || query.yearTo === undefined || query.yearFrom <= query.yearTo,
    'yearFrom must be less than or equal to yearTo',
  );

export type ListReferencesQuery = z.input<typeof ListReferencesQuerySchema>;

export const ReferenceManagerViewStateSchema = z.object({
  projectId: UuidSchema,
  selectedReferenceId: UuidSchema.nullable(),
  activeTag: ReferenceTagSchema.nullable(),
  searchQuery: z.string().max(300),
  sortBy: ReferenceSortFieldSchema,
  sortOrder: SortOrderSchema,
  isReadOnly: z.boolean(),
});

export type ReferenceManagerViewState = z.infer<typeof ReferenceManagerViewStateSchema>;

export function canRoleMutateReferences(role: ProjectRole): boolean {
  return canRolePerform(role, 'write_files');
}

const DOI_HTTP_PREFIX_PATTERN = new RegExp('^https?:\\/\\/(?:dx\\.)?doi\\.org\\/', 'i');
const DOI_SCHEME_PREFIX_PATTERN = /^doi:\s*/i;

function stripDoiPrefix(value: string): string {
  return value.replace(DOI_HTTP_PREFIX_PATTERN, '').replace(DOI_SCHEME_PREFIX_PATTERN, '').trim();
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ';']);
const MAX_CANONICAL_DOI_LENGTH = 256;

interface DelimiterBalances {
  paren: number;
  bracket: number;
  brace: number;
}

function updateDelimiterBalance(balances: DelimiterBalances, ch: string, delta: number): void {
  if (ch === '(') {
    balances.paren += delta;
  } else if (ch === ')') {
    balances.paren -= delta;
  } else if (ch === '[') {
    balances.bracket += delta;
  } else if (ch === ']') {
    balances.bracket -= delta;
  } else if (ch === '{') {
    balances.brace += delta;
  } else if (ch === '}') {
    balances.brace -= delta;
  }
}

function countDelimiterBalances(value: string): DelimiterBalances {
  const balances: DelimiterBalances = { paren: 0, bracket: 0, brace: 0 };
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch !== undefined) {
      updateDelimiterBalance(balances, ch, 1);
    }
  }
  return balances;
}

function hasExcessClosingDelimiter(balances: DelimiterBalances, ch: string): boolean {
  if (ch === ')') {
    return balances.paren < 0;
  }
  if (ch === ']') {
    return balances.bracket < 0;
  }
  if (ch === '}') {
    return balances.brace < 0;
  }
  return false;
}

function stripTrailingDoiPunctuation(value: string): string {
  const balances = countDelimiterBalances(value);
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (last === undefined) {
      break;
    }
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    if (hasExcessClosingDelimiter(balances, last)) {
      updateDelimiterBalance(balances, last, -1);
      end -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

export function normalizeDoi(raw: string): string | null {
  const cleaned = stripTrailingDoiPunctuation(stripDoiPrefix(raw.trim())).toLowerCase();
  if (cleaned.length > MAX_CANONICAL_DOI_LENGTH || !CANONICAL_DOI_REGEX.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function normalizeTitleForMatching(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAuthorFamily(author: ReferenceAuthor | undefined): string {
  if (!author) {
    return '';
  }
  return author.family
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeAuthorFamilyForMatching(author: ReferenceAuthor | undefined): string {
  if (!author) {
    return '';
  }
  return author.family
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function toAlphabeticSuffix(collisionIndex: number): string {
  let n = collisionIndex;
  let suffix = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    suffix = String.fromCharCode(97 + remainder) + suffix;
    n = Math.floor((n - 1) / 26);
  }
  return suffix;
}

export function generateDeterministicCiteKey(
  authors: readonly ReferenceAuthor[],
  year: number | null,
  existingKeys: ReadonlySet<string>,
): string {
  const rawFamilyToken = normalizeAuthorFamily(authors[0]) || 'untitled';
  const familyToken = /^[a-z]/.test(rawFamilyToken) ? rawFamilyToken : `ref${rawFamilyToken}`;
  const yearToken = year !== null ? String(year) : 'nd';
  const baseKey = `${familyToken}${yearToken}`.slice(0, 72);
  const normalizedExisting = new Set<string>();
  for (const key of existingKeys) {
    normalizedExisting.add(key.toLowerCase());
  }
  if (!normalizedExisting.has(baseKey)) {
    return baseKey;
  }
  let collisionIndex = 2;
  while (collisionIndex < 10000) {
    const candidate = `${baseKey}${toAlphabeticSuffix(collisionIndex)}`;
    if (!normalizedExisting.has(candidate)) {
      return candidate;
    }
    collisionIndex += 1;
  }
  return `${baseKey}z`;
}
