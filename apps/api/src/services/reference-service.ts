import { randomUUID } from 'node:crypto';
import {
  AttachReferencePdfInputSchema,
  canRoleMutateReferences,
  CreateReferenceInputSchema,
  CreateReferenceOutcomeSchema,
  DuplicateReferenceConflictSchema,
  err,
  generateDeterministicCiteKey,
  ListReferencesQuerySchema,
  normalizeDoi,
  ok,
  ReferenceSchema,
  UpdateReferenceInputSchema,
  UuidSchema,
  type AttachReferencePdfInput,
  type CreateReferenceInput,
  type CreateReferenceOutcome,
  type DuplicateReferenceConflict,
  type ListReferencesQuery,
  type ProjectRole,
  type Reference,
  type ReferenceAuthor,
  type ReferenceSortField,
  type Result,
  type SortOrder,
  type UpdateReferenceInput,
} from '@sunrise/shared';

export interface ReferenceActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

export interface ReferenceRepository {
  readonly findById: (referenceId: string) => Promise<Reference | null>;
  readonly findByProjectAndDoi: (projectId: string, doi: string) => Promise<Reference | null>;
  readonly listByProject: (projectId: string) => Promise<Reference[]>;
  readonly save: (reference: Reference) => Promise<Reference>;
  readonly deleteById: (projectId: string, referenceId: string) => Promise<boolean>;
  readonly runInTransaction?: <T>(fn: (txRepo: ReferenceRepository) => Promise<T>) => Promise<T>;
}

export interface ReferenceService {
  readonly createReference: (
    actor: ReferenceActor,
    input: CreateReferenceInput,
  ) => Promise<Result<CreateReferenceOutcome>>;
  readonly getReference: (
    actor: ReferenceActor,
    projectId: string,
    referenceId: string,
  ) => Promise<Result<Reference>>;
  readonly listReferences: (
    actor: ReferenceActor,
    query: ListReferencesQuery,
  ) => Promise<Result<Reference[]>>;
  readonly updateReference: (
    actor: ReferenceActor,
    projectId: string,
    referenceId: string,
    input: UpdateReferenceInput,
  ) => Promise<Result<Reference>>;
  readonly attachPdf: (
    actor: ReferenceActor,
    input: AttachReferencePdfInput,
  ) => Promise<Result<Reference>>;
  readonly deleteReference: (
    actor: ReferenceActor,
    projectId: string,
    referenceId: string,
  ) => Promise<Result<{ readonly deleted: true }>>;
}

type ParsedCreateInput = ReturnType<typeof CreateReferenceInputSchema.parse>;

function executeInReferenceTransaction<T>(
  repo: ReferenceRepository,
  fn: (txRepo: ReferenceRepository) => Promise<T>,
): Promise<T> {
  if (repo.runInTransaction) {
    return repo.runInTransaction(fn);
  }
  return fn(repo);
}

function mergeTags(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const tag of [...existing, ...incoming]) {
    const trimmed = tag.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length > 0 && !seen.has(key)) {
      seen.add(key);
      merged.push(trimmed);
    }
  }
  return merged.slice(0, 50);
}

function pickRicherText(current: string | null, incoming: string | null): string | null {
  if (!incoming || incoming.trim().length === 0) {
    return current;
  }
  if (!current || current.trim().length === 0) {
    return incoming;
  }
  return incoming.trim().length > current.trim().length ? incoming : current;
}

function pickHigherCitationCount(current: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return current;
  }
  if (current === null) {
    return incoming;
  }
  return incoming > current ? incoming : current;
}

function pickRicherAuthorList(
  current: readonly ReferenceAuthor[],
  incoming: readonly ReferenceAuthor[],
): ReferenceAuthor[] {
  return incoming.length > current.length ? [...incoming] : [...current];
}

function mergeNotes(current: string, incoming: string): string {
  const trimmedCurrent = current.trim();
  const trimmedIncoming = incoming.trim();
  if (trimmedIncoming.length === 0) {
    return current;
  }
  if (trimmedCurrent.length === 0) {
    return incoming;
  }
  if (trimmedCurrent.includes(trimmedIncoming)) {
    return current;
  }
  return `${current}\n\n${incoming}`.slice(0, 50000);
}

