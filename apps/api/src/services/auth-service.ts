import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import {
  AuthSessionResponseSchema,
  err,
  LoginInputSchema,
  LogoutInputSchema,
  ok,
  RefreshSessionInputSchema,
  SignupInputSchema,
  UserPublicSchema,
  type AuthSessionResponse,
  type AuthTokens,
  type LoginInput,
  type LogoutInput,
  type RefreshSessionInput,
  type Result,
  type SignupInput,
  type UserPublic,
} from '@sunrise/shared';
import type { z } from 'zod';
import { createPostgresAuthRepository } from '../db/auth-repository.js';
import type { TransactionPool } from '../db/transaction.js';

export interface StoredUserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface StoredRefreshTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly replacedBy: string | null;
  readonly createdAt: string;
}

export interface AuthRepository {
  readonly findUserByEmail: (email: string) => Promise<StoredUserRecord | null>;
  readonly findUserById: (userId: string) => Promise<StoredUserRecord | null>;
  readonly createUser: (record: StoredUserRecord) => Promise<StoredUserRecord>;
  readonly saveRefreshToken: (record: StoredRefreshTokenRecord) => Promise<void>;
  readonly findRefreshTokenByHash: (tokenHash: string) => Promise<StoredRefreshTokenRecord | null>;
  readonly findRefreshTokenByHashForUpdate?: (
    tokenHash: string,
  ) => Promise<StoredRefreshTokenRecord | null>;
  readonly revokeRefreshToken: (
    tokenId: string,
    revokedAt: string,
    replacedBy: string | null,
  ) => Promise<void>;
  readonly revokeAllUserRefreshTokens: (userId: string, revokedAt: string) => Promise<void>;
  readonly runInTransaction?: <T>(fn: (txRepo: AuthRepository) => Promise<T>) => Promise<T>;
}

export interface AuthServiceOptions {
  readonly accessSecret: Uint8Array;
  readonly refreshSecret: Uint8Array;
  readonly accessTtlSeconds?: number;
  readonly refreshTtlSeconds?: number;
  readonly now?: () => Date;
}

export interface AuthService {
  readonly signup: (input: SignupInput) => Promise<Result<AuthSessionResponse>>;
  readonly login: (input: LoginInput) => Promise<Result<AuthSessionResponse>>;
  readonly refresh: (input: RefreshSessionInput) => Promise<Result<AuthSessionResponse>>;
  readonly logout: (input: LogoutInput) => Promise<Result<{ readonly revoked: true }>>;
  readonly getMe: (accessToken: string | undefined) => Promise<Result<UserPublic>>;
}

const DEFAULT_ACCESS_TTL_SECONDS = 900;
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toPublicUser(user: StoredUserRecord): UserPublic {
  return UserPublicSchema.parse({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  });
}

function firstValidationError(error: z.ZodError, fallback: string): string {
  const message = error.issues[0]?.message;
  if (message && message.trim().length > 0) {
    return message.trim().slice(0, 500);
  }
  return fallback;
}

async function signJwtToken(
  userId: string,
  tokenType: 'access' | 'refresh',
  jti: string,
  secret: Uint8Array,
  issuedAtSeconds: number,
  expiresAtSeconds: number,
): Promise<string> {
  return new SignJWT({ typ: tokenType })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(secret);
}

async function issueSessionTokens(
  repo: AuthRepository,
  user: StoredUserRecord,
  options: Required<AuthServiceOptions>,
): Promise<{ readonly tokens: AuthTokens; readonly refreshRecordId: string }> {
  const nowDate = options.now();
  const nowMs = nowDate.getTime();
  const nowSec = Math.floor(nowMs / 1000);
  const accessExpSec = nowSec + options.accessTtlSeconds;
  const refreshExpSec = nowSec + options.refreshTtlSeconds;

  const accessToken = await signJwtToken(
    user.id,
    'access',
    randomUUID(),
    options.accessSecret,
    nowSec,
    accessExpSec,
  );
  const refreshRecordId = randomUUID();
  const refreshToken = await signJwtToken(
    user.id,
    'refresh',
    refreshRecordId,
    options.refreshSecret,
    nowSec,
    refreshExpSec,
  );

  await repo.saveRefreshToken({
    id: refreshRecordId,
    userId: user.id,
    tokenHash: sha256Hex(refreshToken),
    expiresAt: new Date(refreshExpSec * 1000).toISOString(),
    revokedAt: null,
    replacedBy: null,
    createdAt: nowDate.toISOString(),
  });

  return {
    refreshRecordId,
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: new Date(accessExpSec * 1000).toISOString(),
      tokenType: 'Bearer',
    },
  };
}

