import {
  err,
  IPC_CHANNELS,
  IpcChannelContracts,
  type AppVersion,
  type HealthResponse,
  type IpcChannelName,
  type OpenExternalOutput,
  type Result,
  type WindowState,
} from '@sunrise/shared';
import type { z } from 'zod';
import type { IpcRouterServices } from '../services/system-service.js';

export type { IpcRouterServices } from '../services/system-service.js';

export type IpcHandlerFn<TOutput> = (payload?: unknown) => Promise<Result<TOutput>>;

export type IpcHandlerMap = {
  readonly [IPC_CHANNELS.APP_VERSION]: IpcHandlerFn<AppVersion>;
  readonly [IPC_CHANNELS.APP_HEALTH]: IpcHandlerFn<HealthResponse>;
  readonly [IPC_CHANNELS.WINDOW_GET_STATE]: IpcHandlerFn<WindowState>;
  readonly [IPC_CHANNELS.SHELL_OPEN_EXTERNAL]: IpcHandlerFn<OpenExternalOutput>;
};

export interface IpcMainRegistrar {
  readonly handle: (
    channel: IpcChannelName,
    listener: (event: unknown, payload?: unknown) => Promise<unknown>,
  ) => void;
  readonly removeHandler?: (channel: IpcChannelName) => void;
}

const PHASE0_CHANNELS: ReadonlyArray<IpcChannelName> = [
  IPC_CHANNELS.APP_VERSION,
  IPC_CHANNELS.APP_HEALTH,
  IPC_CHANNELS.WINDOW_GET_STATE,
  IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
];

function formatValidationMessage(error: z.ZodError): string {
  const firstMessage = error.issues[0]?.message;
  if (firstMessage && firstMessage.trim().length > 0) {
    return firstMessage.trim().slice(0, 500);
  }
  return 'Invalid IPC request payload';
}

function formatUnexpectedError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 500);
  }
  return 'Unhandled IPC service error';
}

function createValidatedHandler<TInput, TOutput>(
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<Result<TOutput>>,
  execute: (input: TInput) => Promise<Result<TOutput>>,
): IpcHandlerFn<TOutput> {
  return async (payload?: unknown): Promise<Result<TOutput>> => {
    const parsedInput = inputSchema.safeParse(payload);
    if (!parsedInput.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: formatValidationMessage(parsedInput.error),
      });
    }

    try {
      const outcome = await execute(parsedInput.data);
      const parsedOutput = outputSchema.safeParse(outcome);
      if (!parsedOutput.success) {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Service returned an invalid IPC response',
        });
      }
      return parsedOutput.data;
    } catch (error: unknown) {
      return err({
        code: 'INTERNAL_ERROR',
        message: formatUnexpectedError(error),
      });
    }
  };
}

export function createIpcHandlers(services: IpcRouterServices): IpcHandlerMap {
  return {
    [IPC_CHANNELS.APP_VERSION]: createValidatedHandler(
      IpcChannelContracts[IPC_CHANNELS.APP_VERSION].input,
      IpcChannelContracts[IPC_CHANNELS.APP_VERSION].output,
      async () => services.getAppVersion(),
    ),
    [IPC_CHANNELS.APP_HEALTH]: createValidatedHandler(
      IpcChannelContracts[IPC_CHANNELS.APP_HEALTH].input,
      IpcChannelContracts[IPC_CHANNELS.APP_HEALTH].output,
      async () => services.checkHealth(),
    ),
    [IPC_CHANNELS.WINDOW_GET_STATE]: createValidatedHandler(
      IpcChannelContracts[IPC_CHANNELS.WINDOW_GET_STATE].input,
      IpcChannelContracts[IPC_CHANNELS.WINDOW_GET_STATE].output,
      async () => services.getWindowState(),
    ),
    [IPC_CHANNELS.SHELL_OPEN_EXTERNAL]: createValidatedHandler(
      IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].input,
      IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output,
      async (input) => services.openExternal(input.url),
    ),
  };
}

export function registerIpcHandlers(
  registrar: IpcMainRegistrar,
  services: IpcRouterServices,
): () => void {
  const handlers = createIpcHandlers(services);
  for (const channel of PHASE0_CHANNELS) {
    registrar.removeHandler?.(channel);
    const handler = handlers[channel];
    registrar.handle(channel, (_event: unknown, payload?: unknown) => handler(payload));
  }
  return (): void => {
    for (const channel of PHASE0_CHANNELS) {
      registrar.removeHandler?.(channel);
    }
  };
}