function detectConflictingFields(existing: Reference, incoming: ParsedCreateInput): string[] {
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    ['title', incoming.title !== existing.title],
    ['year', incoming.year !== null && incoming.year !== existing.year],
    ['journal', incoming.journal !== null && incoming.journal !== existing.journal],
    ['abstract', incoming.abstract !== null && incoming.abstract !== existing.abstract],
    [
      'citationCount',
      incoming.citationCount !== null && incoming.citationCount !== existing.citationCount,
    ],
    ['pdfUrl', incoming.pdfUrl !== null && incoming.pdfUrl !== existing.pdfUrl],
    ['notes', incoming.notes.trim().length > 0 && incoming.notes !== existing.notes],
  ];
  return checks.filter(([, isDiff]) => isDiff).map(([field]) => field);
}

function buildDuplicateConflict(
  existing: Reference,
  normalizedDoi: string,
  incoming: ParsedCreateInput,
): DuplicateReferenceConflict {
  return DuplicateReferenceConflictSchema.parse({
    code: 'DUPLICATE_DOI_CONFLICT',
    doi: normalizedDoi,
    existingReference: existing,
    incomingTitle: incoming.title,
    incomingSourceProvider: incoming.sourceProvider,
    conflictingFields: detectConflictingFields(existing, incoming),
    suggestedAction: 'merge',
  });
}

function buildMergedReference(
  existing: Reference,
  incoming: ParsedCreateInput,
  nowIso: string,
): Reference {
  return ReferenceSchema.parse({
    ...existing,
    title: pickRicherText(existing.title, incoming.title) ?? existing.title,
    authors: pickRicherAuthorList(existing.authors, incoming.authors),
    year: existing.year ?? incoming.year,
    journal: pickRicherText(existing.journal, incoming.journal),
    published: pickRicherText(existing.published, incoming.published),
    url: existing.url ?? incoming.url,
    abstract: pickRicherText(existing.abstract, incoming.abstract),
    volume: existing.volume ?? incoming.volume,
    issue: existing.issue ?? incoming.issue,
    pages: existing.pages ?? incoming.pages,
    citationCount: pickHigherCitationCount(existing.citationCount, incoming.citationCount),
    pdfUrl: existing.pdfUrl ?? incoming.pdfUrl,
    localPdfFileId: existing.localPdfFileId ?? incoming.localPdfFileId,
    tags: mergeTags(existing.tags, incoming.tags),
    notes: mergeNotes(existing.notes, incoming.notes),
    updatedAt: nowIso,
  });
}

function buildUpdatedDuplicateReference(
  existing: Reference,
  incoming: ParsedCreateInput,
  normalizedDoi: string,
  nowIso: string,
): Reference {
  return ReferenceSchema.parse({
    ...existing,
    title: incoming.title,
    authors: incoming.authors,
    year: incoming.year,
    journal: incoming.journal,
    published: incoming.published,
    doi: normalizedDoi,
    url: incoming.url,
    abstract: incoming.abstract,
    volume: incoming.volume,
    issue: incoming.issue,
    pages: incoming.pages,
    citationCount: incoming.citationCount,
    pdfUrl: incoming.pdfUrl,
    localPdfFileId: incoming.localPdfFileId ?? existing.localPdfFileId,
    tags: mergeTags(existing.tags, incoming.tags),
    notes: incoming.notes.length > 0 ? incoming.notes : existing.notes,
    sourceProvider: incoming.sourceProvider,
    updatedAt: nowIso,
  });
}

