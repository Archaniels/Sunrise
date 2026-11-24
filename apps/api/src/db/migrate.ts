import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationQueryable {
  readonly query: (
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<{ readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>> }>;
}

export interface MigrationRunSummary {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

const ENSURE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _sunrise_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function listSqlMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function applySingleMigration(
  db: MigrationQueryable,
  filename: string,
  sql: string,
): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query(sql);
    await db.query(
      'INSERT INTO _sunrise_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [filename],
    );
    await db.query('COMMIT');
  } catch (error: unknown) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function runSqlMigrations(
  db: MigrationQueryable,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<MigrationRunSummary> {
  await db.query(ENSURE_MIGRATIONS_TABLE_SQL);
  const existing = await db.query('SELECT filename FROM _sunrise_migrations');
  const alreadyApplied = new Set<string>();
  for (const row of existing.rows) {
    const name = row['filename'];
    if (typeof name === 'string') {
      alreadyApplied.add(name);
    }
  }

  const files = listSqlMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    if (alreadyApplied.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    await applySingleMigration(db, filename, sql);
    applied.push(filename);
  }

  return { applied, skipped };
}
