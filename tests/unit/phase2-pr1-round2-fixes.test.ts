import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PdfSelectionContext, PdfViewerState } from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { registerIngestionRoutes } from '../../apps/api/src/controllers/ingestion-controller.js';
import { createApiServer } from '../../apps/api/src/server.js';
import { createInMemoryAuthService } from '../../apps/api/src/services/auth-service.js';
import { createInMemoryFileExplorerService } from '../../apps/api/src/services/file-explorer-service.js';
import { createIngestionService } from '../../apps/api/src/services/ingestion-service.js';
import { createInMemoryProjectService } from '../../apps/api/src/services/project-service.js';
import { createInMemoryReferenceService } from '../../apps/api/src/services/reference-service.js';
import {
  clearTextLayerElement,
  isSelectionForCurrentPane,
  resetTextLayerElement,
  resolveEffectiveSelection,
} from '../../apps/desktop/src/renderer/pdf-viewer/pdf-viewer-state.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '99999999-9999-4999-8999-999999999999';
const FILE_A = '22222222-2222-4222-8222-222222222222';
const FILE_B = '88888888-8888-4888-8888-888888888888';
const REF_A = '33333333-3333-4333-8333-333333333333';
const USER_A = '44444444-4444-4444-8444-444444444444';
const EDITOR_ACTOR = { userId: USER_A, role: 'editor' as const };

function buildViewerState(overrides: Partial<PdfViewerState> = {}): PdfViewerState {
  return {
    projectId: PROJECT_A,
    fileId: FILE_A,
    referenceId: REF_A,
    currentPage: 1,
    totalPages: 10,
    zoom: 1,
    thumbnailsOpen: false,
    searchQuery: '',
    searchMatches: [],
    activeMatchIndex: -1,
    isReadOnly: false,
    ...overrides,
  };
}

function buildSelection(overrides: Partial<PdfSelectionContext> = {}): PdfSelectionContext {
  return {
    projectId: PROJECT_A,
    fileId: FILE_A,
    referenceId: REF_A,
    citeKey: 'smith2024',
    pageNumber: 1,
    selectedText: 'Selected passage',
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }],
    ...overrides,
  };
}

async function setupAuthenticatedProject() {
  const authService = createInMemoryAuthService();
  const signup = await authService.signup({
    email: 'cr2-single-read@sunrise.edu',
    password: 'StrongPassword!2026',
    displayName: 'CR2 Tester',
  });
  if (!signup.ok) {
    throw new Error('Failed to create test user');
  }
  const projectService = createInMemoryProjectService([signup.value.user]);
  const project = await projectService.createProject(signup.value.user.id, { name: 'CR2 Proj' });
  if (!project.ok) {
    throw new Error('Failed to create test project');
  }
  return {
    authService,
    projectService,
    projectId: project.value.id,
    headers: { authorization: `Bearer ${signup.value.tokens.accessToken}` },
  };
}

