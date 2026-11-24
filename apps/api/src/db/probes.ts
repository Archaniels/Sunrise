export interface SqlQueryResult {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface SqlQueryable {
  readonly query: (sql: string) => Promise<SqlQueryResult>;
}

export function createPostgresProbe(
  db: SqlQueryable,
  now: () => number = () => Date.now(),
): () => Promise<number> {
  return async (): Promise<number> => {
    const startedAt = now();
    await db.query('SELECT 1');
    return Math.max(0, now() - startedAt);
  };
}

export function createPgvectorProbe(
  db: SqlQueryable,
  now: () => number = () => Date.now(),
): () => Promise<number> {
  return async (): Promise<number> => {
    const startedAt = now();
    const result = await db.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    if (result.rows.length === 0) {
      throw new Error('pgvector extension is not installed');
    }
    return Math.max(0, now() - startedAt);
  };
}