async function verifyTypedJwt(
  token: string,
  secret: Uint8Array,
  expectedType: 'access' | 'refresh',
): Promise<{ readonly sub: string; readonly jti: string } | null> {
  try {
    const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const sub = verified.payload.sub;
    const jti = verified.payload.jti;
    const typ = verified.payload['typ'];
    if (typeof sub !== 'string' || typeof jti !== 'string' || typ !== expectedType) {
      return null;
    }
    return { sub, jti };
  } catch {
    return null;
  }
}

async function executeInAuthTransaction<T>(
  repo: AuthRepository,
  fn: (txRepo: AuthRepository) => Promise<T>,
): Promise<T> {
  if (repo.runInTransaction) {
    return repo.runInTransaction(fn);
  }
  return fn(repo);
}

async function rotateRefreshTokenAtomically(
  txRepo: AuthRepository,
  tokenHash: string,
  expectedUserId: string,
  options: Required<AuthServiceOptions>,
): Promise<Result<AuthSessionResponse>> {
  const lookup = txRepo.findRefreshTokenByHashForUpdate ?? txRepo.findRefreshTokenByHash;
  const stored = await lookup(tokenHash);
  if (!stored || stored.userId !== expectedUserId) {
    return err({ code: 'UNAUTHORIZED', message: 'Refresh token is not recognized' });
  }
  const nowDate = options.now();
  const nowIso = nowDate.toISOString();
  if (stored.revokedAt !== null) {
    await txRepo.revokeAllUserRefreshTokens(stored.userId, nowIso);
    return err({ code: 'UNAUTHORIZED', message: 'Refresh token has already been rotated' });
  }
  if (Date.parse(stored.expiresAt) <= nowDate.getTime()) {
    return err({ code: 'UNAUTHORIZED', message: 'Refresh token has expired' });
  }
  const user = await txRepo.findUserById(stored.userId);
  if (!user) {
    return err({ code: 'UNAUTHORIZED', message: 'Account not found for refresh token' });
  }
  const { tokens, refreshRecordId } = await issueSessionTokens(txRepo, user, options);
  await txRepo.revokeRefreshToken(stored.id, nowIso, refreshRecordId);
  return ok(AuthSessionResponseSchema.parse({ user: toPublicUser(user), tokens }));
}

export function createInMemoryAuthRepository(): AuthRepository {
  const usersById = new Map<string, StoredUserRecord>();
  const userIdsByEmail = new Map<string, string>();
  const refreshTokensById = new Map<string, StoredRefreshTokenRecord>();
  const refreshTokenIdsByHash = new Map<string, string>();
  let txQueue: Promise<void> = Promise.resolve();

  const findRefreshByHash = async (tokenHash: string): Promise<StoredRefreshTokenRecord | null> => {
    const id = refreshTokenIdsByHash.get(tokenHash);
    return id ? (refreshTokensById.get(id) ?? null) : null;
  };

  const repo: AuthRepository = {
    findUserByEmail: async (email) => {
      const id = userIdsByEmail.get(email);
      return id ? (usersById.get(id) ?? null) : null;
    },
    findUserById: async (userId) => usersById.get(userId) ?? null,
    createUser: async (record) => {
      usersById.set(record.id, record);
      userIdsByEmail.set(record.email, record.id);
      return record;
    },
    saveRefreshToken: async (record) => {
      refreshTokensById.set(record.id, record);
      refreshTokenIdsByHash.set(record.tokenHash, record.id);
    },
    findRefreshTokenByHash: findRefreshByHash,
    findRefreshTokenByHashForUpdate: findRefreshByHash,
    revokeRefreshToken: async (tokenId, revokedAt, replacedBy) => {
      const existing = refreshTokensById.get(tokenId);
      if (existing) {
        refreshTokensById.set(tokenId, { ...existing, revokedAt, replacedBy });
      }
    },
    revokeAllUserRefreshTokens: async (userId, revokedAt) => {
      for (const [id, record] of refreshTokensById.entries()) {
        if (record.userId === userId && record.revokedAt === null) {
          refreshTokensById.set(id, { ...record, revokedAt });
        }
      }
    },
    runInTransaction: async <T>(fn: (txRepo: AuthRepository) => Promise<T>): Promise<T> => {
      const previous = txQueue;
      let releaseLock: () => void = () => undefined;
      txQueue = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previous;
      try {
        return await fn(repo);
      } finally {
        releaseLock();
      }
    },
  };

  return repo;
}

