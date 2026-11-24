import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  AddProjectMemberInputSchema,
  CachedArtifactRecordSchema,
  canRolePerform,
  classifyFileByName,
  ColumnWidthsSchema,
  DEFAULT_COLUMN_WIDTHS,
  DraftReconciliationResultSchema,
  KeychainSessionSchema,
  matchesSidebarCategory,
  MAX_UPLOAD_BYTES,
  OfflineDraftRecordSchema,
  PHASE1_IPC_CHANNELS,
  Phase1IpcChannelContracts,
  QuickOpenItemSchema,
  resolveArtifactViewType,
  SafeFileNameSchema,
  SafeVirtualPathSchema,
  searchQuickOpenItems,
  SIDEBAR_CATEGORIES,
  SignupInputSchema,
  UploadFileInputSchema,
  UserPublicSchema,
  validateSafeVirtualPath,
  WorkspaceLayoutStateSchema,
  type QuickOpenItem,
} from '@sunrise/shared';

const SAMPLE_UUID_A = '11111111-1111-4111-8111-111111111111';
const SAMPLE_UUID_B = '22222222-2222-4222-8222-222222222222';
const SAMPLE_UUID_C = '33333333-3333-4333-8333-333333333333';
const SAMPLE_ISO = '2026-11-24T08:30:00.000Z';

function buildQuickOpenCorpus(count: number): QuickOpenItem[] {
  const items: QuickOpenItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const padded = String(i).padStart(4, '0');
    items.push({
      id: `00000000-0000-4000-8000-${padded.padStart(12, '0')}`,
      projectId: SAMPLE_UUID_A,
      entityType: i % 4 === 0 ? 'document' : i % 4 === 1 ? 'reference' : i % 4 === 2 ? 'figure' : 'file',
      title: i === 777 ? 'Chen2025_Climate_Synthesis.pdf' : `Artifact_${padded}.md`,
      subtitle: i === 777 ? 'Chen et al. (2025)' : `Folder ${i % 10}`,
      path: i === 777 ? 'papers/Chen2025_Climate_Synthesis.pdf' : `docs/Artifact_${padded}.md`,
      kind: i === 777 ? 'pdf' : 'markdown',
      updatedAt: SAMPLE_ISO,
    });
  }
  return items;
}

