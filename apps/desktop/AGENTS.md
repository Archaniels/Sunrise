# apps/desktop — Scoped Governance (Electron Wrapper)

## Mandate

`apps/desktop` is a hardened Electron desktop client wrapping Sunrise's cloud-first research workspace, providing native OS file dialogs, drag-and-drop streaming, OS keychain auth custody (`safeStorage`), native menus/shortcuts (`Ctrl+P`), and graceful offline read-only cache + local draft recovery.

## Strict Layer Boundaries

- `src/main/controllers/` — Thin `ipcMain.handle` adapters only. Validate every payload against `packages/shared` Zod schemas, call `src/main/services/`, and return typed `Result` objects. Zero business logic or direct SQLite queries.
- `src/main/services/` — Modular plain functions for OS dialogs, `safeStorage` token custody, local read-only cache, draft recovery, window state, and menus. Zero wrapper classes.
- `src/main/db/` — Local SQLite cache migrations and typed queries strictly for recently-opened read-only cache and offline draft recovery. Never primary project storage.
- `src/preload/` — Minimal `contextBridge.exposeInMainWorld("sunrise", api)` strictly mapped to `packages/shared` IPC contracts. NEVER expose raw `ipcRenderer` or Node primitives.
- `src/renderer/` — React UI, 3-column workspace state, artifact editors/viewers, and Cloud API/SSE client. Zero `electron`, `node:*`, or direct DB imports.

## Security Invariants

- Every `BrowserWindow` MUST set `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- Strict Content Security Policy (CSP) enforced on all windows.
- `shell:openExternal` MUST validate `https:` or `http:` protocol via `packages/shared` before opening.