describe('PR #1 CodeRabbit Round 2 unit regression coverage', () => {
  it('verifies actual %PDF- magic signature in hasPdfFileInProject instead of trusting mimeType or extension (CR2-2)', async () => {
    const explorer = createInMemoryFileExplorerService();

    const spoofedExt = await explorer.uploadFile(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      fileName: 'spoofed.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 11,
      contentBase64: Buffer.from('plain text!', 'utf8').toString('base64'),
    });
    const spoofedMime = await explorer.uploadFile(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      fileName: 'notes.txt',
      mimeType: 'application/pdf',
      sizeBytes: 12,
      contentBase64: Buffer.from('not a pdf!!!', 'utf8').toString('base64'),
    });
    const extensionlessPdf = await explorer.uploadFile(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      parentId: null,
      fileName: 'downloaded-manuscript',
      mimeType: 'application/octet-stream',
      sizeBytes: 15,
      contentBase64: Buffer.from('%PDF-1.7\n%body\n', 'utf8').toString('base64'),
    });

    expect(spoofedExt.ok && spoofedMime.ok && extensionlessPdf.ok).toBe(true);
    if (!spoofedExt.ok || !spoofedMime.ok || !extensionlessPdf.ok) {
      return;
    }

    expect(await explorer.hasPdfFileInProject(PROJECT_A, spoofedExt.value.id)).toBe(false);
    expect(await explorer.hasPdfFileInProject(PROJECT_A, spoofedMime.value.id)).toBe(false);
    expect(await explorer.hasPdfFileInProject(PROJECT_A, extensionlessPdf.value.id)).toBe(true);
  });

  it('compares normalized author fields separately so pipe delimiters cannot cause false equality (CR2-9)', async () => {
    const service = createInMemoryReferenceService();
    const base = await service.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Delimiter Conflict Study',
      authors: [{ family: 'A|B', given: 'C', displayName: 'Display Name', orcid: null }],
      year: 2025,
      doi: '10.1000/delimiter-authors',
    });
    expect(base.ok && base.value.status === 'created').toBe(true);

    const pipeCollisionAttempt = await service.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Delimiter Conflict Study',
      authors: [{ family: 'A', given: 'B|C', displayName: 'Display Name', orcid: null }],
      year: 2025,
      doi: '10.1000/delimiter-authors',
      onDuplicate: 'prompt',
    });
    expect(pipeCollisionAttempt.ok && pipeCollisionAttempt.value.status === 'conflict').toBe(true);
    if (pipeCollisionAttempt.ok && pipeCollisionAttempt.value.status === 'conflict') {
      expect(pipeCollisionAttempt.value.conflict.conflictingFields).toContain('authors');
    }

    const caseInsensitiveSame = await service.createReference(EDITOR_ACTOR, {
      projectId: PROJECT_A,
      title: 'Delimiter Conflict Study',
      authors: [{ family: '  a|b ', given: ' c ', displayName: 'display name', orcid: null }],
      year: 2025,
      doi: '10.1000/delimiter-authors',
      onDuplicate: 'prompt',
    });
    expect(caseInsensitiveSame.ok && caseInsensitiveSame.value.status === 'conflict').toBe(true);
    if (caseInsensitiveSame.ok && caseInsensitiveSame.value.status === 'conflict') {
      expect(caseInsensitiveSame.value.conflict.conflictingFields).not.toContain('authors');
    }
  });

  it('performs stored PDF comparison and extraction in a single service read and preserves error mapping (CR2-17)', async () => {
    const storedBytes = Uint8Array.from(Buffer.from('%PDF-1.7 single-read-payload', 'utf8'));
    const matchingBase64 = Buffer.from(storedBytes).toString('base64');
    const mismatchedBase64 = Buffer.from('%PDF-1.7 wrong-inline-payload', 'utf8').toString(
      'base64',
    );
    const { authService, projectService, projectId, headers } = await setupAuthenticatedProject();

    const refService = createInMemoryReferenceService({
      assertFileInProject: async (pid, fid) => pid === projectId && fid === FILE_A,
    });
    const serviceFetchSpy = vi.fn(async () => storedBytes);
    const ingestionService = createIngestionService({
      referenceService: refService,
      fetchPdfBytes: serviceFetchSpy,
      hydrateByDoi: async () => null,
      extractPdfContent: async () => ({
        text: 'Single Read Verified Paper',
        xmpTitle: 'Single Read Verified Paper',
        xmpAuthors: [],
        xmpDoi: null,
      }),
    });

    const readSpy = vi.fn(async () => storedBytes);
    const app = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
    );
    registerIngestionRoutes(app, authService, projectService, ingestionService, {
      assertFileInProject: async (pid, fid) => pid === projectId && fid === FILE_A,
      readFileBytes: readSpy,
    });

    try {
      const okRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers,
        payload: { localPdfFileId: FILE_A, fileName: 'single.pdf', pdfBase64: matchingBase64 },
      });
      expect(okRes.statusCode).toBe(201);
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(serviceFetchSpy).toHaveBeenCalledTimes(0);

      const mismatchRes = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers,
        payload: { localPdfFileId: FILE_A, fileName: 'single.pdf', pdfBase64: mismatchedBase64 },
      });
      expect(mismatchRes.statusCode).toBe(400);
      expect(readSpy).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }

    const throwingApp = createApiServer(
      { checkPostgres: async () => 1, checkPgvector: async () => 1, checkS3: async () => 1 },
      '0.1.0',
    );
    registerIngestionRoutes(throwingApp, authService, projectService, ingestionService, {
      assertFileInProject: async () => true,
      readFileBytes: async () => {
        throw new Error('storage down');
      },
    });
    try {
      const errRes = await throwingApp.inject({
        method: 'POST',
        url: `/projects/${projectId}/ingestion/pdf`,
        headers,
        payload: { localPdfFileId: FILE_A, fileName: 'single.pdf', pdfBase64: matchingBase64 },
      });
      expect(errRes.statusCode).toBe(503);
    } finally {
      await throwingApp.close();
    }
  });

  it('clears and disables the PDF text layer before awaiting renders and scopes fallback selections to the current pane (CR2-13, CR2-14)', () => {
    const cssProperties = new Map<string, string>();
    const fakeContainer = {
      innerHTML: '<span>Previous page selectable text</span>',
      style: {
        pointerEvents: '',
        width: '800px',
        height: '1000px',
        setProperty: (key: string, value: string) => {
          cssProperties.set(key, value);
        },
      },
    };

    clearTextLayerElement(fakeContainer);
    expect(fakeContainer.innerHTML).toBe('');
    expect(fakeContainer.style.pointerEvents).toBe('none');

    resetTextLayerElement(fakeContainer, 612.8, 792.4, 1.5);
    expect(fakeContainer.innerHTML).toBe('');
    expect(fakeContainer.style.pointerEvents).toBe('');
    expect(fakeContainer.style.width).toBe('612px');
    expect(fakeContainer.style.height).toBe('792px');
    expect(cssProperties.get('--scale-factor')).toBe('1.5');

    const pageOneState = buildViewerState({ projectId: PROJECT_A, fileId: FILE_A, currentPage: 1 });
    const pageOneSelection = buildSelection({
      projectId: PROJECT_A,
      fileId: FILE_A,
      pageNumber: 1,
    });
    const activeExternal = buildSelection({
      projectId: PROJECT_A,
      fileId: FILE_A,
      pageNumber: 1,
      selectedText: 'Controlled selection',
    });

    expect(isSelectionForCurrentPane(pageOneSelection, pageOneState)).toBe(true);
    expect(resolveEffectiveSelection(null, pageOneSelection, pageOneState)).toEqual(
      pageOneSelection,
    );
    expect(resolveEffectiveSelection(activeExternal, pageOneSelection, pageOneState)).toEqual(
      activeExternal,
    );

    expect(
      resolveEffectiveSelection(null, pageOneSelection, buildViewerState({ currentPage: 2 })),
    ).toBeNull();
    expect(
      resolveEffectiveSelection(null, pageOneSelection, buildViewerState({ fileId: FILE_B })),
    ).toBeNull();
    expect(
      resolveEffectiveSelection(null, pageOneSelection, buildViewerState({ projectId: PROJECT_B })),
    ).toBeNull();

    const source = readFileSync(
      join(REPO_ROOT, 'apps/desktop/src/renderer/pdf-viewer/PdfViewerPane.tsx'),
      'utf8',
    );
    const clearCallIndex = source.indexOf('clearTextLayerElement(textLayerRef.current);');
    const firstRenderAwaitIndex = source.indexOf('await loadedDoc.getPage(state.currentPage)');
    expect(clearCallIndex).toBeGreaterThan(-1);
    expect(firstRenderAwaitIndex).toBeGreaterThan(clearCallIndex);
    expect(source).toContain('setLocalSelection(null);');
    expect(source).toContain('[state.projectId, state.fileId, state.currentPage]');
    expect(source).toContain('resolveEffectiveSelection(activeSelection, localSelection, state)');
  });
});
