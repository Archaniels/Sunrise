import {
  err,
  IPC_CHANNELS,
  IpcChannelContracts,
  type AppVersion,
  type HealthResponse,
  type OpenExternalInput,
  type OpenExternalOutput,
  type Result,
  type SunrisePreloadApi,
  type WindowState,
} from '@sunrise/shared';
import type { z } from 'zod';

export type PreloadInvoke = (channel: string, payload?: unknown) => Promise<unknown>;

export interface ContextBridgeLike {
  readonly exposeInMainWorld: (apiKey: string, api: SunrisePreloadApi) => void;
}

function parseIpcResult<T>(schema: z.ZodType<Result<T>>, raw: unknown, channel: string): Result<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return err({
      code: 'INTERNAL_ERROR',
      message: `Invalid IPC response for channel ${channel}`,
    });
  }
  return parsed.data;
}

async function invokeTypedChannel<T>(
  invoke: PreloadInvoke,
  channel: string,
  outputSchema: z.ZodType<Result<T>>,
  payload?: unknown,
): Promise<Result<T>> {
  try {
    const raw = payload === undefined ? await invoke(channel) : await invoke(channel, payload);
    return parseIpcResult(outputSchema, raw, channel);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'IPC invocation failed';
    return err({
      code: 'INTERNAL_ERROR',
      message: message.length > 0 ? message.slice(0, 500) : 'IPC invocation failed',
    });
  }
}

export function createPreloadApi(invoke: PreloadInvoke): SunrisePreloadApi {
  const appNamespace = Object.freeze({
    getVersion: async (): Promise<Result<AppVersion>> =>
      invokeTypedChannel(
        invoke,
        IPC_CHANNELS.APP_VERSION,
        IpcChannelContracts[IPC_CHANNELS.APP_VERSION].output,
      ),
    checkHealth: async (): Promise<Result<HealthResponse>> =>
      invokeTypedChannel(
        invoke,
        IPC_CHANNELS.APP_HEALTH,
        IpcChannelContracts[IPC_CHANNELS.APP_HEALTH].output,
      ),
  });

  const windowNamespace = Object.freeze({
    getState: async (): Promise<Result<WindowState>> =>
      invokeTypedChannel(
        invoke,
        IPC_CHANNELS.WINDOW_GET_STATE,
        IpcChannelContracts[IPC_CHANNELS.WINDOW_GET_STATE].output,
      ),
  });

  const shellNamespace = Object.freeze({
    openExternal: async (input: OpenExternalInput): Promise<Result<OpenExternalOutput>> => {
      const parsedInput =
        IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].input.safeParse(input);
      if (!parsedInput.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsedInput.error.issues[0]?.message ?? 'Invalid external URL payload',
        });
      }
      return invokeTypedChannel(
        invoke,
        IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
        IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output,
        parsedInput.data,
      );
    },
  });

  return Object.freeze({
    app: appNamespace,
    window: windowNamespace,
    shell: shellNamespace,
  });
}

export function exposeSunriseApi(
  bridge: ContextBridgeLike,
  invoke: PreloadInvoke,
): SunrisePreloadApi {
  const api = createPreloadApi(invoke);
  bridge.exposeInMainWorld('sunrise', api);
  return api;
}
