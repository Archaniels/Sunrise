import { describe, expect, it } from 'vitest';
import {
  AppVersionSchema,
  BrowserWindowWebPreferencesSchema,
  ELECTRON_SECURITY_BASELINE,
  ExternalUrlSchema,
  HealthResponseSchema,
  IPC_CHANNELS,
  IpcChannelContracts,
  isSystemHealthy,
  OpenExternalInputSchema,
  PhaseTrackerSchema,
  validateCspHeader,
  WindowStateSchema,
  createResultSchema,
  err,
  ok,
} from '@sunrise/shared';

describe('Phase 0 shared contracts', () => {
  describe('Result & AppError contracts', () => {
    it('validates ok and err discriminated unions', () => {
      const schema = createResultSchema(AppVersionSchema);
      const validOk = schema.safeParse(
        ok({ appVersion: '0.1.0', electronVersion: '34.0.0', nodeVersion: '22.14.0' }),
      );
      expect(validOk.success).toBe(true);

      const validErr = schema.safeParse(
        err({
          code: 'VALIDATION_ERROR',
          message: 'Invalid payload',
          details: { field: 'url' },
        }),
      );
      expect(validErr.success).toBe(true);
    });

    it('rejects unknown error codes and empty error messages', () => {
      const schema = createResultSchema(AppVersionSchema);
      const invalidCode = schema.safeParse({
        ok: false,
        error: { code: 'UNKNOWN_CODE', message: 'Boom' },
      });
      expect(invalidCode.success).toBe(false);

      const emptyMessage = schema.safeParse({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '' },
      });
      expect(emptyMessage.success).toBe(false);
    });
  });

  describe('Cloud API health contract', () => {
    it('accepts healthy response and reports system healthy', () => {
      const parsed = HealthResponseSchema.safeParse({
        status: 'ok',
        service: 'sunrise-api',
        version: '0.1.0',
        timestamp: '2026-11-24T08:00:00.000Z',
        dependencies: {
          postgres: { status: 'up', latencyMs: 4 },
          pgvector: { status: 'up', latencyMs: 2 },
          s3: { status: 'up', latencyMs: 8 },
        },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(isSystemHealthy(parsed.data)).toBe(true);
      }
    });

    it('reports degraded system when any dependency is down', () => {
      const parsed = HealthResponseSchema.safeParse({
        status: 'degraded',
        service: 'sunrise-api',
        version: '0.1.0',
        timestamp: '2026-11-24T08:00:00.000Z',
        dependencies: {
          postgres: { status: 'up', latencyMs: 4 },
          pgvector: { status: 'down', latencyMs: 0, detail: 'extension vector not installed' },
          s3: { status: 'up', latencyMs: 9 },
        },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(isSystemHealthy(parsed.data)).toBe(false);
      }
    });

    it('rejects negative latency or non-ISO timestamps', () => {
      const parsed = HealthResponseSchema.safeParse({
        status: 'ok',
        service: 'sunrise-api',
        version: '0.1.0',
        timestamp: 'not-a-timestamp',
        dependencies: {
          postgres: { status: 'up', latencyMs: -1 },
          pgvector: { status: 'up', latencyMs: 1 },
          s3: { status: 'up', latencyMs: 1 },
        },
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('Electron security & CSP contracts', () => {
    it('accepts hardened BrowserWindow webPreferences baseline', () => {
      const parsed = BrowserWindowWebPreferencesSchema.safeParse({
        ...ELECTRON_SECURITY_BASELINE,
        preload: '/app/preload/index.cjs',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects any weakened security flag', () => {
      const weakenedNode = BrowserWindowWebPreferencesSchema.safeParse({
        ...ELECTRON_SECURITY_BASELINE,
        nodeIntegration: true,
        preload: '/app/preload/index.cjs',
      });
      expect(weakenedNode.success).toBe(false);

      const weakenedSandbox = BrowserWindowWebPreferencesSchema.safeParse({
        ...ELECTRON_SECURITY_BASELINE,
        sandbox: false,
        preload: '/app/preload/index.cjs',
      });
      expect(weakenedSandbox.success).toBe(false);
    });

    it('accepts strict CSP and rejects unsafe-eval or missing directives', () => {
      const strictCsp =
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
      expect(validateCspHeader(strictCsp).ok).toBe(true);

      const unsafeEvalCsp =
        "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
      expect(validateCspHeader(unsafeEvalCsp).ok).toBe(false);

      const missingDirective = "default-src 'self'";
      expect(validateCspHeader(missingDirective).ok).toBe(false);
    });
  });

  describe('IPC channel & external URL validation contracts', () => {
    it('accepts valid https and http academic URLs', () => {
      expect(ExternalUrlSchema.safeParse('https://openalex.org/works/W12345').success).toBe(true);
      expect(ExternalUrlSchema.safeParse('https://doi.org/10.1000/xyz123').success).toBe(true);
      expect(ExternalUrlSchema.safeParse('http://localhost:4000/health').success).toBe(true);
    });

    it('rejects dangerous URL schemes and boundary overflow inputs', () => {
      expect(ExternalUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
      expect(ExternalUrlSchema.safeParse('file:///C:/Windows/System32/cmd.exe').success).toBe(
        false,
      );
      expect(ExternalUrlSchema.safeParse('data:text/html,<script>alert(1)</script>').success).toBe(
        false,
      );
      expect(ExternalUrlSchema.safeParse('').success).toBe(false);
      expect(ExternalUrlSchema.safeParse(`https://example.org/${'a'.repeat(2100)}`).success).toBe(
        false,
      );
    });

    it('enforces WindowState bounds and OpenExternal input contracts', () => {
      expect(
        WindowStateSchema.safeParse({
          width: 1440,
          height: 900,
          isMaximized: false,
          isFullScreen: false,
        }).success,
      ).toBe(true);
      expect(
        WindowStateSchema.safeParse({
          width: 100,
          height: 100,
          isMaximized: false,
          isFullScreen: false,
        }).success,
      ).toBe(false);
      expect(
        OpenExternalInputSchema.safeParse({ url: 'https://pubmed.ncbi.nlm.nih.gov/' }).success,
      ).toBe(true);
      expect(
        IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].input.safeParse({
          url: 'file:///etc/passwd',
        }).success,
      ).toBe(false);
    });

    it('rejects malformed phase tracker payloads', () => {
      expect(
        PhaseTrackerSchema.safeParse({
          project: 'other',
          schemaVersion: '1.0.0',
          updatedAt: '2026-11-24T14:52:00+07:00',
          activePhase: 0,
          phases: [],
        }).success,
      ).toBe(false);
    });
  });
});
