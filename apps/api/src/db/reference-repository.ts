import { ReferenceSchema, type Reference } from '@sunrise/shared';
import type { ReferenceRepository } from '../services/reference-service.js';
import { withTransaction, type TransactionClient, type TransactionPool } from './transaction.js';

interface QueryExecutor {
  readonly query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{
    readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly rowCount?: number | null;
  }>;
}

function readTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : new Date().toISOString();
}

function nullableField(row: Readonly<Record<string, unknown>>, key: string): unknown {
  return row[key] ?? null;
}

function mapReferenceCoreFields(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: row['id'],
    projectId: row['project_id'],
    citeKey: row['cite_key'],
    title: row['title'],
    authors: row['authors'] ?? [],
    year: nullableField(row, 'year'),
    journal: nullableField(row, 'journal'),
    published: nullableField(row, 'published'),
    doi: nullableField(row, 'doi'),
    url: nullableField(row, 'url'),
  };
}

function mapReferenceDetailFields(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    abstract: nullableField(row, 'abstract'),
    volume: nullableField(row, 'volume'),
    issue: nullableField(row, 'issue'),
    pages: nullableField(row, 'pages'),
    citationCount: nullableField(row, 'citation_count'),
    pdfUrl: nullableField(row, 'pdf_url'),
    localPdfFileId: nullableField(row, 'local_pdf_file_id'),
    tags: row['tags'] ?? [],
    notes: row['notes'] ?? '',
    sourceProvider: row['source_provider'],
    createdAt: readTimestamp(row['created_at']),
    updatedAt: readTimestamp(row['updated_at']),
  };
}

function mapReferenceRow(row: Readonly<Record<string, unknown>> | undefined): Reference | null {
  if (!row) {
    return null;
  }
  const parsed = ReferenceSchema.safeParse({
    ...mapReferenceCoreFields(row),
    ...mapReferenceDetailFields(row),
  });
  return parsed.success ? parsed.data : null;
}

const SELECT_REFERENCE_COLUMNS = `
  id, project_id, cite_key, title, authors, year, journal, published, doi, url,
  abstract, volume, issue, pages, citation_count, pdf_url, local_pdf_file_id,
  tags, notes, source_provider, created_at, updated_at
`;

const UPSERT_REFERENCE_SQL = `
  INSERT INTO project_references (
    id, project_id, cite_key, title, authors, year, journal, published, doi, url,
    abstract, volume, issue, pages, citation_count, pdf_url, local_pdf_file_id,
    tags, notes, source_provider, created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15, $16, $17,
    $18::text[], $19, $20, $21, $22
  )
  ON CONFLICT (id) DO UPDATE SET
    cite_key = EXCLUDED.cite_key,
    title = EXCLUDED.title,
    authors = EXCLUDED.authors,
    year = EXCLUDED.year,
    journal = EXCLUDED.journal,
    published = EXCLUDED.published,
    doi = EXCLUDED.doi,
    url = EXCLUDED.url,
    abstract = EXCLUDED.abstract,
    volume = EXCLUDED.volume,
    issue = EXCLUDED.issue,
    pages = EXCLUDED.pages,
    citation_count = EXCLUDED.citation_count,
    pdf_url = EXCLUDED.pdf_url,
    local_pdf_file_id = EXCLUDED.local_pdf_file_id,
    tags = EXCLUDED.tags,
    notes = EXCLUDED.notes,
    source_provider = EXCLUDED.source_provider,
    updated_at = EXCLUDED.updated_at
`;

function buildReferenceRepositoryMethods(
  executor: QueryExecutor,
  runInTransaction: <T>(fn: (txRepo: ReferenceRepository) => Promise<T>) => Promise<T>,
): ReferenceRepository {
  return {
    findById: async (referenceId) => {
      const result = await executor.query(
        `SELECT ${SELECT_REFERENCE_COLUMNS} FROM project_references WHERE id = $1 LIMIT 1`,
        [referenceId],
      );
      return mapReferenceRow(result.rows[0]);
    },
    findByProjectAndDoi: async (projectId, doi) => {
      const result = await executor.query(
        `SELECT ${SELECT_REFERENCE_COLUMNS} FROM project_references WHERE project_id = $1 AND doi = $2 LIMIT 1`,
        [projectId, doi],
      );
      return mapReferenceRow(result.rows[0]);
    },
    listByProject: async (projectId) => {
      const result = await executor.query(
        `SELECT ${SELECT_REFERENCE_COLUMNS} FROM project_references WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId],
      );
      const references: Reference[] = [];
      for (const row of result.rows) {
        const mapped = mapReferenceRow(row);
        if (mapped !== null) {
          references.push(mapped);
        }
      }
      return references;
    },
    save: async (ref) => {
      await executor.query(UPSERT_REFERENCE_SQL, [
        ref.id,
        ref.projectId,
        ref.citeKey,
        ref.title,
        JSON.stringify(ref.authors),
        ref.year,
        ref.journal,
        ref.published,
        ref.doi,
        ref.url,
        ref.abstract,
        ref.volume,
        ref.issue,
        ref.pages,
        ref.citationCount,
        ref.pdfUrl,
        ref.localPdfFileId,
        ref.tags,
        ref.notes,
        ref.sourceProvider,
        ref.createdAt,
        ref.updatedAt,
      ]);
      return ref;
    },
    deleteById: async (projectId, referenceId) => {
      const result = await executor.query(
        'DELETE FROM project_references WHERE project_id = $1 AND id = $2',
        [projectId, referenceId],
      );
      return (result.rowCount ?? 0) > 0;
    },
    runInTransaction,
  };
}

function createClientScopedReferenceRepository(client: TransactionClient): ReferenceRepository {
  const nestedTx = async <T>(fn: (txRepo: ReferenceRepository) => Promise<T>): Promise<T> =>
    fn(createClientScopedReferenceRepository(client));
  return buildReferenceRepositoryMethods(client, nestedTx);
}

export function createPostgresReferenceRepository(pool: TransactionPool): ReferenceRepository {
  const runInTransaction = async <T>(fn: (txRepo: ReferenceRepository) => Promise<T>): Promise<T> =>
    withTransaction(pool, (client) => fn(createClientScopedReferenceRepository(client)));

  const executor: QueryExecutor = {
    query: async (sql, params) => {
      const client = await pool.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  };

  return buildReferenceRepositoryMethods(executor, runInTransaction);
}
