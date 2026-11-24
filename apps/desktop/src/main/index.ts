import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { AppVersion, WindowState } from '@sunrise/shared';
import { registerIpcHandlers } from './controllers/ipc-router.js';
import { createDesktopServices } from './services/system-service.js';
import {
  applyCspToResponseHeaders,
  assertValidMainWindowCsp,
  createMainWindowOptions,
  DEFAULT_ALLOWED_NAVIGATION_ORIGINS,
  isAllowedNavigationOrigin,
} from './window-config.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_URL = 'http://127.0.0.1:4000';
const HEALTH_FETCH_TIMEOUT_MS = 5000;

let cleanupRegisteredIpc: (() => void) | null = null;

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

export function createMainWindow(
  preloadPath: string,
  allowedOrigins: ReadonlySet<string> = DEFAULT_ALLOWED_NAVIGATION_ORIGINS,
): BrowserWindow {
  assertValidMainWindowCsp();
  const mainWindow = new BrowserWindow(createMainWindowOptions(preloadPath));

  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: applyCspToResponseHeaders(details.responseHeaders),
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
  const preloadPath = join(CURRENT_DIR, '../preload/index.cjs');
  const apiBaseUrl = process.env['SUNRISE_API_URL'] ?? DEFAULT_API_URL;
  let mainWindow: BrowserWindow | null = createMainWindow(preloadPath);

  const services = createDesktopServices({
    getVersions: readRuntimeVersions,
    fetchHealth: () => fetchApiHealth(apiBaseUrl),
    getWindowState: () => readWindowState(mainWindow),
    openExternalUrl: (url: string) => shell.openExternal(url),
  });

  cleanupRegisteredIpc?.();
  cleanupRegisteredIpc = registerIpcHandlers(ipcMain, services);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  app.on('will-quit', () => {
    cleanupRegisteredIpc?.();
    cleanupRegisteredIpc = null;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
