import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CreateReferenceOutcomeSchema,
  ReferenceManagerViewStateSchema,
  ReferenceSchema,
  type CreateReferenceInput,
  type CreateReferenceOutcome,
  type ListReferencesQuery,
  type ProjectRole,
  type Reference,
  type ReferenceManagerViewState,
  type Result,
  type UpdateReferenceInput,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface ReferenceActor {
  readonly userId: string;
  readonly role: ProjectRole;
}

interface ReferenceServiceOptionsLike {
  readonly now?: () => Date;
  readonly assertFileInProject?: (projectId: string, fileId: string) => Promise<boolean>;
}

interface ReferenceRepositoryLike {
  readonly findById: (referenceId: string) => Promise<Reference | null>;
  readonly findByProjectAndDoi: (projectId: string, doi: string) => Promise<Reference | null>;
  readonly listByProject: (projectId: string) => Promise<Reference[]>;
  readonly save: (reference: Reference) => Promise<Reference>;
  readonly deleteById: (projectId: string, referenceId: string) => Promise<boolean>;
  readonly runInTransaction?: <T>(
    fn: (txRepo: ReferenceRepositoryLike) => Promise<T>,
  ) => Promise<T>;
}

interface ReferenceServiceLike {
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
    input: {
      readonly projectId: string;
      readonly referenceId: string;
      readonly localPdfFileId: string;
    },
  ) => Promise<Result<Reference>>;
  readonly deleteReference: (
    actor: ReferenceActor,
    projectId: string,
    referenceId: string,
  ) => Promise<Result<{ readonly deleted: true }>>;
  readonly runBatch?: <T>(fn: (txService: ReferenceServiceLike) => Promise<T>) => Promise<T>;
}

interface ReferenceServiceModuleLike {
  readonly createInMemoryReferenceRepository: () => ReferenceRepositoryLike;
  readonly createReferenceService: (
    repo: ReferenceRepositoryLike,
    options?: ReferenceServiceOptionsLike,
  ) => ReferenceServiceLike;
  readonly createInMemoryReferenceService: (
    options?: ReferenceServiceOptionsLike,
  ) => ReferenceServiceLike;
}

function createNonTransactionalReferenceRepository(): ReferenceRepositoryLike {
  const store = new Map<string, Reference>();
  return {
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
  };
}

