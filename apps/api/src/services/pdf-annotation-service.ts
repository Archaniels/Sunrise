import { randomUUID } from 'node:crypto';
import {
  canRoleMutatePdfAnnotations,
  CreatePdfAnnotationInputSchema,
  err,
  ListPdfAnnotationsQuerySchema,
  ok,
  PdfAnnotationSchema,
  UpdatePdfAnnotationInputSchema,
  UuidSchema,
  type CreatePdfAnnotationInput,
  type ListPdfAnnotationsQuery,
  type PdfAnnotation,
  type ProjectRole,
  type Result,
  type UpdatePdfAnnotationInput,
} from '@sunrise/shared';

export interface PdfActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

export interface PdfAnnotationUpdatePatch {
  readonly note?: string;
  readonly color?: PdfAnnotation['color'];
  readonly updatedAt: string;
}

export interface PdfAnnotationRepository {
  readonly findById: (annotationId: string) => Promise<PdfAnnotation | null>;
  readonly listByFile: (projectId: string, fileId: string) => Promise<PdfAnnotation[]>;
  readonly insert: (annotation: PdfAnnotation) => Promise<PdfAnnotation>;
  readonly update: (
    projectId: string,
    annotationId: string,
    patch: PdfAnnotationUpdatePatch,
  ) => Promise<PdfAnnotation | null>;
  readonly deleteById: (projectId: string, annotationId: string) => Promise<boolean>;
}

export interface PdfAnnotationServiceOptions {
  readonly now?: () => Date;
  readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
  readonly assertReferenceInProject?: (projectId: string, referenceId: string) => Promise<boolean>;
}

export interface PdfAnnotationService {
  readonly createAnnotation: (
    actor: PdfActor,
    input: CreatePdfAnnotationInput,
  ) => Promise<Result<PdfAnnotation>>;
  readonly listAnnotations: (
    actor: PdfActor,
    query: ListPdfAnnotationsQuery,
  ) => Promise<Result<PdfAnnotation[]>>;
  readonly updateAnnotation: (
    actor: PdfActor,
    projectId: string,
    annotationId: string,
    input: UpdatePdfAnnotationInput,
  ) => Promise<Result<PdfAnnotation>>;
  readonly deleteAnnotation: (
    actor: PdfActor,
    projectId: string,
    annotationId: string,
  ) => Promise<Result<{ readonly deleted: true }>>;
}

export function createInMemoryPdfAnnotationRepository(): PdfAnnotationRepository {
  const store = new Map<string, PdfAnnotation>();

  return {
    findById: async (annotationId) => store.get(annotationId) ?? null,
    listByFile: async (projectId, fileId) => {
      const results: PdfAnnotation[] = [];
      for (const annotation of store.values()) {
        if (annotation.projectId === projectId && annotation.fileId === fileId) {
          results.push(annotation);
        }
      }
      return results;
    },
    insert: async (annotation) => {
      store.set(annotation.id, annotation);
      return annotation;
    },
    update: async (projectId, annotationId, patch) => {
      const existing = store.get(annotationId);
      if (!existing || existing.projectId !== projectId) {
        return null;
      }
      const updated = PdfAnnotationSchema.parse({
        ...existing,
        note: patch.note ?? existing.note,
        color: patch.color ?? existing.color,
        updatedAt: patch.updatedAt,
      });
      store.set(annotationId, updated);
      return updated;
    },
    deleteById: async (projectId, annotationId) => {
      const existing = store.get(annotationId);
      if (!existing || existing.projectId !== projectId) {
        return false;
      }
      return store.delete(annotationId);
    },
  };
}

function areValidIds(projectId: string, annotationId: string): boolean {
  return UuidSchema.safeParse(projectId).success && UuidSchema.safeParse(annotationId).success;
}

function resolveAnnotationServiceOptions(
  nowOrOptions?: (() => Date) | PdfAnnotationServiceOptions,
): PdfAnnotationServiceOptions {
  if (typeof nowOrOptions === 'function') {
    return { now: nowOrOptions };
  }
  return nowOrOptions ?? {};
}

async function verifyAnnotationOwnership(
  options: PdfAnnotationServiceOptions,
  projectId: string,
  fileId: string,
  referenceId: string | null | undefined,
): Promise<Result<true>> {
  if (!options.assertFileInProject) {
    return err({ code: 'NOT_FOUND', message: 'PDF file not found in this project' });
  }
  const fileAllowed = await options.assertFileInProject(projectId, fileId);
  if (!fileAllowed) {
    return err({ code: 'NOT_FOUND', message: 'PDF file not found in this project' });
  }
  if (referenceId) {
    if (!options.assertReferenceInProject) {
      return err({ code: 'NOT_FOUND', message: 'Reference not found in this project' });
    }
    const refAllowed = await options.assertReferenceInProject(projectId, referenceId);
    if (!refAllowed) {
      return err({ code: 'NOT_FOUND', message: 'Reference not found in this project' });
    }
  }
  return ok(true);
}

