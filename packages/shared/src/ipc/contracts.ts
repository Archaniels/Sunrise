import { z } from 'zod';
import { HealthResponseSchema, type HealthResponse } from '../api/health.js';
import { createResultSchema, type Result } from '../result.js';
import { IPC_CHANNELS } from './channels.js';

const ALLOWED_EXTERNAL_URL_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?$/;

function hasSafeExternalUrlScheme(value: string): boolean {
  const lower = value.toLowerCase();
  if (!lower.startsWith('https://') && !lower.startsWith('http://')) {
    return false;
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return false;
  }
  return ALLOWED_EXTERNAL_URL_PATTERN.test(value);
}

export const ExternalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine(hasSafeExternalUrlScheme, {
    message: 'External URL must use http or https protocol without control characters',
  });

export const AppVersionSchema = z.object({
  appVersion: z.string().min(1).max(64),
  electronVersion: z.string().min(1).max(64),
  nodeVersion: z.string().min(1).max(64),
});

export type AppVersion = z.infer<typeof AppVersionSchema>;

export const WindowStateSchema = z.object({
  width: z.number().int().min(320).max(16384),
  height: z.number().int().min(240).max(16384),
  isMaximized: z.boolean(),
  isFullScreen: z.boolean(),
});

export type WindowState = z.infer<typeof WindowStateSchema>;

export const OpenExternalInputSchema = z.object({
  url: ExternalUrlSchema,
});

export type OpenExternalInput = z.infer<typeof OpenExternalInputSchema>;

export const OpenExternalOutputSchema = z.object({
  opened: z.literal(true),
  url: ExternalUrlSchema,
});

export type OpenExternalOutput = z.infer<typeof OpenExternalOutputSchema>;

export const EmptyInputSchema = z.undefined();

export const IpcChannelContracts = {
  [IPC_CHANNELS.APP_VERSION]: {
    input: EmptyInputSchema,
    output: createResultSchema(AppVersionSchema),
  },
  [IPC_CHANNELS.APP_HEALTH]: {
    input: EmptyInputSchema,
    output: createResultSchema(HealthResponseSchema),
  },
  [IPC_CHANNELS.WINDOW_GET_STATE]: {
    input: EmptyInputSchema,
    output: createResultSchema(WindowStateSchema),
  },
  [IPC_CHANNELS.SHELL_OPEN_EXTERNAL]: {
    input: OpenExternalInputSchema,
    output: createResultSchema(OpenExternalOutputSchema),
  },
} as const;

export interface SunrisePreloadApi {
  readonly app: {
    readonly getVersion: () => Promise<Result<AppVersion>>;
    readonly checkHealth: () => Promise<Result<HealthResponse>>;
  };
  readonly window: {
    readonly getState: () => Promise<Result<WindowState>>;
  };
  readonly shell: {
    readonly openExternal: (input: OpenExternalInput) => Promise<Result<OpenExternalOutput>>;
  };
}
