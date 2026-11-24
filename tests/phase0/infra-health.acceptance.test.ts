import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, isSystemHealthy } from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface HealthProbes {
  readonly checkPostgres: () => Promise<number>;
  readonly checkPgvector: () => Promise<number>;
  readonly checkS3: () => Promise<number>;
}

interface HealthCheckResult {
  readonly statusCode: number;
  readonly body: unknown;
}

interface HealthHandlerModule {
  readonly createHealthCheckHandler: (
    probes: HealthProbes,
    version: string,
  ) => () => Promise<HealthCheckResult>;
}

function isHealthHandlerModule(value: unknown): value is HealthHandlerModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createHealthCheckHandler' in value &&
    typeof value.createHealthCheckHandler === 'function'
  );
}

describe('Phase 0.2 infrastructure and Cloud API health acceptance', () => {
  it('defines docker-compose.yml with PostgreSQL pgvector and MinIO S3 healthchecks', () => {
    const composePath = join(REPO_ROOT, 'docker-compose.yml');
    expect(existsSync(composePath), 'Missing docker-compose.yml at repository root').toBe(true);

    const composeContent = readFileSync(composePath, 'utf8');
    expect(composeContent).toContain('pgvector');
    expect(composeContent).toContain('minio');
    expect(composeContent).toContain('healthcheck:');
  });

  it('provides an initial SQL migration enabling the pgvector extension', () => {
    const migrationsDir = join(REPO_ROOT, 'apps/api/src/db/migrations');
    expect(existsSync(migrationsDir), 'Missing apps/api/src/db/migrations directory').toBe(true);

    const sqlFiles = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => readFileSync(join(migrationsDir, entry.name), 'utf8'));

    expect(sqlFiles.length).toBeGreaterThan(0);
    const hasVectorExtension = sqlFiles.some((sql) =>
      /CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+vector/i.test(sql),
    );
    expect(hasVectorExtension).toBe(true);
  });

  it('returns HTTP 200 and healthy payload when Postgres, pgvector, and S3 probes succeed', async () => {
    const controllerPath = join(REPO_ROOT, 'apps/api/src/controllers/health-controller.ts');
    expect(
      existsSync(controllerPath),
      'Missing apps/api/src/controllers/health-controller.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(isHealthHandlerModule(loaded)).toBe(true);
    if (!isHealthHandlerModule(loaded)) {
      return;
    }

    const handler = loaded.createHealthCheckHandler(
      {
        checkPostgres: async () => 5,
        checkPgvector: async () => 2,
        checkS3: async () => 7,
      },
      '0.1.0',
    );
    const response = await handler();
    expect(response.statusCode).toBe(200);

    const parsed = HealthResponseSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isSystemHealthy(parsed.data)).toBe(true);
    }
  });

  it('returns HTTP 503 and degraded status when a backend dependency probe fails', async () => {
    const controllerPath = join(REPO_ROOT, 'apps/api/src/controllers/health-controller.ts');
    expect(
      existsSync(controllerPath),
      'Missing apps/api/src/controllers/health-controller.ts',
    ).toBe(true);

    const loaded: unknown = await import(pathToFileURL(controllerPath).href);
    expect(isHealthHandlerModule(loaded)).toBe(true);
    if (!isHealthHandlerModule(loaded)) {
      return;
    }

    const handler = loaded.createHealthCheckHandler(
      {
        checkPostgres: async () => 4,
        checkPgvector: async () => 2,
        checkS3: async () => {
          throw new Error('S3 connection refused');
        },
      },
      '0.1.0',
    );
    const response = await handler();
    expect(response.statusCode).toBe(503);

    const parsed = HealthResponseSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('degraded');
      expect(parsed.data.dependencies.s3.status).toBe('down');
      expect(isSystemHealthy(parsed.data)).toBe(false);
    }
  });
});