interface ReferenceManagerControllerLike {
  readonly getState: () => ReferenceManagerViewState;
  readonly selectReference: (referenceId: string | null) => ReferenceManagerViewState;
  readonly setActiveTag: (tag: string | null) => ReferenceManagerViewState;
  readonly setSearchQuery: (query: string) => ReferenceManagerViewState;
  readonly filterReferences: (references: readonly Reference[]) => Reference[];
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

async function assertCiteKeyDisambiguation(
  service: ReferenceServiceLike,
  projectId: string,
  editor: ReferenceActor,
): Promise<string> {
  const firstCreate = await service.createReference(editor, {
    projectId,
    title: 'Structured Academic Workspaces',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    journal: 'Nature Digital Research',
    doi: 'https://doi.org/10.1038/S41586-024-00010-1',
    tags: ['workspace'],
    notes: 'Initial note',
    sourceProvider: 'openalex',
  });
  expect(firstCreate.ok).toBe(true);
  if (!firstCreate.ok || firstCreate.value.status !== 'created') {
    return '';
  }
  expect(CreateReferenceOutcomeSchema.safeParse(firstCreate.value).success).toBe(true);
  expect(firstCreate.value.reference.citeKey).toBe('smith2024');
  expect(firstCreate.value.reference.doi).toBe('10.1038/s41586-024-00010-1');

  const secondSameAuthorYear = await service.createReference(editor, {
    projectId,
    title: 'Second Paper by Smith in 2024',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-00020-2',
    tags: ['followup'],
    sourceProvider: 'crossref',
  });
  expect(secondSameAuthorYear.ok).toBe(true);
  if (!secondSameAuthorYear.ok) {
    return '';
  }
  expect(secondSameAuthorYear.value.status).toBe('created');
  if (secondSameAuthorYear.value.status === 'created') {
    expect(secondSameAuthorYear.value.reference.citeKey).toBe('smith2024b');
  }
  return firstCreate.value.reference.id;
}

async function assertDuplicateDoiConflictAndMerge(
  service: ReferenceServiceLike,
  projectId: string,
  editor: ReferenceActor,
): Promise<void> {
  const duplicatePrompt = await service.createReference(editor, {
    projectId,
    title: 'Structured Academic Workspaces',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-00010-1',
    abstract: 'Richer abstract from Crossref.',
    citationCount: 112,
    sourceProvider: 'crossref',
  });
  expect(duplicatePrompt.ok && duplicatePrompt.value.status === 'conflict').toBe(true);
  if (duplicatePrompt.ok && duplicatePrompt.value.status === 'conflict') {
    expect(duplicatePrompt.value.conflict.code).toBe('DUPLICATE_DOI_CONFLICT');
  }

  const duplicateMerge = await service.createReference(editor, {
    projectId,
    title: 'Structured Academic Workspaces',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-00010-1',
    abstract: 'Richer abstract from Crossref.',
    citationCount: 112,
    tags: ['verified'],
    sourceProvider: 'crossref',
    onDuplicate: 'merge',
  });
  expect(duplicateMerge.ok && duplicateMerge.value.status === 'merged').toBe(true);
  if (duplicateMerge.ok && duplicateMerge.value.status === 'merged') {
    expect(duplicateMerge.value.reference.abstract).toBe('Richer abstract from Crossref.');
    expect(duplicateMerge.value.reference.citationCount).toBe(112);
    expect(duplicateMerge.value.reference.tags).toEqual(
      expect.arrayContaining(['workspace', 'verified']),
    );
  }
}

async function assertReferencePdfAttachmentAndRbac(
  service: ReferenceServiceLike,
  projectId: string,
  referenceId: string,
  pdfFileId: string,
  editor: ReferenceActor,
  viewer: ReferenceActor,
): Promise<void> {
  const attached = await service.attachPdf(editor, {
    projectId,
    referenceId,
    localPdfFileId: pdfFileId,
  });
  expect(attached.ok && ReferenceSchema.safeParse(attached.value).success).toBe(true);
  if (attached.ok) {
    expect(attached.value.localPdfFileId).toBe(pdfFileId);
  }

  const viewerList = await service.listReferences(viewer, { projectId, tag: 'workspace' });
  expect(viewerList.ok && viewerList.value.length === 1).toBe(true);

  const viewerMutateBlocked = await service.updateReference(viewer, projectId, referenceId, {
    notes: 'Unauthorized edit',
  });
  expect(viewerMutateBlocked.ok).toBe(false);
  if (!viewerMutateBlocked.ok) {
    expect(viewerMutateBlocked.error.code).toBe('FORBIDDEN');
  }
}

async function assertProjectScopedUniqueness(service: ReferenceServiceLike): Promise<void> {
  const projectA = '11111111-1111-4111-8111-111111111111';
  const projectB = '99999999-9999-4999-8999-999999999999';
  const editor: ReferenceActor = {
    userId: '33333333-3333-4333-8333-333333333333',
    role: 'editor',
  };

  const seed = await service.createReference(editor, {
    projectId: projectA,
    citeKey: 'custom2024',
    title: 'Project-Scoped Uniqueness Study',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-99999-9',
    sourceProvider: 'manual',
  });
  expect(seed.ok && seed.value.status === 'created').toBe(true);

  const secondInA = await service.createReference(editor, {
    projectId: projectA,
    citeKey: 'other2024',
    title: 'Second Paper In Same Project',
    authors: [{ family: 'Chen', given: 'Wei', displayName: 'Wei Chen', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-88888-8',
    sourceProvider: 'manual',
  });
  expect(secondInA.ok && secondInA.value.status === 'created').toBe(true);
  if (!secondInA.ok || secondInA.value.status !== 'created') {
    return;
  }

  const sameProjectDupKeyUpdate = await service.updateReference(
    editor,
    projectA,
    secondInA.value.reference.id,
    { citeKey: 'CUSTOM2024' },
  );
  expect(sameProjectDupKeyUpdate.ok).toBe(false);
  if (!sameProjectDupKeyUpdate.ok) {
    expect(sameProjectDupKeyUpdate.error.code).toBe('CONFLICT');
  }

  const sameProjectDupDoi = await service.createReference(editor, {
    projectId: projectA,
    title: 'Duplicate DOI In Same Project',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-99999-9',
    sourceProvider: 'manual',
  });
  expect(sameProjectDupDoi.ok && sameProjectDupDoi.value.status === 'conflict').toBe(true);

  const otherProjectAllowed = await service.createReference(editor, {
    projectId: projectB,
    citeKey: 'custom2024',
    title: 'Project-Scoped Uniqueness Study',
    authors: [{ family: 'Smith', given: 'Jane', displayName: 'Jane Smith', orcid: null }],
    year: 2024,
    doi: '10.1038/s41586-024-99999-9',
    sourceProvider: 'manual',
  });
  expect(otherProjectAllowed.ok && otherProjectAllowed.value.status === 'created').toBe(true);
  if (otherProjectAllowed.ok && otherProjectAllowed.value.status === 'created') {
    expect(otherProjectAllowed.value.reference.citeKey).toBe('custom2024');
    expect(otherProjectAllowed.value.reference.doi).toBe('10.1038/s41586-024-99999-9');
  }
}

describe('Phase 2.2 Project bibliography database and Reference Manager UI acceptance', () => {
  it('provides SQL migration defining project references table with mandatory columns and unique constraints', () => {
    const migrationsDir = join(REPO_ROOT, 'apps/api/src/db/migrations');
    expect(existsSync(migrationsDir)).toBe(true);

    const allSql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => readFileSync(join(migrationsDir, entry.name), 'utf8'))
      .join('\n');

    expect(allSql).toMatch(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:project_references|"references")/i,
    );
    expect(allSql).toMatch(/cite_key/i);
    expect(allSql).toMatch(/local_pdf_file_id/i);
    expect(allSql).toMatch(/citation_count/i);
    expect(allSql).toMatch(/source_provider/i);
    const statements = allSql
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    const hasUniqueCiteKeyIndex = statements.some((statement) =>
      /^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:project_references|"references")\s*\(\s*project_id\s*,\s*LOWER\(\s*cite_key\s*\)\s*\)$/i.test(
        statement,
      ),
    );
    const hasUniqueDoiIndex = statements.some((statement) =>
      /^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:project_references|"references")\s*\(\s*project_id\s*,\s*doi\s*\)\s+WHERE\s+doi\s+IS\s+NOT\s+NULL$/i.test(
        statement,
      ),
    );
    expect(hasUniqueCiteKeyIndex).toBe(true);
    expect(hasUniqueDoiIndex).toBe(true);
  });

