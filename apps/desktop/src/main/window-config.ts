import {
  BrowserWindowWebPreferencesSchema,
  ELECTRON_SECURITY_BASELINE,
  validateCspHeader,
  type BrowserWindowWebPreferences,
} from '@sunrise/shared';
import type { BrowserWindowConstructorOptions } from 'electron';

export const PRODUCTION_MAIN_WINDOW_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export const MAIN_WINDOW_CSP = PRODUCTION_MAIN_WINDOW_CSP;

export const PRODUCTION_ALLOWED_NAVIGATION_ORIGINS: ReadonlySet<string> = new Set(['file://']);

export const DEV_ALLOWED_NAVIGATION_ORIGINS: ReadonlySet<string> = new Set([
  'file://',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

export const DEFAULT_ALLOWED_NAVIGATION_ORIGINS: ReadonlySet<string> =
  DEV_ALLOWED_NAVIGATION_ORIGINS;

export interface MainWindowCspOptions {
  readonly isDev?: boolean;
  readonly apiBaseUrl?: string;
}

function extractSafeOrigin(rawUrl: string | undefined, isDev: boolean): string | null {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'https:') {
      return parsed.origin;
    }
    if (
      isDev &&
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    ) {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function createMainWindowCsp(options: MainWindowCspOptions = {}): string {
  const isDev = options.isDev === true;
  const connectSources = ["'self'"];
  const apiOrigin = extractSafeOrigin(options.apiBaseUrl, isDev);
  if (apiOrigin !== null) {
    connectSources.push(apiOrigin);
  }
  if (isDev) {
    connectSources.push(
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'ws://127.0.0.1:5173',
      'ws://localhost:5173',
    );
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return assertValidMainWindowCsp(csp);
}

export function getAllowedNavigationOrigins(isDev: boolean): ReadonlySet<string> {
  return isDev ? DEV_ALLOWED_NAVIGATION_ORIGINS : PRODUCTION_ALLOWED_NAVIGATION_ORIGINS;
}

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
