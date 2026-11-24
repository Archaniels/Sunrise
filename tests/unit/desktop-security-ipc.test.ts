import {
  IPC_CHANNELS,
  type AppVersion,
  type HealthResponse,
  type WindowState,
} from '@sunrise/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  registerIpcHandlers,
  type IpcMainRegistrar,
} from '../../apps/desktop/src/main/controllers/ipc-router.js';
import { createDesktopServices } from '../../apps/desktop/src/main/services/system-service.js';
import {
  applyCspToResponseHeaders,
  assertValidMainWindowCsp,
  createMainWindowOptions,
  isAllowedNavigationOrigin,
} from '../../apps/desktop/src/main/window-config.js';
import { exposeSunriseApi } from '../../apps/desktop/src/preload/expose-api.js';

const SAMPLE_VERSION: AppVersion = {
  appVersion: '0.1.0',
  electronVersion: '34.0.0',
  nodeVersion: '22.14.0',
};

const SAMPLE_WINDOW: WindowState = {
  width: 1280,
  height: 800,
  isMaximized: false,
  isFullScreen: false,
};

const SAMPLE_HEALTH: HealthResponse = {
  status: 'ok',
  service: 'sunrise-api',
  version: '0.1.0',
  timestamp: '2026-11-24T08:00:00.000Z',
  dependencies: {
    postgres: { status: 'up', latencyMs: 3 },
    pgvector: { status: 'up', latencyMs: 1 },
    s3: { status: 'up', latencyMs: 4 },
  },
};

describe('Phase 0.3 Electron main security, preload bridge, and desktop services', () => {
  it('enforces CSP header deduplication, navigation origin lock, and hardened preferences', () => {
    const options = createMainWindowOptions('/app/preload/index.cjs');
    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.webSecurity).toBe(true);

    expect(() => createMainWindowOptions('')).toThrow();
    expect(() => assertValidMainWindowCsp("default-src 'self' 'unsafe-eval'")).toThrow();

    const headers = applyCspToResponseHeaders({
      'X-Frame-Options': ['DENY'],
      'content-security-policy': ["default-src * 'unsafe-eval'"],
    });
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['Content-Security-Policy']?.[0]).toContain("default-src 'self'");
    expect(headers['X-Frame-Options']).toEqual(['DENY']);

    expect(isAllowedNavigationOrigin('file:///app/index.html')).toBe(true);
    expect(isAllowedNavigationOrigin('http://127.0.0.1:5173/workspace')).toBe(true);
    expect(isAllowedNavigationOrigin('https://evil.example.com/phish')).toBe(false);
    expect(isAllowedNavigationOrigin('javascript:alert(1)')).toBe(false);
  });

  it('exposes frozen preload API via contextBridge and validates IPC requests and responses', async () => {
    const exposedRecords: Record<string, unknown> = {};
    const bridge = {
      exposeInMainWorld: vi.fn((key: string, value: unknown) => {
        exposedRecords[key] = value;
      }),
    };

    const invoke = vi.fn(async (channel: string) => {
      if (channel === IPC_CHANNELS.APP_VERSION) {
        return { ok: true, value: SAMPLE_VERSION };
      }
      if (channel === IPC_CHANNELS.APP_HEALTH) {
        return { invalid: true };
      }
      return { ok: true, value: { opened: true, url: 'https://openalex.org' } };
    });

    const api = exposeSunriseApi(bridge, invoke);
    expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('sunrise', api);
    expect(Object.isFrozen(api)).toBe(true);

    const versionRes = await api.app.getVersion();
    expect(versionRes.ok).toBe(true);

    const malformedHealth = await api.app.checkHealth();
    expect(malformedHealth.ok).toBe(false);
    if (!malformedHealth.ok) {
      expect(malformedHealth.error.code).toBe('INTERNAL_ERROR');
    }

    const blockedExternal = await api.shell.openExternal({ url: 'javascript:alert(1)' });
    expect(blockedExternal.ok).toBe(false);
    if (!blockedExternal.ok) {
      expect(blockedExternal.error.code).toBe('VALIDATION_ERROR');
    }
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('registers and cleans up all IPC channels and handles desktop service failures', async () => {
    const listeners = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
    const registrar: IpcMainRegistrar = {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
      removeHandler: (channel) => {
        listeners.delete(channel);
      },
    };

    const openExternalUrl = vi.fn(async () => undefined);
    const services = createDesktopServices({
      getVersions: () => SAMPLE_VERSION,
      fetchHealth: async () => SAMPLE_HEALTH,
      getWindowState: () => SAMPLE_WINDOW,
      openExternalUrl,
    });

    const cleanup = registerIpcHandlers(registrar, services);
    expect(listeners.size).toBe(4);

    const versionListener = listeners.get(IPC_CHANNELS.APP_VERSION);
    expect(versionListener).toBeDefined();
    if (versionListener) {
      const validVersion = await versionListener({}, undefined);
      expect(validVersion).toEqual({ ok: true, value: SAMPLE_VERSION });

      const unexpectedPayload = await versionListener({}, { extra: true });
      expect(unexpectedPayload).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR' },
      });
    }

    const openListener = listeners.get(IPC_CHANNELS.SHELL_OPEN_EXTERNAL);
    expect(openListener).toBeDefined();
    if (openListener) {
      const opened = await openListener({}, { url: 'https://doi.org/10.1000/test' });
      expect(opened).toEqual({
        ok: true,
        value: { opened: true, url: 'https://doi.org/10.1000/test' },
      });
      expect(openExternalUrl).toHaveBeenCalledTimes(1);
    }

    cleanup();
    expect(listeners.size).toBe(0);

    const failingServices = createDesktopServices({
      getVersions: () => SAMPLE_VERSION,
      fetchHealth: async () => {
        throw new Error('network down');
      },
      getWindowState: () => undefined,
      openExternalUrl,
    });

    const unavailable = await failingServices.checkHealth();
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    }

    const missingWindow = await failingServices.getWindowState();
    expect(missingWindow.ok).toBe(false);
    if (!missingWindow.ok) {
      expect(missingWindow.error.code).toBe('NOT_FOUND');
    }

    const defenseInDepthBlocked = await failingServices.openExternal('file:///etc/passwd');
    expect(defenseInDepthBlocked.ok).toBe(false);
    if (!defenseInDepthBlocked.ok) {
      expect(defenseInDepthBlocked.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
