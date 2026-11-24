import { HealthResponseSchema, isSystemHealthy } from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import { createPgvectorProbe, createPostgresProbe } from '../../apps/api/src/db/probes.js';
import { createApiServer } from '../../apps/api/src/server.js';
import { evaluateSystemHealth } from '../../apps/api/src/services/health-service.js';
import { createS3Probe } from '../../apps/api/src/services/s3-probe.js';

describe('Phase 0.2 Cloud API health server and probe adapters', () => {
  it('serves HTTP 200 on GET /health when all probes succeed', async () => {
    const app = createApiServer(
      {
        checkPostgres: async () => 3,
        checkPgvector: async () => 1,
        checkS3: async () => 6,
      },
      '0.1.0',
    );

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const parsed = HealthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isSystemHealthy(parsed.data)).toBe(true);
    }
    await app.close();
  });

  it('serves HTTP 503 on GET /health when postgres or pgvector fails', async () => {
    const app = createApiServer(
      {
        checkPostgres: async () => {
          throw new Error('ECONNREFUSED');
        },
        checkPgvector: async () => {
          throw 'non-error failure';
        },
        checkS3: async () => 4,
      },
      '0.1.0',
    );

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    const parsed = HealthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe('degraded');
      expect(parsed.data.dependencies.postgres.status).toBe('down');
      expect(parsed.data.dependencies.postgres.detail).toBe('ECONNREFUSED');
      expect(parsed.data.dependencies.pgvector.status).toBe('down');
      expect(parsed.data.dependencies.pgvector.detail).toBe('Dependency probe failed');
      expect(parsed.data.dependencies.s3.status).toBe('up');
    }
    await app.close();
  });

  it('normalizes negative and non-finite probe latencies', async () => {
    const outcome = await evaluateSystemHealth(
      {
        checkPostgres: async () => -5,
        checkPgvector: async () => Number.NaN,
        checkS3: async () => 2,
      },
      '0.1.0',
    );
    expect(outcome.statusCode).toBe(200);
    expect(outcome.body.dependencies.postgres.latencyMs).toBe(0);
    expect(outcome.body.dependencies.pgvector.latencyMs).toBe(0);
    expect(outcome.body.dependencies.s3.latencyMs).toBe(2);
  });

  it('verifies postgres, pgvector, and S3 probe adapters', async () => {
    let clock = 100;
    const now = (): number => {
      clock += 5;
      return clock;
    };

    const pgProbe = createPostgresProbe(
      { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) },
      now,
    );
    expect(await pgProbe()).toBe(5);

    const vecProbeOk = createPgvectorProbe(
      { query: vi.fn(async () => ({ rows: [{ extname: 'vector' }] })) },
      now,
    );
    expect(await vecProbeOk()).toBe(5);

    const vecProbeMissing = createPgvectorProbe({ query: vi.fn(async () => ({ rows: [] })) }, now);
    await expect(vecProbeMissing()).rejects.toThrow('pgvector extension is not installed');

    const send = vi.fn(async () => ({}));
    const s3Probe = createS3Probe({ send }, 'sunrise-artifacts', now);
    expect(await s3Probe()).toBe(5);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
