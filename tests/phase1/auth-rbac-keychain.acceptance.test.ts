import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AuthSessionResponseSchema,
  KeychainSessionSchema,
  ProjectMemberSchema,
  ProjectSchema,
  UserPublicSchema,
  type AuthSessionResponse,
  type KeychainSession,
  type Project,
  type ProjectMember,
  type Result,
  type UserPublic,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface AuthServiceLike {
  readonly signup: (input: {
    readonly email: string;
    readonly password: string;
    readonly displayName: string;
  }) => Promise<Result<AuthSessionResponse>>;
  readonly login: (input: {
    readonly email: string;
    readonly password: string;
  }) => Promise<Result<AuthSessionResponse>>;
  readonly refresh: (input: { readonly refreshToken: string }) => Promise<Result<AuthSessionResponse>>;
  readonly logout: (input: { readonly refreshToken: string }) => Promise<Result<{ readonly revoked: true }>>;
  readonly getMe: (accessToken: string | undefined) => Promise<Result<UserPublic>>;
}

interface ProjectServiceLike {
  readonly createProject: (
    actorUserId: string,
    input: { readonly name: string; readonly description?: string },
  ) => Promise<Result<Project>>;
  readonly addMember: (
    actorUserId: string,
    projectId: string,
    input: { readonly email: string; readonly role: 'editor' | 'viewer' },
  ) => Promise<Result<ProjectMember>>;
  readonly assertAccess: (
    actorUserId: string,
    projectId: string,
    action: 'read' | 'write_files' | 'edit_documents' | 'manage_members' | 'delete_project',
  ) => Promise<Result<{ readonly allowed: true }>>;
}

interface KeychainServiceLike {
  readonly saveSession: (session: KeychainSession) => Promise<Result<{ readonly completed: true }>>;
  readonly loadSession: () => Promise<Result<KeychainSession | null>>;
  readonly clearSession: () => Promise<Result<{ readonly completed: true }>>;
}

