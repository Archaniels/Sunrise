import { withTransaction, type TransactionClient, type TransactionPool } from './transaction.js';
import type {
  AuthRepository,
  StoredRefreshTokenRecord,
  StoredUserRecord,
} from '../services/auth-service.js';

interface QueryExecutor {
  readonly query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> }>;
}

function readStringField(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : '';
}

function readNullableStringField(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : null;
}

function mapUserRow(row: Readonly<Record<string, unknown>> | undefined): StoredUserRecord | null {
  if (!row) {
    return null;
  }
  const id = readStringField(row, 'id');
  if (id.length === 0) {
    return null;
  }
  return {
    id,
    email: readStringField(row, 'email'),
    passwordHash: readStringField(row, 'password_hash'),
    displayName: readStringField(row, 'display_name'),
    createdAt: readStringField(row, 'created_at'),
  };
}

function mapRefreshTokenRow(
  row: Readonly<Record<string, unknown>> | undefined,
): StoredRefreshTokenRecord | null {
  if (!row) {
    return null;
  }
  const id = readStringField(row, 'id');
  if (id.length === 0) {
    return null;
  }
  return {
    id,
    userId: readStringField(row, 'user_id'),
    tokenHash: readStringField(row, 'token_hash'),
    expiresAt: readStringField(row, 'expires_at'),
    revokedAt: readNullableStringField(row, 'revoked_at'),
    replacedBy: readNullableStringField(row, 'replaced_by'),
    createdAt: readStringField(row, 'created_at'),
  };
}

function buildAuthRepositoryMethods(
  executor: QueryExecutor,
  runInTransaction: <T>(fn: (txRepo: AuthRepository) => Promise<T>) => Promise<T>,
): AuthRepository {
  return {
    findUserByEmail: async (email) => {
      const result = await executor.query(
        'SELECT id, email, password_hash, display_name, created_at FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [email],
      );
      return mapUserRow(result.rows[0]);
    },
    findUserById: async (userId) => {
      const result = await executor.query(
        'SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1 LIMIT 1',
        [userId],
      );
      return mapUserRow(result.rows[0]);
    },
    createUser: async (record) => {
      await executor.query(
        'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ($1, $2, $3, $4, $5)',
        [record.id, record.email, record.passwordHash, record.displayName, record.createdAt],
      );
      return record;
    },
    saveRefreshToken: async (record) => {
      await executor.query(
        'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [
          record.id,
          record.userId,
          record.tokenHash,
          record.expiresAt,
          record.revokedAt,
          record.replacedBy,
          record.createdAt,
        ],
      );
    },
    findRefreshTokenByHash: async (tokenHash) => {
      const result = await executor.query(
        'SELECT id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at FROM refresh_tokens WHERE token_hash = $1 LIMIT 1',
        [tokenHash],
      );
      return mapRefreshTokenRow(result.rows[0]);
    },
    findRefreshTokenByHashForUpdate: async (tokenHash) => {
      const result = await executor.query(
        'SELECT id, user_id, token_hash, expires_at, revoked_at, replaced_by, created_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
        [tokenHash],
      );
      return mapRefreshTokenRow(result.rows[0]);
    },
    revokeRefreshToken: async (tokenId, revokedAt, replacedBy) => {
      await executor.query(
        'UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3 WHERE id = $1',
        [tokenId, revokedAt, replacedBy],
      );
    },
    revokeAllUserRefreshTokens: async (userId, revokedAt) => {
      await executor.query(
        'UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
        [userId, revokedAt],
      );
    },
    runInTransaction,
  };
}

function createClientScopedAuthRepository(client: TransactionClient): AuthRepository {
  const nestedTx = async <T>(fn: (txRepo: AuthRepository) => Promise<T>): Promise<T> =>
    fn(createClientScopedAuthRepository(client));
  return buildAuthRepositoryMethods(client, nestedTx);
}

export function createPostgresAuthRepository(pool: TransactionPool): AuthRepository {
  const runInTransaction = async <T>(fn: (txRepo: AuthRepository) => Promise<T>): Promise<T> =>
    withTransaction(pool, (client) => fn(createClientScopedAuthRepository(client)));

  const poolQueryExecutor: QueryExecutor = {
    query: async (sql, params) => {
      const client = await pool.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  };

  return buildAuthRepositoryMethods(poolQueryExecutor, runInTransaction);
}
