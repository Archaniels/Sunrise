import { z } from 'zod';

export const DependencyHealthSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative(),
  detail: z.string().min(1).max(300).optional(),
});

export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('sunrise-api'),
  version: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  dependencies: z.object({
    postgres: DependencyHealthSchema,
    pgvector: DependencyHealthSchema,
    s3: DependencyHealthSchema,
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function isSystemHealthy(health: HealthResponse): boolean {
  return (
    health.status === 'ok' &&
    health.dependencies.postgres.status === 'up' &&
    health.dependencies.pgvector.status === 'up' &&
    health.dependencies.s3.status === 'up'
  );
}
