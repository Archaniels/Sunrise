import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'SECURITY_POLICY_VIOLATION',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorDetailsValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(500),
  details: z.record(z.string(), ErrorDetailsValueSchema).optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;

export type Result<T, E = AppError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function createResultSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      value: valueSchema,
    }),
    z.object({
      ok: z.literal(false),
      error: AppErrorSchema,
    }),
  ]);
}
