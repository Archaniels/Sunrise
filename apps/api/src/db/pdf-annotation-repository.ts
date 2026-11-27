import { PdfAnnotationSchema, type PdfAnnotation } from '@sunrise/shared';
import type {
  PdfAnnotationRepository,
  PdfAnnotationUpdatePatch,
} from '../services/pdf-annotation-service.js';
import type { TransactionPool } from './transaction.js';

interface QueryExecutor {
  readonly query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{
    readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
    readonly rowCount?: number | null;
  }>;
}

const SELECT_ANNOTATION_COLUMNS = `
  id, project_id, file_id, reference_id, page_number, selected_text,
  note, color, rects, created_by, created_at, updated_at
`;

const INSERT_ANNOTATION_SQL = `
  INSERT INTO pdf_annotations (
    id, project_id, file_id, reference_id, page_number, selected_text,
    note, color, rects, created_by, created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9::jsonb, $10, $11, $12
  )
`;

const UPDATE_ANNOTATION_SQL = `
  UPDATE pdf_annotations
  SET
    note = COALESCE($3, note),
    color = COALESCE($4, color),
    updated_at = $5
  WHERE project_id = $1 AND id = $2
  RETURNING ${SELECT_ANNOTATION_COLUMNS}
`;

function readTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : new Date().toISOString();
}

function mapAnnotationRow(
  row: Readonly<Record<string, unknown>> | undefined,
): PdfAnnotation | null {
  if (!row) {
    return null;
  }
  const parsed = PdfAnnotationSchema.safeParse({
    id: row['id'],
    projectId: row['project_id'],
    fileId: row['file_id'],
    referenceId: row['reference_id'] ?? null,
    pageNumber: row['page_number'],
    selectedText: row['selected_text'],
    note: row['note'] ?? '',
    color: row['color'],
    rects: row['rects'] ?? [],
    createdBy: row['created_by'],
    createdAt: readTimestamp(row['created_at']),
    updatedAt: readTimestamp(row['updated_at']),
  });
  return parsed.success ? parsed.data : null;
}

function createPoolExecutor(pool: TransactionPool): QueryExecutor {
  return {
    query: async (sql, params) => {
      const client = await pool.connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  };
}

export function createPostgresPdfAnnotationRepository(
  pool: TransactionPool,
): PdfAnnotationRepository {
  const executor = createPoolExecutor(pool);

  return {
    findById: async (annotationId: string): Promise<PdfAnnotation | null> => {
      const result = await executor.query(
        `SELECT ${SELECT_ANNOTATION_COLUMNS} FROM pdf_annotations WHERE id = $1 LIMIT 1`,
        [annotationId],
      );
      return mapAnnotationRow(result.rows[0]);
    },

    listByFile: async (projectId: string, fileId: string): Promise<PdfAnnotation[]> => {
      const result = await executor.query(
        `SELECT ${SELECT_ANNOTATION_COLUMNS} FROM pdf_annotations WHERE project_id = $1 AND file_id = $2 ORDER BY page_number ASC, created_at ASC`,
        [projectId, fileId],
      );
      const annotations: PdfAnnotation[] = [];
      for (const row of result.rows) {
        const mapped = mapAnnotationRow(row);
        if (mapped !== null) {
          annotations.push(mapped);
        }
      }
      return annotations;
    },

    insert: async (annotation: PdfAnnotation): Promise<PdfAnnotation> => {
      await executor.query(INSERT_ANNOTATION_SQL, [
        annotation.id,
        annotation.projectId,
        annotation.fileId,
        annotation.referenceId,
        annotation.pageNumber,
        annotation.selectedText,
        annotation.note,
        annotation.color,
        JSON.stringify(annotation.rects),
        annotation.createdBy,
        annotation.createdAt,
        annotation.updatedAt,
      ]);
      return annotation;
    },

    update: async (
      projectId: string,
      annotationId: string,
      patch: PdfAnnotationUpdatePatch,
    ): Promise<PdfAnnotation | null> => {
      const result = await executor.query(UPDATE_ANNOTATION_SQL, [
        projectId,
        annotationId,
        patch.note ?? null,
        patch.color ?? null,
        patch.updatedAt,
      ]);
      return mapAnnotationRow(result.rows[0]);
    },

    deleteById: async (projectId: string, annotationId: string): Promise<boolean> => {
      const result = await executor.query(
        'DELETE FROM pdf_annotations WHERE project_id = $1 AND id = $2',
        [projectId, annotationId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}
