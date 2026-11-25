import { stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { ok, type AppVersion, type WindowState } from '@sunrise/shared';
import { registerIpcHandlers } from './controllers/ipc-router.js';
import {
  registerPhase1IpcHandlers,
  type Phase1IpcRouterServices,
} from './controllers/phase1-ipc-router.js';
import { registerPhase2IpcHandlers } from './controllers/phase2-ipc-router.js';
import {
  createLocalCacheRepository,
  type LocalCacheRepository,
} from './db/local-cache-repository.js';
import {
  createFileBackedKeychainDeps,
  createKeychainSessionService,
} from './services/keychain-session-service.js';
import { createInMemoryLayoutStoreService } from './services/layout-store-service.js';
import { createNativeFsService } from './services/native-fs-service.js';
import { createPhase2DesktopService } from './services/phase2-desktop-service.js';
import { createDesktopServices } from './services/system-service.js';
import {
  applyCspToResponseHeaders,
  assertValidMainWindowCsp,
  createMainWindowCsp,
  createMainWindowOptions,
  getAllowedNavigationOrigins,
  isAllowedNavigationOrigin,
} from './window-config.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_URL = 'http://127.0.0.1:4000';
const HEALTH_FETCH_TIMEOUT_MS = 5000;

let cleanupRegisteredIpc: (() => void) | null = null;
let activeLocalCache: LocalCacheRepository | null = null;

function isDevelopmentRuntime(): boolean {
  return process.env['NODE_ENV'] === 'development';
}

function readRuntimeVersions(): AppVersion {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions['electron'] ?? '0.0.0',
    nodeVersion: process.versions['node'] ?? '0.0.0',
  };
}

function readWindowState(win: BrowserWindow | null): WindowState | undefined {
  if (!win || win.isDestroyed()) {
    return undefined;
  }
  const bounds = win.getBounds();
  return {
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  };
}

async function fetchApiHealth(apiBaseUrl: string): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}/health`, {
    signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
  });
  return response.json();
}

function createPhase1RuntimeServices(
  userDataDir: string,
  localCache: LocalCacheRepository,
): Phase1IpcRouterServices {
  const keychain = createKeychainSessionService(
    createFileBackedKeychainDeps(join(userDataDir, 'session.enc'), safeStorage),
  );
  const layoutStore = createInMemoryLayoutStoreService();
  const nativeFs = createNativeFsService({
    showOpenDialog: async (options) => {
      const properties: Array<'openFile' | 'multiSelections'> = options.multiple
        ? ['openFile', 'multiSelections']
        : ['openFile'];
      const filters =
        options.allowedExtensions && options.allowedExtensions.length > 0
          ? [{ name: 'Allowed Files', extensions: [...options.allowedExtensions] }]
          : undefined;
      const result = await dialog.showOpenDialog({
        properties,
        ...(filters ? { filters } : {}),
      });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
    showSaveDialog: async (suggestedName) => {
      const result = await dialog.showSaveDialog({ defaultPath: suggestedName });
      return {
        canceled: result.canceled,
        ...(result.filePath !== undefined ? { filePath: result.filePath } : {}),
      };
    },
    statFileSize: async (filePath) => (await stat(filePath)).size,
    writeFileBytes: async (filePath, data) => {
      await writeFile(filePath, data);
    },
  });

  return {
    saveSession: (session) => keychain.saveSession(session),
    loadSession: () => keychain.loadSession(),
    clearSession: () => keychain.clearSession(),
    getLayout: (input) => layoutStore.getLayout(input.projectId),
    saveLayout: (layout) => layoutStore.saveLayout(layout),
    pickFiles: (input) => nativeFs.pickFiles(input),
    saveFile: (input) => nativeFs.saveFile(input),
    putArtifact: async (record) => ok(localCache.putArtifact(record)),
    getArtifact: async (input) => ok(localCache.getArtifact(input.projectId, input.artifactId)),
    saveDraft: async (input) => ok(localCache.saveDraft(input)),
    listDrafts: async (input) => ok(localCache.listDrafts(input.projectId)),
    clearDraft: async (input) => {
      localCache.clearDraft(input.draftId);
      return ok({ completed: true });
    },
  };
}

export function createMainWindow(
  preloadPath: string,
  allowedOrigins: ReadonlySet<string> = getAllowedNavigationOrigins(isDevelopmentRuntime()),
  csp: string = createMainWindowCsp({
    isDev: isDevelopmentRuntime(),
    apiBaseUrl: process.env['SUNRISE_API_URL'] ?? DEFAULT_API_URL,
  }),
): BrowserWindow {
  const validatedCsp = assertValidMainWindowCsp(csp);
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath));

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: applyCspToResponseHeaders(details.responseHeaders, validatedCsp),
    });
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedNavigationOrigin(targetUrl, allowedOrigins)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return mainWindow;
}

export async function startDesktopApp(): Promise<void> {
  await app.whenReady();
  const isDev = isDevelopmentRuntime();
  const preloadPath = join(CURRENT_DIR, '../preload/index.cjs');
  const apiBaseUrl = process.env['SUNRISE_API_URL'] ?? DEFAULT_API_URL;
  const csp = createMainWindowCsp({ isDev, apiBaseUrl });
  const allowedOrigins = getAllowedNavigationOrigins(isDev);
  let mainWindow: BrowserWindow | null = createMainWindow(preloadPath, allowedOrigins, csp);

  const userDataDir = app.getPath('userData');
  activeLocalCache?.close();
  const localCache = createLocalCacheRepository(join(userDataDir, 'sunrise-cache.sqlite'));
  activeLocalCache = localCache;

  const phase0Services = createDesktopServices({
    getVersions: readRuntimeVersions,
    fetchHealth: () => fetchApiHealth(apiBaseUrl),
    getWindowState: () => readWindowState(mainWindow),
    openExternalUrl: (url: string) => shell.openExternal(url),
  });
  const phase1Services = createPhase1RuntimeServices(userDataDir, localCache);
  const phase2Services = createPhase2DesktopService({
    writeClipboardText: (text: string) => {
      clipboard.writeText(text);
    },
  });

  cleanupRegisteredIpc?.();
  const cleanupPhase0 = registerIpcHandlers(ipcMain, phase0Services);
  const cleanupPhase1 = registerPhase1IpcHandlers(ipcMain, phase1Services);
  const cleanupPhase2 = registerPhase2IpcHandlers(ipcMain, phase2Services);
  cleanupRegisteredIpc = (): void => {
    cleanupPhase0();
    cleanupPhase1();
    cleanupPhase2();
  };

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  app.on('will-quit', () => {
    cleanupRegisteredIpc?.();
    cleanupRegisteredIpc = null;
    activeLocalCache?.close();
    activeLocalCache = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
