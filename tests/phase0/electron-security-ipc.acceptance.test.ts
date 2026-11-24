import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserWindowWebPreferencesSchema,
  FORBIDDEN_PRELOAD_KEYS,
  IPC_CHANNELS,
  IpcChannelContracts,
  PRELOAD_EXPOSED_KEYS,
  validateCspHeader,
  type AppVersion,
  type HealthResponse,
  type Result,
  type WindowState,
} from '@sunrise/shared';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface WindowConfigModule {
  readonly MAIN_WINDOW_CSP: string;
  readonly createMainWindowPreferences: (preloadPath: string) => unknown;
}

interface PreloadModule {
  readonly createPreloadApi: (
    invoke: (channel: string, payload?: unknown) => Promise<unknown>,
  ) => Record<string, unknown>;
}

interface IpcRouterServices {
  readonly getAppVersion: () => Promise<Result<AppVersion>>;
  readonly checkHealth: () => Promise<Result<HealthResponse>>;
  readonly getWindowState: () => Promise<Result<WindowState>>;
  readonly openExternal: (
    url: string,
  ) => Promise<Result<{ readonly opened: true; readonly url: string }>>;
}

interface IpcRouterModule {
  readonly createIpcHandlers: (
    services: IpcRouterServices,
  ) => Record<string, (payload?: unknown) => Promise<unknown>>;
}

function isWindowConfigModule(value: unknown): value is WindowConfigModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'MAIN_WINDOW_CSP' in value &&
    typeof value.MAIN_WINDOW_CSP === 'string' &&
    'createMainWindowPreferences' in value &&
    typeof value.createMainWindowPreferences === 'function'
  );
}

function isPreloadModule(value: unknown): value is PreloadModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createPreloadApi' in value &&
    typeof value.createPreloadApi === 'function'
  );
}

function isIpcRouterModule(value: unknown): value is IpcRouterModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'createIpcHandlers' in value &&
    typeof value.createIpcHandlers === 'function'
  );
}

describe('Phase 0.3 Electron security baseline and typed IPC acceptance', () => {
  it('enforces hardened BrowserWindow webPreferences and strict CSP', async () => {
    const configPath = join(REPO_ROOT, 'apps/desktop/src/main/window-config.ts');
    expect(existsSync(configPath), 'Missing apps/desktop/src/main/window-config.ts').toBe(true);

    const loaded: unknown = await import(pathToFileURL(configPath).href);
    expect(isWindowConfigModule(loaded)).toBe(true);
    if (!isWindowConfigModule(loaded)) {
      return;
    }

    const prefs = loaded.createMainWindowPreferences('/app/preload/index.cjs');
    expect(BrowserWindowWebPreferencesSchema.safeParse(prefs).success).toBe(true);
    expect(validateCspHeader(loaded.MAIN_WINDOW_CSP).ok).toBe(true);
  });

  it('exposes only typed preload API namespaces and never exposes ipcRenderer or Node primitives', async () => {
    const preloadPath = join(REPO_ROOT, 'apps/desktop/src/preload/expose-api.ts');
    expect(existsSync(preloadPath), 'Missing apps/desktop/src/preload/expose-api.ts').toBe(true);

    const loaded: unknown = await import(pathToFileURL(preloadPath).href);
    expect(isPreloadModule(loaded)).toBe(true);
    if (!isPreloadModule(loaded)) {
      return;
    }

    const invoke = vi.fn(async () => ({ ok: true, value: {} }));
    const exposed = loaded.createPreloadApi(invoke);
    const exposedKeys = Object.keys(exposed).sort();

    expect(exposedKeys).toEqual([...PRELOAD_EXPOSED_KEYS].sort());
    for (const forbidden of FORBIDDEN_PRELOAD_KEYS) {
      expect(forbidden in exposed, `Forbidden key "${forbidden}" exposed on preload API`).toBe(
        false,
      );
    }
  });

  it('validates IPC payloads with Zod and blocks dangerous URLs before calling services', async () => {
    const routerPath = join(REPO_ROOT, 'apps/desktop/src/main/controllers/ipc-router.ts');
    expect(existsSync(routerPath), 'Missing apps/desktop/src/main/controllers/ipc-router.ts').toBe(
      true,
    );

    const loaded: unknown = await import(pathToFileURL(routerPath).href);
    expect(isIpcRouterModule(loaded)).toBe(true);
    if (!isIpcRouterModule(loaded)) {
      return;
    }

    const openExternal = vi.fn(async (url: string) => ({
      ok: true as const,
      value: { opened: true as const, url },
    }));

    const handlers = loaded.createIpcHandlers({
      getAppVersion: async () => ({
        ok: true,
        value: { appVersion: '0.1.0', electronVersion: '34.0.0', nodeVersion: '22.14.0' },
      }),
      checkHealth: async () => ({
        ok: true,
        value: {
          status: 'ok',
          service: 'sunrise-api',
          version: '0.1.0',
          timestamp: '2026-11-24T08:00:00.000Z',
          dependencies: {
            postgres: { status: 'up', latencyMs: 3 },
            pgvector: { status: 'up', latencyMs: 1 },
            s3: { status: 'up', latencyMs: 5 },
          },
        },
      }),
      getWindowState: async () => ({
        ok: true,
        value: { width: 1280, height: 800, isMaximized: false, isFullScreen: false },
      }),
      openExternal,
    });

    const openHandler = handlers[IPC_CHANNELS.SHELL_OPEN_EXTERNAL];
    expect(openHandler).toBeDefined();
    if (!openHandler) {
      return;
    }

    const validRes = await openHandler({ url: 'https://openalex.org' });
    expect(
      IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output.safeParse(validRes).success,
    ).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);

    const maliciousRes = await openHandler({ url: 'javascript:alert(1)' });
    const parsedMalicious =
      IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output.safeParse(maliciousRes);
    expect(parsedMalicious.success).toBe(true);
    if (parsedMalicious.success) {
      expect(parsedMalicious.data.ok).toBe(false);
      if (!parsedMalicious.data.ok) {
        expect(parsedMalicious.data.error.code).toBe('VALIDATION_ERROR');
      }
    }
    expect(openExternal).toHaveBeenCalledTimes(1);

    const fileProtocolRes = await openHandler({ url: 'file:///etc/passwd' });
    const parsedFile =
      IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output.safeParse(fileProtocolRes);
    expect(parsedFile.success).toBe(true);
    if (parsedFile.success) {
      expect(parsedFile.data.ok).toBe(false);
    }
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
