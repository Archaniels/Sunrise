import {
  AppVersionSchema,
  err,
  ExternalUrlSchema,
  HealthResponseSchema,
  ok,
  WindowStateSchema,
  type AppVersion,
  type HealthResponse,
  type OpenExternalOutput,
  type Result,
  type WindowState,
} from '@sunrise/shared';

export interface IpcRouterServices {
  readonly getAppVersion: () => Promise<Result<AppVersion>>;
  readonly checkHealth: () => Promise<Result<HealthResponse>>;
  readonly getWindowState: () => Promise<Result<WindowState>>;
  readonly openExternal: (url: string) => Promise<Result<OpenExternalOutput>>;
}

export interface DesktopRuntimeDependencies {
  readonly getVersions: () => AppVersion;
  readonly fetchHealth: () => Promise<unknown>;
  readonly getWindowState: () => WindowState | undefined;
  readonly openExternalUrl: (url: string) => Promise<void>;
}

function formatServiceError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 500);
  }
  return fallback;
}

export function createDesktopServices(deps: DesktopRuntimeDependencies): IpcRouterServices {
  return {
    getAppVersion: async (): Promise<Result<AppVersion>> => {
      const parsed = AppVersionSchema.safeParse(deps.getVersions());
      if (!parsed.success) {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Unable to resolve application runtime versions',
        });
      }
      return ok(parsed.data);
    },

    checkHealth: async (): Promise<Result<HealthResponse>> => {
      try {
        const raw = await deps.fetchHealth();
        const parsed = HealthResponseSchema.safeParse(raw);
        if (!parsed.success) {
          return err({
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'Cloud API health payload did not match contract',
          });
        }
        return ok(parsed.data);
      } catch (error: unknown) {
        return err({
          code: 'DEPENDENCY_UNAVAILABLE',
          message: formatServiceError(error, 'Cloud API health endpoint unreachable'),
        });
      }
    },

    getWindowState: async (): Promise<Result<WindowState>> => {
      const current = deps.getWindowState();
      if (!current) {
        return err({
          code: 'NOT_FOUND',
          message: 'Active application window is unavailable',
        });
      }
      const parsed = WindowStateSchema.safeParse(current);
      if (!parsed.success) {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Active window dimensions are outside valid bounds',
        });
      }
      return ok(parsed.data);
    },

    openExternal: async (url: string): Promise<Result<OpenExternalOutput>> => {
      const parsedUrl = ExternalUrlSchema.safeParse(url);
      if (!parsedUrl.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsedUrl.error.issues[0]?.message ?? 'External URL is not allowed',
        });
      }
      try {
        await deps.openExternalUrl(parsedUrl.data);
        return ok({ opened: true, url: parsedUrl.data });
      } catch (error: unknown) {
        return err({
          code: 'INTERNAL_ERROR',
          message: formatServiceError(error, 'Failed to open external URL'),
        });
      }
    },
  };
}