function disambiguateExplicitCiteKey(requested: string, existingKeys: ReadonlySet<string>): string {
  const lowered = new Set<string>();
  for (const key of existingKeys) {
    lowered.add(key.toLowerCase());
  }
  if (!lowered.has(requested.toLowerCase())) {
    return requested;
  }
  const base = requested.slice(0, 72);
  for (let index = 2; index < 10000; index += 1) {
    const suffix = String.fromCharCode(96 + ((index - 1) % 26) + 1);
    const candidate = index <= 26 ? `${base}${suffix}` : `${base}_${index}`;
    if (!lowered.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base}z`;
}

function resolveCiteKey(
  requested: string | undefined,
  authors: readonly ReferenceAuthor[],
  year: number | null,
  existingKeys: ReadonlySet<string>,
): string {
  if (requested !== undefined) {
    return disambiguateExplicitCiteKey(requested, existingKeys);
  }
  return generateDeterministicCiteKey(authors, year, existingKeys);
}

async function resolveDuplicateDoiOutcome(
  txRepo: ReferenceRepository,
  existing: Reference,
  normalizedDoi: string,
  incoming: ParsedCreateInput,
  nowIso: string,
): Promise<CreateReferenceOutcome> {
  if (incoming.onDuplicate === 'skip') {
    return CreateReferenceOutcomeSchema.parse({ status: 'skipped', reference: existing });
  }
  if (incoming.onDuplicate === 'prompt') {
    const conflict = buildDuplicateConflict(existing, normalizedDoi, incoming);
    return CreateReferenceOutcomeSchema.parse({ status: 'conflict', conflict });
  }
  if (incoming.onDuplicate === 'merge') {
    const merged = await txRepo.save(buildMergedReference(existing, incoming, nowIso));
    return CreateReferenceOutcomeSchema.parse({ status: 'merged', reference: merged });
  }
  const updated = await txRepo.save(
    buildUpdatedDuplicateReference(existing, incoming, normalizedDoi, nowIso),
  );
  return CreateReferenceOutcomeSchema.parse({ status: 'updated', reference: updated });
}

function matchesSearchNeedle(ref: Reference, needle: string): boolean {
  const lowered = needle.toLowerCase();
  const haystacks = [
    ref.title,
    ref.citeKey,
    ref.journal ?? '',
    ref.doi ?? '',
    ref.notes,
    ...ref.tags,
    ...ref.authors.map((author) => `${author.displayName} ${author.family}`),
  ];
  return haystacks.some((value) => value.toLowerCase().includes(lowered));
}

function matchesYearRange(
  year: number | null,
  yearFrom: number | undefined,
  yearTo: number | undefined,
): boolean {
  if (yearFrom !== undefined && (year === null || year < yearFrom)) {
    return false;
  }
  if (yearTo !== undefined && (year === null || year > yearTo)) {
    return false;
  }
  return true;
}

function matchesTagFilter(tags: readonly string[], targetTag: string | undefined): boolean {
  if (targetTag === undefined) {
    return true;
  }
  const lowered = targetTag.toLowerCase();
  return tags.some((tag) => tag.toLowerCase() === lowered);
}

function matchesReferenceFilters(
  ref: Reference,
  query: ReturnType<typeof ListReferencesQuerySchema.parse>,
): boolean {
  if (!matchesTagFilter(ref.tags, query.tag)) {
    return false;
  }
  if (!matchesYearRange(ref.year, query.yearFrom, query.yearTo)) {
    return false;
  }
  if (query.hasPdf !== undefined) {
    const hasPdf = ref.localPdfFileId !== null || ref.pdfUrl !== null;
    if (hasPdf !== query.hasPdf) {
      return false;
    }
  }
  return query.search === undefined || matchesSearchNeedle(ref, query.search);
}

function compareReferenceValues(a: Reference, b: Reference, sortBy: ReferenceSortField): number {
  switch (sortBy) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'year':
      return (a.year ?? -1) - (b.year ?? -1);
    case 'citationCount':
      return (a.citationCount ?? -1) - (b.citationCount ?? -1);
    case 'createdAt':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updatedAt':
      return a.updatedAt.localeCompare(b.updatedAt);
  }
}

function sortReferences(
  items: Reference[],
  sortBy: ReferenceSortField,
  sortOrder: SortOrder,
): Reference[] {
  const factor = sortOrder === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => compareReferenceValues(a, b, sortBy) * factor);
}

function normalizeOptionalDoiInput(rawDoi: string | null | undefined): Result<string | null> {
  if (rawDoi === undefined || rawDoi === null || rawDoi.trim().length === 0) {
    return ok(null);
  }
  const normalized = normalizeDoi(rawDoi);
  if (normalized === null) {
    return err({ code: 'VALIDATION_ERROR', message: 'Invalid DOI format' });
  }
  return ok(normalized);
}

function pickDefined<T>(incoming: T | undefined, current: T): T {
  return incoming !== undefined ? incoming : current;
}

function applyReferencePatch(
  existing: Reference,
  patch: UpdateReferenceInput,
  normalizedDoi: string | null | undefined,
  nowIso: string,
): Reference {
  return ReferenceSchema.parse({
    ...existing,
    citeKey: pickDefined(patch.citeKey, existing.citeKey),
    title: pickDefined(patch.title, existing.title),
    authors: pickDefined(patch.authors, existing.authors),
    year: pickDefined(patch.year, existing.year),
    journal: pickDefined(patch.journal, existing.journal),
    published: pickDefined(patch.published, existing.published),
    doi: pickDefined(normalizedDoi, existing.doi),
    url: pickDefined(patch.url, existing.url),
    abstract: pickDefined(patch.abstract, existing.abstract),
    volume: pickDefined(patch.volume, existing.volume),
    issue: pickDefined(patch.issue, existing.issue),
    pages: pickDefined(patch.pages, existing.pages),
    citationCount: pickDefined(patch.citationCount, existing.citationCount),
    pdfUrl: pickDefined(patch.pdfUrl, existing.pdfUrl),
    localPdfFileId: pickDefined(patch.localPdfFileId, existing.localPdfFileId),
    tags: pickDefined(patch.tags, existing.tags),
    notes: pickDefined(patch.notes, existing.notes),
    updatedAt: nowIso,
  });
}

export function createInMemoryReferenceRepository(): ReferenceRepository {
  const store = new Map<string, Reference>();
  let txQueue: Promise<void> = Promise.resolve();

  const repo: ReferenceRepository = {
    findById: async (referenceId) => store.get(referenceId) ?? null,
    findByProjectAndDoi: async (projectId, doi) => {
      for (const ref of store.values()) {
        if (ref.projectId === projectId && ref.doi === doi) {
          return ref;
        }
      }
      return null;
    },
    listByProject: async (projectId) => {
      const result: Reference[] = [];
      for (const ref of store.values()) {
        if (ref.projectId === projectId) {
          result.push(ref);
        }
      }
      return result;
    },
    save: async (reference) => {
      store.set(reference.id, reference);
      return reference;
    },
    deleteById: async (projectId, referenceId) => {
      const existing = store.get(referenceId);
      if (!existing || existing.projectId !== projectId) {
        return false;
      }
      return store.delete(referenceId);
    },
    runInTransaction: async <T>(fn: (txRepo: ReferenceRepository) => Promise<T>): Promise<T> => {
      const previous = txQueue;
      let release: () => void = () => undefined;
      txQueue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await fn(repo);
      } finally {
        release();
      }
    },
  };

  return repo;
}

async function checkUpdateConflicts(
  txRepo: ReferenceRepository,
  projectId: string,
  referenceId: string,
  patch: UpdateReferenceInput,
  nextDoi: string | null | undefined,
): Promise<Result<true>> {
  const siblings = await txRepo.listByProject(projectId);
  if (patch.citeKey !== undefined) {
    const targetKey = patch.citeKey.toLowerCase();
    const citeKeyClash = siblings.some(
      (item) => item.id !== referenceId && item.citeKey.toLowerCase() === targetKey,
    );
    if (citeKeyClash) {
      return err({ code: 'CONFLICT', message: 'Cite key already exists in this project' });
    }
  }
  if (nextDoi !== undefined && nextDoi !== null) {
    const doiClash = siblings.some((item) => item.id !== referenceId && item.doi === nextDoi);
    if (doiClash) {
      return err({ code: 'CONFLICT', message: 'DOI already exists in this project' });
    }
  }
  return ok(true);
}

export function createReferenceService(
  repo: ReferenceRepository,
  now: () => Date = () => new Date(),
): ReferenceService {
  return {
    createReference: async (actor, input): Promise<Result<CreateReferenceOutcome>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to create references' });
      }
      const parsed = CreateReferenceInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid reference payload',
        });
      }
      const doiResult = normalizeOptionalDoiInput(parsed.data.doi);
      if (!doiResult.ok) {
        return doiResult;
      }
      const normalizedDoi = doiResult.value;
      const nowIso = now().toISOString();

      return executeInReferenceTransaction(repo, async (txRepo) => {
        if (normalizedDoi !== null) {
          const duplicate = await txRepo.findByProjectAndDoi(parsed.data.projectId, normalizedDoi);
          if (duplicate !== null) {
            return ok(
              await resolveDuplicateDoiOutcome(
                txRepo,
                duplicate,
                normalizedDoi,
                parsed.data,
                nowIso,
              ),
            );
          }
        }

        const existingRefs = await txRepo.listByProject(parsed.data.projectId);
        const existingKeys = new Set(existingRefs.map((ref) => ref.citeKey));
        const citeKey = resolveCiteKey(
          parsed.data.citeKey,
          parsed.data.authors,
          parsed.data.year,
          existingKeys,
        );

        const created = ReferenceSchema.parse({
          id: randomUUID(),
          projectId: parsed.data.projectId,
          citeKey,
          title: parsed.data.title,
          authors: parsed.data.authors,
          year: parsed.data.year,
          journal: parsed.data.journal,
          published: parsed.data.published,
          doi: normalizedDoi,
          url: parsed.data.url,
          abstract: parsed.data.abstract,
          volume: parsed.data.volume,
          issue: parsed.data.issue,
          pages: parsed.data.pages,
          citationCount: parsed.data.citationCount,
          pdfUrl: parsed.data.pdfUrl,
          localPdfFileId: parsed.data.localPdfFileId,
          tags: mergeTags([], parsed.data.tags),
          notes: parsed.data.notes,
          sourceProvider: parsed.data.sourceProvider,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        await txRepo.save(created);
        return ok(CreateReferenceOutcomeSchema.parse({ status: 'created', reference: created }));
      });
    },

    getReference: async (_actor, projectId, referenceId): Promise<Result<Reference>> => {
      if (!UuidSchema.safeParse(projectId).success || !UuidSchema.safeParse(referenceId).success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId or referenceId' });
      }
      const found = await repo.findById(referenceId);
      if (!found || found.projectId !== projectId) {
        return err({ code: 'NOT_FOUND', message: 'Reference not found' });
      }
      return ok(found);
    },

    listReferences: async (_actor, query): Promise<Result<Reference[]>> => {
      const parsed = ListReferencesQuerySchema.safeParse(query);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid reference list query',
        });
      }
      const all = await repo.listByProject(parsed.data.projectId);
      const filtered = all.filter((ref) => matchesReferenceFilters(ref, parsed.data));
      return ok(sortReferences(filtered, parsed.data.sortBy, parsed.data.sortOrder));
    },

    updateReference: async (actor, projectId, referenceId, input): Promise<Result<Reference>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to update references' });
      }
      if (!UuidSchema.safeParse(projectId).success || !UuidSchema.safeParse(referenceId).success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId or referenceId' });
      }
      const parsed = UpdateReferenceInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid reference update payload',
        });
      }
      const nextDoiResult =
        parsed.data.doi !== undefined ? normalizeOptionalDoiInput(parsed.data.doi) : ok(undefined);
      if (!nextDoiResult.ok) {
        return nextDoiResult;
      }

      return executeInReferenceTransaction(repo, async (txRepo) => {
        const existing = await txRepo.findById(referenceId);
        if (!existing || existing.projectId !== projectId) {
          return err({ code: 'NOT_FOUND', message: 'Reference not found' });
        }
        const conflicts = await checkUpdateConflicts(
          txRepo,
          projectId,
          referenceId,
          parsed.data,
          nextDoiResult.value,
        );
        if (!conflicts.ok) {
          return conflicts;
        }
        const updated = applyReferencePatch(
          existing,
          parsed.data,
          nextDoiResult.value,
          now().toISOString(),
        );
        await txRepo.save(updated);
        return ok(updated);
      });
    },

    attachPdf: async (actor, input): Promise<Result<Reference>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to attach reference PDF' });
      }
      const parsed = AttachReferencePdfInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF attachment payload',
        });
      }
      return executeInReferenceTransaction(repo, async (txRepo) => {
        const existing = await txRepo.findById(parsed.data.referenceId);
        if (!existing || existing.projectId !== parsed.data.projectId) {
          return err({ code: 'NOT_FOUND', message: 'Reference not found' });
        }
        const updated = ReferenceSchema.parse({
          ...existing,
          localPdfFileId: parsed.data.localPdfFileId,
          updatedAt: now().toISOString(),
        });
        await txRepo.save(updated);
        return ok(updated);
      });
    },

    deleteReference: async (
      actor,
      projectId,
      referenceId,
    ): Promise<Result<{ readonly deleted: true }>> => {
      if (!canRoleMutateReferences(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to delete references' });
      }
      if (!UuidSchema.safeParse(projectId).success || !UuidSchema.safeParse(referenceId).success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId or referenceId' });
      }
      const deleted = await repo.deleteById(projectId, referenceId);
      if (!deleted) {
        return err({ code: 'NOT_FOUND', message: 'Reference not found' });
      }
      return ok({ deleted: true });
    },
  };
}

export function createInMemoryReferenceService(now?: () => Date): ReferenceService {
  return createReferenceService(createInMemoryReferenceRepository(), now);
}
