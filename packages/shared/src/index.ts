export {
  AppErrorSchema,
  createResultSchema,
  err,
  ErrorCodeSchema,
  ErrorDetailsValueSchema,
  ok,
  type AppError,
  type ErrorCode,
  type Result,
} from './result.js';

export {
  DependencyHealthSchema,
  HealthResponseSchema,
  isSystemHealthy,
  type DependencyHealth,
  type HealthResponse,
} from './api/health.js';

export {
  BrowserWindowWebPreferencesSchema,
  ELECTRON_SECURITY_BASELINE,
  FORBIDDEN_CSP_TOKENS,
  REQUIRED_CSP_DIRECTIVES,
  validateCspHeader,
  type BrowserWindowWebPreferences,
} from './electron/security.js';

export {
  FORBIDDEN_PRELOAD_KEYS,
  IPC_CHANNELS,
  PRELOAD_EXPOSED_KEYS,
  type IpcChannelName,
} from './ipc/channels.js';

export {
  AppVersionSchema,
  EmptyInputSchema,
  ExternalUrlSchema,
  IpcChannelContracts,
  OpenExternalInputSchema,
  OpenExternalOutputSchema,
  WindowStateSchema,
  type AppVersion,
  type OpenExternalInput,
  type OpenExternalOutput,
  type SunrisePreloadApi,
  type WindowState,
} from './ipc/contracts.js';

export {
  PhaseRecordSchema,
  PhaseTrackerSchema,
  StageStateSchema,
  SubPhaseRecordSchema,
  SubPhaseStatusSchema,
  type PhaseRecord,
  type PhaseTracker,
  type StageState,
  type SubPhaseRecord,
  type SubPhaseStatus,
} from './status/phases.js';
