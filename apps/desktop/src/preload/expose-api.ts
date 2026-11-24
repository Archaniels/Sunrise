import {
  err,
  IPC_CHANNELS,
  IpcChannelContracts,
  PHASE1_IPC_CHANNELS,
  Phase1IpcChannelContracts,
  type AppVersion,
  type CachedArtifactRecord,
  type ClearOfflineDraftInput,
  type GetCachedArtifactInput,
  type GetWorkspaceLayoutInput,
  type HealthResponse,
  type KeychainSession,
  type ListOfflineDraftsInput,
  type OfflineDraftRecord,
  type OkBooleanOutput,
  type OpenExternalInput,
  type OpenExternalOutput,
  type Phase1SunrisePreloadApi,
  type PickLocalFilesInput,
  type PickLocalFilesOutput,
  type Result,
  type SaveLocalFileInput,
  type SaveLocalFileOutput,
  type SaveOfflineDraftInput,
  type SunrisePreloadApi,
  type WindowState,
  type WorkspaceLayoutState,
} from '@sunrise/shared';
import type { z } from 'zod';

export type PreloadInvoke = (channel: string, payload?: unknown) => Promise<unknown>;

export interface ContextBridgeLike<TApi = SunrisePreloadApi> {
  readonly exposeInMainWorld: (apiKey: string, api: TApi) => void;
}

function parseIpcResult<T>(
  schema: z.ZodType<Result<T>, z.ZodTypeDef, unknown>,
  raw: unknown,
  channel: string,
): Result<T> {
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
  outputSchema: z.ZodType<Result<T>, z.ZodTypeDef, unknown>,
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

async function invokeValidatedChannel<TInput, TOutput>(
  invoke: PreloadInvoke,
  channel: string,
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Result<TOutput>, z.ZodTypeDef, unknown>,
  input: unknown,
): Promise<Result<TOutput>> {
  const parsedInput = inputSchema.safeParse(input);
  if (!parsedInput.success) {
    return err({
      code: 'VALIDATION_ERROR',
      message: parsedInput.error.issues[0]?.message ?? `Invalid IPC payload for ${channel}`,
    });
  }
  return invokeTypedChannel(invoke, channel, outputSchema, parsedInput.data);
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
    openExternal: async (input: OpenExternalInput): Promise<Result<OpenExternalOutput>> =>
      invokeValidatedChannel(
        invoke,
        IPC_CHANNELS.SHELL_OPEN_EXTERNAL,
        IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].input,
        IpcChannelContracts[IPC_CHANNELS.SHELL_OPEN_EXTERNAL].output,
        input,
      ),
  });

  return Object.freeze({
    app: appNamespace,
    window: windowNamespace,
    shell: shellNamespace,
  });
}

function buildAuthPreloadNamespace(invoke: PreloadInvoke): Phase1SunrisePreloadApi['auth'] {
  return Object.freeze({
    saveSession: async (session: KeychainSession): Promise<Result<OkBooleanOutput>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION].output,
        session,
      ),
    loadSession: async (): Promise<Result<KeychainSession | null>> =>
      invokeTypedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION].output,
      ),
    clearSession: async (): Promise<Result<OkBooleanOutput>> =>
      invokeTypedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION].output,
      ),
  });
}

function buildWorkspaceAndFilesNamespaces(invoke: PreloadInvoke): {
  readonly workspace: Phase1SunrisePreloadApi['workspace'];
  readonly files: Phase1SunrisePreloadApi['files'];
} {
  const workspace = Object.freeze({
    getLayout: async (
      input: GetWorkspaceLayoutInput,
    ): Promise<Result<WorkspaceLayoutState | null>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT].output,
        input,
      ),
    saveLayout: async (layout: WorkspaceLayoutState): Promise<Result<WorkspaceLayoutState>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT].output,
        layout,
      ),
  });

  const files = Object.freeze({
    pickFiles: async (input: PickLocalFilesInput): Promise<Result<PickLocalFilesOutput>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.FS_PICK_FILES,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_PICK_FILES].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_PICK_FILES].output,
        input,
      ),
    saveFile: async (input: SaveLocalFileInput): Promise<Result<SaveLocalFileOutput>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.FS_SAVE_FILE,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_SAVE_FILE].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_SAVE_FILE].output,
        input,
      ),
  });

  return { workspace, files };
}

function buildCachePreloadNamespace(invoke: PreloadInvoke): Phase1SunrisePreloadApi['cache'] {
  return Object.freeze({
    putArtifact: async (record: CachedArtifactRecord): Promise<Result<CachedArtifactRecord>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT].output,
        record,
      ),
    getArtifact: async (
      input: GetCachedArtifactInput,
    ): Promise<Result<CachedArtifactRecord | null>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT].output,
        input,
      ),
    saveDraft: async (input: SaveOfflineDraftInput): Promise<Result<OfflineDraftRecord>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT].output,
        input,
      ),
    listDrafts: async (input: ListOfflineDraftsInput): Promise<Result<OfflineDraftRecord[]>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS].output,
        input,
      ),
    clearDraft: async (input: ClearOfflineDraftInput): Promise<Result<OkBooleanOutput>> =>
      invokeValidatedChannel(
        invoke,
        PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT].input,
        Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT].output,
        input,
      ),
  });
}

export function createPhase1PreloadApi(invoke: PreloadInvoke): Phase1SunrisePreloadApi {
  const base = createPreloadApi(invoke);
  const { workspace, files } = buildWorkspaceAndFilesNamespaces(invoke);
  return Object.freeze({
    app: base.app,
    window: base.window,
    shell: base.shell,
    auth: buildAuthPreloadNamespace(invoke),
    workspace,
    files,
    cache: buildCachePreloadNamespace(invoke),
  });
}

export function exposeSunriseApi(
  bridge: ContextBridgeLike<SunrisePreloadApi>,
  invoke: PreloadInvoke,
): SunrisePreloadApi {
  const api = createPreloadApi(invoke);
  bridge.exposeInMainWorld('sunrise', api);
  return api;
}

export function exposePhase1SunriseApi(
  bridge: ContextBridgeLike<Phase1SunrisePreloadApi>,
  invoke: PreloadInvoke,
): Phase1SunrisePreloadApi {
  const api = createPhase1PreloadApi(invoke);
  bridge.exposeInMainWorld('sunrise', api);
  return api;
}