function createInMemoryOwnershipBinder(): (projectId: string, id: string) => Promise<boolean> {
  const owners = new Map<string, string>();
  return async (projectId: string, id: string): Promise<boolean> => {
    const existingOwner = owners.get(id);
    if (existingOwner === undefined) {
      owners.set(id, projectId);
      return true;
    }
    return existingOwner === projectId;
  };
}

export function createPdfAnnotationService(
  repo: PdfAnnotationRepository,
  nowOrOptions?: (() => Date) | PdfAnnotationServiceOptions,
): PdfAnnotationService {
  const options = resolveAnnotationServiceOptions(nowOrOptions);
  const now = options.now ?? (() => new Date());

  return {
    createAnnotation: async (actor, input): Promise<Result<PdfAnnotation>> => {
      if (!canRoleMutatePdfAnnotations(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to create PDF annotations' });
      }
      if (!UuidSchema.safeParse(actor.userId).success) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid actor userId' });
      }
      const parsed = CreatePdfAnnotationInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF annotation payload',
        });
      }
      const ownership = await verifyAnnotationOwnership(
        options,
        parsed.data.projectId,
        parsed.data.fileId,
        parsed.data.referenceId,
      );
      if (!ownership.ok) {
        return ownership;
      }
      const nowIso = now().toISOString();
      const created = PdfAnnotationSchema.parse({
        id: randomUUID(),
        projectId: parsed.data.projectId,
        fileId: parsed.data.fileId,
        referenceId: parsed.data.referenceId,
        pageNumber: parsed.data.pageNumber,
        selectedText: parsed.data.selectedText,
        note: parsed.data.note,
        color: parsed.data.color,
        rects: parsed.data.rects,
        createdBy: actor.userId,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await repo.insert(created);
      return ok(created);
    },

    listAnnotations: async (_actor, query): Promise<Result<PdfAnnotation[]>> => {
      const parsed = ListPdfAnnotationsQuerySchema.safeParse(query);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF annotation query',
        });
      }
      const ownership = await verifyAnnotationOwnership(
        options,
        parsed.data.projectId,
        parsed.data.fileId,
        parsed.data.referenceId,
      );
      if (!ownership.ok) {
        return ownership;
      }
      const items = await repo.listByFile(parsed.data.projectId, parsed.data.fileId);
      const filtered = items.filter((item) => {
        if (parsed.data.referenceId !== undefined && item.referenceId !== parsed.data.referenceId) {
          return false;
        }
        if (parsed.data.pageNumber !== undefined && item.pageNumber !== parsed.data.pageNumber) {
          return false;
        }
        return true;
      });
      filtered.sort((a, b) =>
        a.pageNumber !== b.pageNumber
          ? a.pageNumber - b.pageNumber
          : a.createdAt.localeCompare(b.createdAt),
      );
      return ok(filtered);
    },

    updateAnnotation: async (
      actor,
      projectId,
      annotationId,
      input,
    ): Promise<Result<PdfAnnotation>> => {
      if (!canRoleMutatePdfAnnotations(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to update PDF annotations' });
      }
      if (!areValidIds(projectId, annotationId)) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId or annotationId' });
      }
      const parsed = UpdatePdfAnnotationInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF annotation update payload',
        });
      }
      const updated = await repo.update(projectId, annotationId, {
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        updatedAt: now().toISOString(),
      });
      if (!updated) {
        return err({ code: 'NOT_FOUND', message: 'PDF annotation not found' });
      }
      return ok(updated);
    },

    deleteAnnotation: async (
      actor,
      projectId,
      annotationId,
    ): Promise<Result<{ readonly deleted: true }>> => {
      if (!canRoleMutatePdfAnnotations(actor.role)) {
        return err({ code: 'FORBIDDEN', message: 'Insufficient role to delete PDF annotations' });
      }
      if (!areValidIds(projectId, annotationId)) {
        return err({ code: 'VALIDATION_ERROR', message: 'Invalid projectId or annotationId' });
      }
      const deleted = await repo.deleteById(projectId, annotationId);
      if (!deleted) {
        return err({ code: 'NOT_FOUND', message: 'PDF annotation not found' });
      }
      return ok({ deleted: true });
    },
  };
}

export function createInMemoryPdfAnnotationService(
  nowOrOptions?: (() => Date) | PdfAnnotationServiceOptions,
): PdfAnnotationService {
  const baseOptions = resolveAnnotationServiceOptions(nowOrOptions);
  const resolvedOptions: PdfAnnotationServiceOptions = {
    ...baseOptions,
    assertFileInProject: baseOptions.assertFileInProject ?? createInMemoryOwnershipBinder(),
    assertReferenceInProject:
      baseOptions.assertReferenceInProject ?? createInMemoryOwnershipBinder(),
  };
  return createPdfAnnotationService(createInMemoryPdfAnnotationRepository(), resolvedOptions);
}