describe('Phase 1 shared contracts', () => {
  describe('1.1 Auth, RBAC, and keychain session contracts', () => {
    it('enforces Owner, Editor, and Viewer RBAC capabilities', () => {
      expect(canRolePerform('owner', 'read')).toBe(true);
      expect(canRolePerform('owner', 'manage_members')).toBe(true);
      expect(canRolePerform('owner', 'delete_project')).toBe(true);

      expect(canRolePerform('editor', 'read')).toBe(true);
      expect(canRolePerform('editor', 'write_files')).toBe(true);
      expect(canRolePerform('editor', 'edit_documents')).toBe(true);
      expect(canRolePerform('editor', 'manage_members')).toBe(false);
      expect(canRolePerform('editor', 'delete_project')).toBe(false);

      expect(canRolePerform('viewer', 'read')).toBe(true);
      expect(canRolePerform('viewer', 'write_files')).toBe(false);
      expect(canRolePerform('viewer', 'edit_documents')).toBe(false);
      expect(canRolePerform('viewer', 'manage_members')).toBe(false);
    });

    it('rejects weak passwords and strips extra secret fields from UserPublicSchema', () => {
      expect(
        SignupInputSchema.safeParse({
          email: 'Researcher@University.EDU',
          password: 'short',
          displayName: 'Dr. Ada',
        }).success,
      ).toBe(false);

      const validSignup = SignupInputSchema.safeParse({
        email: 'Researcher@University.EDU',
        password: 'StrongPassword!2026',
        displayName: 'Dr. Ada',
      });
      expect(validSignup.success).toBe(true);
      if (validSignup.success) {
        expect(validSignup.data.email).toBe('researcher@university.edu');
      }

      const leakedHash = UserPublicSchema.safeParse({
        id: SAMPLE_UUID_A,
        email: 'ada@university.edu',
        displayName: 'Dr. Ada',
        createdAt: SAMPLE_ISO,
        passwordHash: 'argon2id$secret',
      });
      expect(leakedHash.success).toBe(false);
    });

    it('validates project member invites and keychain session payload', () => {
      expect(
        AddProjectMemberInputSchema.safeParse({ email: 'lab@uni.edu', role: 'editor' }).success,
      ).toBe(true);
      expect(
        AddProjectMemberInputSchema.safeParse({ email: 'lab@uni.edu', role: 'owner' }).success,
      ).toBe(false);

      expect(
        KeychainSessionSchema.safeParse({
          userId: SAMPLE_UUID_A,
          email: 'ada@uni.edu',
          accessToken: 'jwt-access-token-1234567890',
          refreshToken: 'jwt-refresh-token-1234567890',
          expiresAt: SAMPLE_ISO,
        }).success,
      ).toBe(true);
    });
  });

  describe('1.2 Workspace shell, sidebar categories, and layout state contracts', () => {
    it('defines all 7 required sidebar categories and filters accurately', () => {
      expect(SIDEBAR_CATEGORIES).toEqual([
        'overview',
        'references',
        'data',
        'analysis',
        'reports',
        'figures',
        'all_files',
      ]);
      expect(matchesSidebarCategory('all_files', 'data')).toBe(true);
      expect(matchesSidebarCategory('data', 'data')).toBe(true);
      expect(matchesSidebarCategory('data', 'figures')).toBe(false);
      expect(matchesSidebarCategory('figures', 'figures')).toBe(true);
    });

    it('routes artifact file kinds to center workspace view containers', () => {
      expect(resolveArtifactViewType('pdf')).toBe('pdf');
      expect(resolveArtifactViewType('csv')).toBe('spreadsheet');
      expect(resolveArtifactViewType('xlsx')).toBe('spreadsheet');
      expect(resolveArtifactViewType('notebook')).toBe('notebook');
      expect(resolveArtifactViewType('code')).toBe('code');
      expect(resolveArtifactViewType('mermaid')).toBe('diagram');
      expect(resolveArtifactViewType('image')).toBe('image');
      expect(resolveArtifactViewType('markdown')).toBe('document');
    });

    it('enforces column width bounds and workspace layout schema', () => {
      expect(ColumnWidthsSchema.safeParse(DEFAULT_COLUMN_WIDTHS).success).toBe(true);
      expect(
        ColumnWidthsSchema.safeParse({
          ...DEFAULT_COLUMN_WIDTHS,
          leftSidebarPx: 50,
        }).success,
      ).toBe(false);

      expect(
        WorkspaceLayoutStateSchema.safeParse({
          projectId: SAMPLE_UUID_A,
          activeCategory: 'reports',
          tabs: [
            {
              id: 'tab-1',
              projectId: SAMPLE_UUID_A,
              artifactId: SAMPLE_UUID_B,
              title: 'Draft.md',
              viewType: 'document',
              isDirty: false,
              isPinned: false,
              isReadOnly: false,
            },
          ],
          activeTabId: 'tab-1',
          columns: DEFAULT_COLUMN_WIDTHS,
        }).success,
      ).toBe(true);
    });
  });

  describe('1.3 Cloud file explorer path safety, classification, and payload bounds', () => {
    it('blocks path traversal, backslashes, control characters, and reserved OS names', () => {
      expect(validateSafeVirtualPath('papers/2025/chen2025.pdf').ok).toBe(true);
      expect(validateSafeVirtualPath('../secret.env').ok).toBe(false);
      expect(validateSafeVirtualPath('papers/../../etc/passwd').ok).toBe(false);
      expect(validateSafeVirtualPath('/absolute/path.txt').ok).toBe(false);
      expect(validateSafeVirtualPath('windows\\path.txt').ok).toBe(false);
      expect(validateSafeVirtualPath('C:/evil.txt').ok).toBe(false);
      expect(validateSafeVirtualPath('data/CON.csv').ok).toBe(false);
      expect(SafeFileNameSchema.safeParse('..').success).toBe(false);
      expect(SafeVirtualPathSchema.safeParse('data/experiment_01.csv').success).toBe(true);
    });

    it('classifies academic, data, analysis, and figure file extensions deterministically', () => {
      expect(classifyFileByName('paper.pdf')).toEqual({
        kind: 'pdf',
        mimeType: 'application/pdf',
        category: 'references',
      });
      expect(classifyFileByName('library.bib').kind).toBe('bibtex');
      expect(classifyFileByName('export.ris').kind).toBe('ris');
      expect(classifyFileByName('results.csv').category).toBe('data');
      expect(classifyFileByName('sheet.xlsx').kind).toBe('xlsx');
      expect(classifyFileByName('model.ipynb').kind).toBe('notebook');
      expect(classifyFileByName('train.py').kind).toBe('code');
      expect(classifyFileByName('flow.mmd').kind).toBe('mermaid');
      expect(classifyFileByName('chart.svg').category).toBe('figures');
      expect(classifyFileByName('unknown.xyz').kind).toBe('other');
    });

    it('enforces upload size limits and Phase 1 IPC payload validation', () => {
      expect(
        UploadFileInputSchema.safeParse({
          projectId: SAMPLE_UUID_A,
          parentId: null,
          fileName: 'dataset.csv',
          sizeBytes: 1024,
        }).success,
      ).toBe(true);

      expect(
        UploadFileInputSchema.safeParse({
          projectId: SAMPLE_UUID_A,
          parentId: null,
          fileName: 'huge.bin',
          sizeBytes: MAX_UPLOAD_BYTES + 1,
        }).success,
      ).toBe(false);

      expect(
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_SAVE_FILE].input.safeParse({
          suggestedName: '../escape.txt',
          contentBase64: 'SGVsbG8=',
        }).success,
      ).toBe(false);
    });
  });

  describe('1.4 Quick Open performance and offline cache/draft contracts', () => {
    it('ranks fuzzy matches accurately and searches 1,000 items under 150ms', () => {
      const corpus = buildQuickOpenCorpus(1000);
      expect(QuickOpenItemSchema.safeParse(corpus[777]).success).toBe(true);

      const start = performance.now();
      const results = searchQuickOpenItems(corpus, 'chen2025', 10);
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeLessThan(150);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.item.title).toBe('Chen2025_Climate_Synthesis.pdf');
    });

    it('enforces readOnly cached artifacts and versioned offline draft reconciliation contracts', () => {
      expect(
        CachedArtifactRecordSchema.safeParse({
          projectId: SAMPLE_UUID_A,
          artifactId: SAMPLE_UUID_B,
          artifactType: 'document',
          title: 'Thesis.md',
          contentText: '# Abstract',
          localBlobPath: null,
          serverVersion: 3,
          cachedAt: SAMPLE_ISO,
          sizeBytes: 10,
          readOnly: true,
        }).success,
      ).toBe(true);

      expect(
        CachedArtifactRecordSchema.safeParse({
          projectId: SAMPLE_UUID_A,
          artifactId: SAMPLE_UUID_B,
          artifactType: 'document',
          title: 'Thesis.md',
          contentText: '# Abstract',
          localBlobPath: null,
          serverVersion: 3,
          cachedAt: SAMPLE_ISO,
          sizeBytes: 10,
          readOnly: false,
        }).success,
      ).toBe(false);

      expect(
        OfflineDraftRecordSchema.safeParse({
          draftId: SAMPLE_UUID_C,
          projectId: SAMPLE_UUID_A,
          documentId: SAMPLE_UUID_B,
          baseServerVersion: 3,
          payloadJson: '{"type":"doc","content":[]}',
          updatedAt: SAMPLE_ISO,
          syncStatus: 'pending_sync',
        }).success,
      ).toBe(true);

      expect(
        DraftReconciliationResultSchema.safeParse({
          draftId: SAMPLE_UUID_C,
          documentId: SAMPLE_UUID_B,
          outcome: 'conflict_requires_review',
          serverVersion: 4,
          conflictSummary: 'Remote version 4 is newer than draft base version 3',
        }).success,
      ).toBe(true);
    });
  });
});
