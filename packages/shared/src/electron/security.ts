import { z } from 'zod';
import { err, ok, type Result } from '../result.js';

export const ELECTRON_SECURITY_BASELINE = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;

export const BrowserWindowWebPreferencesSchema = z.object({
  contextIsolation: z.literal(true),
  nodeIntegration: z.literal(false),
  sandbox: z.literal(true),
  webSecurity: z.literal(true),
  allowRunningInsecureContent: z.literal(false),
  preload: z.string().min(1),
});

export type BrowserWindowWebPreferences = z.infer<typeof BrowserWindowWebPreferencesSchema>;

export const FORBIDDEN_CSP_TOKENS = ['unsafe-eval', 'unsafe-inline', 'http:', '*'] as const;

export const REQUIRED_CSP_DIRECTIVES = [
  "default-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
] as const;

function parseCspDirectives(csp: string): string[] {
  return csp
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function validateCspHeader(csp: string): Result<string> {
  const directives = parseCspDirectives(csp);
  for (const required of REQUIRED_CSP_DIRECTIVES) {
    if (!directives.includes(required)) {
      return err({
        code: 'SECURITY_POLICY_VIOLATION',
        message: `Missing required CSP directive: ${required}`,
      });
    }
  }
  const lowered = csp.toLowerCase();
  if (lowered.includes('unsafe-eval')) {
    return err({
      code: 'SECURITY_POLICY_VIOLATION',
      message: 'CSP must not allow unsafe-eval',
    });
  }
  return ok(csp);
}