export function createAuthService(
  repo: AuthRepository,
  rawOptions: AuthServiceOptions,
): AuthService {
  const options: Required<AuthServiceOptions> = {
    accessSecret: rawOptions.accessSecret,
    refreshSecret: rawOptions.refreshSecret,
    accessTtlSeconds: rawOptions.accessTtlSeconds ?? DEFAULT_ACCESS_TTL_SECONDS,
    refreshTtlSeconds: rawOptions.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL_SECONDS,
    now: rawOptions.now ?? (() => new Date()),
  };

  return {
    signup: async (input): Promise<Result<AuthSessionResponse>> => {
      const parsed = SignupInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: firstValidationError(parsed.error, 'Invalid signup payload'),
        });
      }
      const passwordHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
      return executeInAuthTransaction(repo, async (txRepo) => {
        const existing = await txRepo.findUserByEmail(parsed.data.email);
        if (existing) {
          return err({ code: 'CONFLICT', message: 'An account with this email already exists' });
        }
        const created = await txRepo.createUser({
          id: randomUUID(),
          email: parsed.data.email,
          passwordHash,
          displayName: parsed.data.displayName,
          createdAt: options.now().toISOString(),
        });
        const { tokens } = await issueSessionTokens(txRepo, created, options);
        return ok(AuthSessionResponseSchema.parse({ user: toPublicUser(created), tokens }));
      });
    },

    login: async (input): Promise<Result<AuthSessionResponse>> => {
      const parsed = LoginInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: firstValidationError(parsed.error, 'Invalid login payload'),
        });
      }
      const user = await repo.findUserByEmail(parsed.data.email);
      if (!user) {
        return err({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }
      const passwordMatches = await argon2.verify(user.passwordHash, parsed.data.password);
      if (!passwordMatches) {
        return err({ code: 'UNAUTHORIZED', message: 'Invalid email or password' });
      }
      const { tokens } = await issueSessionTokens(repo, user, options);
      return ok(AuthSessionResponseSchema.parse({ user: toPublicUser(user), tokens }));
    },

    refresh: async (input): Promise<Result<AuthSessionResponse>> => {
      const parsed = RefreshSessionInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: firstValidationError(parsed.error, 'Invalid refresh token payload'),
        });
      }
      const claims = await verifyTypedJwt(
        parsed.data.refreshToken,
        options.refreshSecret,
        'refresh',
      );
      if (!claims) {
        return err({ code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' });
      }
      const tokenHash = sha256Hex(parsed.data.refreshToken);
      return executeInAuthTransaction(repo, (txRepo) =>
        rotateRefreshTokenAtomically(txRepo, tokenHash, claims.sub, options),
      );
    },

    logout: async (input): Promise<Result<{ readonly revoked: true }>> => {
      const parsed = LogoutInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: firstValidationError(parsed.error, 'Invalid logout payload'),
        });
      }
      const stored = await repo.findRefreshTokenByHash(sha256Hex(parsed.data.refreshToken));
      if (stored && stored.revokedAt === null) {
        await repo.revokeRefreshToken(stored.id, options.now().toISOString(), null);
      }
      return ok({ revoked: true });
    },

    getMe: async (accessToken): Promise<Result<UserPublic>> => {
      if (!accessToken || accessToken.trim().length === 0) {
        return err({ code: 'UNAUTHORIZED', message: 'Authentication token is required' });
      }
      const normalized = accessToken.startsWith('Bearer ')
        ? accessToken.slice('Bearer '.length).trim()
        : accessToken.trim();
      const claims = await verifyTypedJwt(normalized, options.accessSecret, 'access');
      if (!claims) {
        return err({ code: 'UNAUTHORIZED', message: 'Invalid or expired access token' });
      }
      const user = await repo.findUserById(claims.sub);
      if (!user) {
        return err({ code: 'UNAUTHORIZED', message: 'Authenticated user does not exist' });
      }
      return ok(toPublicUser(user));
    },
  };
}

export function createPostgresAuthService(
  pool: TransactionPool,
  options: AuthServiceOptions,
): AuthService {
  return createAuthService(createPostgresAuthRepository(pool), options);
}

export function createInMemoryAuthService(
  overrides: Partial<AuthServiceOptions> = {},
): AuthService {
  const repo = createInMemoryAuthRepository();
  return createAuthService(repo, {
    accessSecret: overrides.accessSecret ?? randomBytes(32),
    refreshSecret: overrides.refreshSecret ?? randomBytes(32),
    ...(overrides.accessTtlSeconds !== undefined
      ? { accessTtlSeconds: overrides.accessTtlSeconds }
      : {}),
    ...(overrides.refreshTtlSeconds !== undefined
      ? { refreshTtlSeconds: overrides.refreshTtlSeconds }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
}
