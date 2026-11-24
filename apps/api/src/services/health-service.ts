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

const SENSITIVE_PATTERN =
  /(?:postgres(?:ql)?|https?|s3):\/\/\S+|(?:password|secret|token|apikey|api_key|authorization)\s*[:=]\s*\S+/i;

const SAFE_DRIVER_CODE_PATTERN = /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EHOSTUNREACH)\b/;

function normalizeLatency(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return 0;
  }
  return latencyMs;
}

export function sanitizeProbeFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Dependency probe failed';
  }
  const raw = error.message.trim();
  if (raw.length === 0) {
    return 'Dependency probe failed';
  }
  const codeMatch = SAFE_DRIVER_CODE_PATTERN.exec(raw);
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1];
  }
  if (raw.toLowerCase().includes('pgvector extension')) {
    return 'pgvector extension unavailable';
  }
  if (SENSITIVE_PATTERN.test(raw)) {
    return 'Dependency connection error (details redacted)';
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
      detail: sanitizeProbeFailureDetail(error),
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
