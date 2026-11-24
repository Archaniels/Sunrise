import {
  HealthResponseSchema,
  isSystemHealthy,
  type DependencyHealth,
  type HealthResponse,
} from '@sunrise/shared';

export interface HealthProbes {
  readonly checkPostgres: () => Promise<number>;
  readonly checkPgvector: () => Promise<number>;
  readonly checkS3: () => Promise<number>;
}

export interface HealthEvaluation {
  readonly statusCode: 200 | 503;
  readonly body: HealthResponse;
}

const MAX_DETAIL_LENGTH = 300;

function normalizeLatency(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return 0;
  }
  return latencyMs;
}

function extractFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    const trimmed = error.message.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, MAX_DETAIL_LENGTH);
    }
  }
  return 'Dependency probe failed';
}

async function runDependencyProbe(probe: () => Promise<number>): Promise<DependencyHealth> {
  try {
    const latencyMs = await probe();
    return {
      status: 'up',
      latencyMs: normalizeLatency(latencyMs),
    };
  } catch (error: unknown) {
    return {
      status: 'down',
      latencyMs: 0,
      detail: extractFailureDetail(error),
    };
  }
}

export async function evaluateSystemHealth(
  probes: HealthProbes,
  version: string,
  now: () => Date = () => new Date(),
): Promise<HealthEvaluation> {
  const [postgres, pgvector, s3] = await Promise.all([
    runDependencyProbe(probes.checkPostgres),
    runDependencyProbe(probes.checkPgvector),
    runDependencyProbe(probes.checkS3),
  ]);

  const allUp = postgres.status === 'up' && pgvector.status === 'up' && s3.status === 'up';
  const body = HealthResponseSchema.parse({
    status: allUp ? 'ok' : 'degraded',
    service: 'sunrise-api',
    version,
    timestamp: now().toISOString(),
    dependencies: {
      postgres,
      pgvector,
      s3,
    },
  });

  return {
    statusCode: isSystemHealthy(body) ? 200 : 503,
    body,
  };
}
