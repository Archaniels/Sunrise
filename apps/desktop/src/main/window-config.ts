import {
  BrowserWindowWebPreferencesSchema,
  ELECTRON_SECURITY_BASELINE,
  validateCspHeader,
  type BrowserWindowWebPreferences,
} from '@sunrise/shared';
import type { BrowserWindowConstructorOptions } from 'electron';

export const MAIN_WINDOW_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export const DEFAULT_ALLOWED_NAVIGATION_ORIGINS: ReadonlySet<string> = new Set([
  'file://',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

export function assertValidMainWindowCsp(csp: string = MAIN_WINDOW_CSP): string {
  const result = validateCspHeader(csp);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function createMainWindowPreferences(preloadPath: string): BrowserWindowWebPreferences {
  return BrowserWindowWebPreferencesSchema.parse({
    ...ELECTRON_SECURITY_BASELINE,
    preload: preloadPath,
  });
}

export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: createMainWindowPreferences(preloadPath),
  };
}

export function applyCspToResponseHeaders(
  responseHeaders: Readonly<Record<string, string[]>> | undefined,
  csp: string = MAIN_WINDOW_CSP,
): Record<string, string[]> {
  const validatedCsp = assertValidMainWindowCsp(csp);
  const sanitizedHeaders: Record<string, string[]> = {};
  if (responseHeaders) {
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.toLowerCase() !== 'content-security-policy') {
        sanitizedHeaders[key] = value;
      }
    }
  }
  sanitizedHeaders['Content-Security-Policy'] = [validatedCsp];
  return sanitizedHeaders;
}

export function isAllowedNavigationOrigin(
  targetUrl: string,
  allowedOrigins: ReadonlySet<string> = DEFAULT_ALLOWED_NAVIGATION_ORIGINS,
): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'file:') {
      return allowedOrigins.has('file://');
    }
    return allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}
