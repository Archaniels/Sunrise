import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  err,
  KeychainSessionSchema,
  ok,
  type KeychainSession,
  type OkBooleanOutput,
  type Result,
} from '@sunrise/shared';

export interface KeychainStorageDeps {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (plain: string) => Buffer;
  readonly decryptString: (cipher: Buffer) => string;
  readonly writeBlob: (blob: Buffer) => Promise<void>;
  readonly readBlob: () => Promise<Buffer | null>;
  readonly deleteBlob: () => Promise<void>;
}

export interface SafeStorageLike {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (plain: string) => Buffer;
  readonly decryptString: (cipher: Buffer) => string;
}

export interface KeychainSessionService {
  readonly saveSession: (session: KeychainSession) => Promise<Result<OkBooleanOutput>>;
  readonly loadSession: () => Promise<Result<KeychainSession | null>>;
  readonly clearSession: () => Promise<Result<OkBooleanOutput>>;
}

function isFileMissingError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createFileBackedKeychainDeps(
  blobFilePath: string,
  safeStorage: SafeStorageLike,
): KeychainStorageDeps {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (cipher) => safeStorage.decryptString(cipher),
    writeBlob: async (blob) => {
      await mkdir(dirname(blobFilePath), { recursive: true });
      await writeFile(blobFilePath, blob, { mode: 0o600 });
    },
    readBlob: async () => {
      try {
        return await readFile(blobFilePath);
      } catch (error: unknown) {
        if (isFileMissingError(error)) {
          return null;
        }
        throw error;
      }
    },
    deleteBlob: async () => {
      await rm(blobFilePath, { force: true });
    },
  };
}

export function createKeychainSessionService(deps: KeychainStorageDeps): KeychainSessionService {
  return {
    saveSession: async (session): Promise<Result<OkBooleanOutput>> => {
      if (!deps.isEncryptionAvailable()) {
        return err({
          code: 'SECURITY_POLICY_VIOLATION',
          message: 'OS keychain encryption is unavailable; refusing plaintext storage',
        });
      }
      const parsed = KeychainSessionSchema.safeParse(session);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid keychain session payload',
        });
      }
      try {
        const ciphertext = deps.encryptString(JSON.stringify(parsed.data));
        await deps.writeBlob(ciphertext);
        return ok({ completed: true });
      } catch {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Failed to persist encrypted keychain session',
        });
      }
    },

    loadSession: async (): Promise<Result<KeychainSession | null>> => {
      if (!deps.isEncryptionAvailable()) {
        return err({
          code: 'SECURITY_POLICY_VIOLATION',
          message: 'OS keychain encryption is unavailable',
        });
      }
      try {
        const blob = await deps.readBlob();
        if (blob === null || blob.length === 0) {
          return ok(null);
        }
        const plaintext = deps.decryptString(blob);
        const parsed = KeychainSessionSchema.safeParse(JSON.parse(plaintext));
        if (!parsed.success) {
          return err({
            code: 'INTERNAL_ERROR',
            message: 'Stored keychain session payload is corrupted',
          });
        }
        return ok(parsed.data);
      } catch {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Failed to decrypt stored keychain session',
        });
      }
    },

    clearSession: async (): Promise<Result<OkBooleanOutput>> => {
      try {
        await deps.deleteBlob();
        return ok({ completed: true });
      } catch {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Failed to clear keychain session',
        });
      }
    },
  };
}