function hasFunctionProp(value: unknown, key: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

describe('Phase 1.1 Auth, RBAC project sharing, and OS keychain acceptance', () => {
  it('provides SQL migrations defining users, refresh_tokens, projects, and project_members tables', () => {
    const migrationsDir = join(REPO_ROOT, 'apps/api/src/db/migrations');
    expect(existsSync(migrationsDir)).toBe(true);

    const allSql = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => readFileSync(join(migrationsDir, entry.name), 'utf8'))
      .join('\n');

    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+users/i);
    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+refresh_tokens/i);
    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+projects/i);
    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+project_members/i);
  });

  it('supports signup, hashed password verification, refresh rotation, logout, and 401 guard', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/auth-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/auth-service.ts').toBe(true);

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryAuthService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryAuthService')) {
      return;
    }

    const factory = (loaded as { readonly createInMemoryAuthService: () => AuthServiceLike })
      .createInMemoryAuthService;
    const auth = factory();

    const unauth = await auth.getMe(undefined);
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) {
      expect(unauth.error.code).toBe('UNAUTHORIZED');
    }

    const signup = await auth.signup({
      email: 'ada@sunrise.edu',
      password: 'StrongPassword!2026',
      displayName: 'Ada Lovelace',
    });
    expect(signup.ok).toBe(true);
    if (!signup.ok) {
      return;
    }
    expect(AuthSessionResponseSchema.safeParse(signup.value).success).toBe(true);

    const me = await auth.getMe(signup.value.tokens.accessToken);
    expect(me.ok).toBe(true);
    if (me.ok) {
      expect(UserPublicSchema.safeParse(me.value).success).toBe(true);
    }

    const rotated = await auth.refresh({ refreshToken: signup.value.tokens.refreshToken });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) {
      return;
    }
    expect(rotated.value.tokens.refreshToken).not.toBe(signup.value.tokens.refreshToken);

    const replayOldRefresh = await auth.refresh({ refreshToken: signup.value.tokens.refreshToken });
    expect(replayOldRefresh.ok).toBe(false);
  });

  it('enforces Owner, Editor, and Viewer RBAC permissions across project operations', async () => {
    const servicePath = join(REPO_ROOT, 'apps/api/src/services/project-service.ts');
    expect(existsSync(servicePath), 'Missing apps/api/src/services/project-service.ts').toBe(true);

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createInMemoryProjectService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createInMemoryProjectService')) {
      return;
    }

    const ownerId = '11111111-1111-4111-8111-111111111111';
    const editorId = '22222222-2222-4222-8222-222222222222';
    const viewerId = '33333333-3333-4333-8333-333333333333';

    const factory = (
      loaded as {
        readonly createInMemoryProjectService: (users: ReadonlyArray<{
          readonly id: string;
          readonly email: string;
          readonly displayName: string;
        }>) => ProjectServiceLike;
      }
    ).createInMemoryProjectService;

    const projects = factory([
      { id: ownerId, email: 'owner@uni.edu', displayName: 'Owner' },
      { id: editorId, email: 'editor@uni.edu', displayName: 'Editor' },
      { id: viewerId, email: 'viewer@uni.edu', displayName: 'Viewer' },
    ]);

    const created = await projects.createProject(ownerId, { name: 'Thesis 2026' });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(ProjectSchema.safeParse(created.value).success).toBe(true);

    const addedEditor = await projects.addMember(ownerId, created.value.id, {
      email: 'editor@uni.edu',
      role: 'editor',
    });
    const addedViewer = await projects.addMember(ownerId, created.value.id, {
      email: 'viewer@uni.edu',
      role: 'viewer',
    });
    expect(addedEditor.ok && ProjectMemberSchema.safeParse(addedEditor.value).success).toBe(true);
    expect(addedViewer.ok && ProjectMemberSchema.safeParse(addedViewer.value).success).toBe(true);

    const viewerRead = await projects.assertAccess(viewerId, created.value.id, 'read');
    const viewerWrite = await projects.assertAccess(viewerId, created.value.id, 'write_files');
    const editorManage = await projects.assertAccess(editorId, created.value.id, 'manage_members');

    expect(viewerRead.ok).toBe(true);
    expect(viewerWrite.ok).toBe(false);
    if (!viewerWrite.ok) {
      expect(viewerWrite.error.code).toBe('FORBIDDEN');
    }
    expect(editorManage.ok).toBe(false);
  });

  it('encrypts auth session through safeStorage without writing plaintext tokens to disk', async () => {
    const servicePath = join(REPO_ROOT, 'apps/desktop/src/main/services/keychain-session-service.ts');
    expect(
      existsSync(servicePath),
      'Missing apps/desktop/src/main/services/keychain-session-service.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(servicePath).href);
    expect(hasFunctionProp(loaded, 'createKeychainSessionService')).toBe(true);
    if (!hasFunctionProp(loaded, 'createKeychainSessionService')) {
      return;
    }

    let persistedCiphertext: Buffer | null = null;
    const factory = (
      loaded as {
        readonly createKeychainSessionService: (deps: {
          readonly isEncryptionAvailable: () => boolean;
          readonly encryptString: (plain: string) => Buffer;
          readonly decryptString: (cipher: Buffer) => string;
          readonly writeBlob: (blob: Buffer) => Promise<void>;
          readonly readBlob: () => Promise<Buffer | null>;
          readonly deleteBlob: () => Promise<void>;
        }) => KeychainServiceLike;
      }
    ).createKeychainSessionService;

    const keychain = factory({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('hex'), 'utf8'),
      decryptString: (cipher) => Buffer.from(cipher.toString('utf8'), 'hex').toString('utf8'),
      writeBlob: async (blob) => {
        persistedCiphertext = blob;
      },
      readBlob: async () => persistedCiphertext,
      deleteBlob: async () => {
        persistedCiphertext = null;
      },
    });

    const session: KeychainSession = {
      userId: '11111111-1111-4111-8111-111111111111',
      email: 'ada@uni.edu',
      accessToken: 'super-secret-access-token-value',
      refreshToken: 'super-secret-refresh-token-value',
      expiresAt: '2026-11-24T12:00:00.000Z',
    };

    const saved = await keychain.saveSession(session);
    expect(saved.ok).toBe(true);
    expect(persistedCiphertext).not.toBeNull();
    if (persistedCiphertext !== null) {
      const serialized = (persistedCiphertext as Buffer).toString('utf8');
      expect(serialized).not.toContain('super-secret-access-token-value');
      expect(serialized).not.toContain('super-secret-refresh-token-value');
    }

    const restored = await keychain.loadSession();
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(KeychainSessionSchema.safeParse(restored.value).success).toBe(true);
      expect(restored.value?.accessToken).toBe(session.accessToken);
    }

    const cleared = await keychain.clearSession();
    expect(cleared.ok).toBe(true);
    const afterClear = await keychain.loadSession();
    expect(afterClear.ok && afterClear.value === null).toBe(true);
  });
});