  it('rejects duplicate citeKey and DOI within the same project while allowing them in different projects', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/reference-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryReferenceService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryReferenceService')) {
      return;
    }

    const factory = (loaded as ReferenceServiceModuleLike).createInMemoryReferenceService;
    await assertProjectScopedUniqueness(factory());
  });

  it('supports reference CRUD, deterministic citeKey disambiguation, duplicate DOI conflict/merge, PDF attachment, and RBAC', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/reference-service.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryReferenceService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryReferenceService')) {
      return;
    }

    const projectId = '11111111-1111-4111-8111-111111111111';
    const pdfFileId = '22222222-2222-4222-8222-222222222222';
    const factory = (loaded as ReferenceServiceModuleLike).createInMemoryReferenceService;
    const service = factory({
      assertFileInProject: async (pid, fid) => pid === projectId && fid === pdfFileId,
    });
    const editor: ReferenceActor = {
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'editor',
    };
    const viewer: ReferenceActor = {
      userId: '44444444-4444-4444-8444-444444444444',
      role: 'viewer',
    };

    const firstRefId = await assertCiteKeyDisambiguation(service, projectId, editor);
    expect(firstRefId.length).toBeGreaterThan(0);
    if (firstRefId.length > 0) {
      await assertDuplicateDoiConflictAndMerge(service, projectId, editor);
      await assertReferencePdfAttachmentAndRbac(
        service,
        projectId,
        firstRefId,
        pdfFileId,
        editor,
        viewer,
      );
    }
  });

  it('rejects linking unregistered PDF UUIDs when no explicit assertFileInProject verifier approves them', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryReferenceService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryReferenceService')) {
      return;
    }

    const service = (loaded as ReferenceServiceModuleLike).createInMemoryReferenceService();
    const projectId = '11111111-1111-4111-8111-111111111111';
    const unregisteredPdfId = '88888888-8888-4888-8888-888888888888';
    const editor: ReferenceActor = {
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'editor',
    };

    const createWithUnregistered = await service.createReference(editor, {
      projectId,
      title: 'Reference With Unregistered PDF',
      localPdfFileId: unregisteredPdfId,
      sourceProvider: 'manual',
    });
    expect(createWithUnregistered.ok).toBe(false);
    if (!createWithUnregistered.ok) {
      expect(createWithUnregistered.error.code).toBe('NOT_FOUND');
    }

    const baseRef = await service.createReference(editor, {
      projectId,
      title: 'Reference Without PDF',
      sourceProvider: 'manual',
    });
    expect(baseRef.ok && baseRef.value.status === 'created').toBe(true);
    if (!baseRef.ok || baseRef.value.status !== 'created') {
      return;
    }

    const attachUnregistered = await service.attachPdf(editor, {
      projectId,
      referenceId: baseRef.value.reference.id,
      localPdfFileId: unregisteredPdfId,
    });
    expect(attachUnregistered.ok).toBe(false);
    if (!attachUnregistered.ok) {
      expect(attachUnregistered.error.code).toBe('NOT_FOUND');
    }
  });

  it('isolates uncommitted in-memory batch writes from root reads until commit', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createReferenceService')).toBe(true);
    expect(hasFunctionProp(loaded, 'createInMemoryReferenceRepository')).toBe(true);
    if (
      !hasFunctionProp(loaded, 'createReferenceService') ||
      !hasFunctionProp(loaded, 'createInMemoryReferenceRepository')
    ) {
      return;
    }

    const mod = loaded as ReferenceServiceModuleLike;
    const projectId = '11111111-1111-4111-8111-111111111111';
    const editor: ReferenceActor = {
      userId: '33333333-3333-4333-8333-333333333333',
      role: 'editor',
    };

    const txService = mod.createReferenceService(mod.createInMemoryReferenceRepository());
    expect(typeof txService.runBatch).toBe('function');
    if (!txService.runBatch) {
      return;
    }

    let rootCountDuringRollback = -1;
    let txCountDuringRollback = -1;
    await expect(
      txService.runBatch(async (scoped) => {
        await scoped.createReference(editor, {
          projectId,
          title: 'Staged Rolled Back Paper',
          doi: '10.1000/staged-rollback',
          sourceProvider: 'manual',
        });
        const txVisible = await scoped.listReferences(editor, { projectId });
        const rootVisible = await txService.listReferences(editor, { projectId });
        txCountDuringRollback = txVisible.ok ? txVisible.value.length : -1;
        rootCountDuringRollback = rootVisible.ok ? rootVisible.value.length : -1;
        throw new Error('abort batch');
      }),
    ).rejects.toThrow('abort batch');

    expect(txCountDuringRollback).toBe(1);
    expect(rootCountDuringRollback).toBe(0);

    let rootCountBeforeCommit = -1;
    await txService.runBatch(async (scoped) => {
      await scoped.createReference(editor, {
        projectId,
        title: 'Staged Committed Paper',
        doi: '10.1000/staged-commit',
        sourceProvider: 'manual',
      });
      const rootVisible = await txService.listReferences(editor, { projectId });
      rootCountBeforeCommit = rootVisible.ok ? rootVisible.value.length : -1;
    });

    expect(rootCountBeforeCommit).toBe(0);
    const afterCommit = await txService.listReferences(editor, { projectId });
    expect(afterCommit.ok && afterCommit.value.length === 1).toBe(true);
  });

  it('omits runBatch when the reference repository lacks runInTransaction', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/reference-service.ts');
    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createReferenceService')).toBe(true);
    expect(hasFunctionProp(loaded, 'createInMemoryReferenceRepository')).toBe(true);
    if (
      !hasFunctionProp(loaded, 'createReferenceService') ||
      !hasFunctionProp(loaded, 'createInMemoryReferenceRepository')
    ) {
      return;
    }

    const mod = loaded as ReferenceServiceModuleLike;
    const nonTxService = mod.createReferenceService(createNonTransactionalReferenceRepository());
    expect(nonTxService.runBatch).toBeUndefined();

    const txService = mod.createReferenceService(mod.createInMemoryReferenceRepository());
    expect(typeof txService.runBatch).toBe('function');
  });

  it('manages Left Sidebar References workspace filtering, selection, and read-only RBAC state', async () => {
    const statePath = join(
      REPO_ROOT,
      'apps/desktop/src/renderer/references/reference-manager-state.ts',
    );
    expect(
      existsSync(statePath),
      'Missing apps/desktop/src/renderer/references/reference-manager-state.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(statePath).href);
    expect(hasFunctionProp(loaded, 'createReferenceManagerController')).toBe(true);
    if (!hasFunctionProp(loaded, 'createReferenceManagerController')) {
      return;
    }

    const factory = (
      loaded as {
        readonly createReferenceManagerController: (
          projectId: string,
          role: ProjectRole,
        ) => ReferenceManagerControllerLike;
      }
    ).createReferenceManagerController;

    const projectId = '11111111-1111-4111-8111-111111111111';
    const viewerController = factory(projectId, 'viewer');
    expect(viewerController.getState().isReadOnly).toBe(true);
    expect(ReferenceManagerViewStateSchema.safeParse(viewerController.getState()).success).toBe(
      true,
    );

    const editorController = factory(projectId, 'editor');
    expect(editorController.getState().isReadOnly).toBe(false);
    editorController.setActiveTag('ml');
    editorController.setSearchQuery('smith');
    expect(editorController.getState().activeTag).toBe('ml');
    expect(editorController.getState().searchQuery).toBe('smith');
  });

  it('registers authenticated reference bibliography HTTP controller routes', async () => {
    const controllerPath = join(REPO_ROOT, 'apps/api/src/controllers/reference-controller.ts');
    expect(
      existsSync(controllerPath),
      'Missing apps/api/src/controllers/reference-controller.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(hasFunctionProp(loaded, 'registerReferenceRoutes')).toBe(true);
  });
});
