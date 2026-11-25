export interface TransactionQueryResult {
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly rowCount?: number | null;
}

export interface TransactionClient {
  readonly query: (sql: string, params?: unknown[]) => Promise<TransactionQueryResult>;
  readonly release: (err?: Error | boolean) => void;
}

export interface TransactionPool {
  readonly connect: () => Promise<TransactionClient>;
}

export async function withTransaction<T>(
  pool: TransactionPool,
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let rollbackFailed = false;
  try {
    await client.query('BEGIN');
    const outcome = await fn(client);
    await client.query('COMMIT');
    return outcome;
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      rollbackFailed = true;
    }
    throw error;
  } finally {
    client.release(rollbackFailed);
  }
}
