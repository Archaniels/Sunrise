import {
  err,
  PHASE1_IPC_CHANNELS,
  Phase1IpcChannelContracts,
  type CachedArtifactRecord,
  type ClearOfflineDraftInput,
  type GetCachedArtifactInput,
  type GetWorkspaceLayoutInput,
  type KeychainSession,
  type ListOfflineDraftsInput,
  type OfflineDraftRecord,
  type OkBooleanOutput,
  type PickLocalFilesInput,
  type PickLocalFilesOutput,
  type Result,
  type SaveLocalFileInput,
  type SaveLocalFileOutput,
  type SaveOfflineDraftInput,
  type WorkspaceLayoutState,
} from '@sunrise/shared';
import type { z } from 'zod';

export interface Phase1IpcRouterServices {
  readonly saveSession: (session: KeychainSession) => Promise<Result<OkBooleanOutput>>;
  readonly loadSession: () => Promise<Result<KeychainSession | null>>;
  readonly clearSession: () => Promise<Result<OkBooleanOutput>>;
  readonly getLayout: (
    input: GetWorkspaceLayoutInput,
  ) => Promise<Result<WorkspaceLayoutState | null>>;
  readonly saveLayout: (layout: WorkspaceLayoutState) => Promise<Result<WorkspaceLayoutState>>;
  readonly pickFiles: (input: PickLocalFilesInput) => Promise<Result<PickLocalFilesOutput>>;
  readonly saveFile: (input: SaveLocalFileInput) => Promise<Result<SaveLocalFileOutput>>;
  readonly putArtifact: (record: CachedArtifactRecord) => Promise<Result<CachedArtifactRecord>>;
  readonly getArtifact: (
    input: GetCachedArtifactInput,
  ) => Promise<Result<CachedArtifactRecord | null>>;
  readonly saveDraft: (input: SaveOfflineDraftInput) => Promise<Result<OfflineDraftRecord>>;
  readonly listDrafts: (input: ListOfflineDraftsInput) => Promise<Result<OfflineDraftRecord[]>>;
  readonly clearDraft: (input: ClearOfflineDraftInput) => Promise<Result<OkBooleanOutput>>;
}

export type Phase1IpcHandlerFn<TOutput> = (payload?: unknown) => Promise<Result<TOutput>>;

export type Phase1OnlyChannelName =
  | typeof PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION
  | typeof PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION
  | typeof PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION
  | typeof PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT
  | typeof PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT
  | typeof PHASE1_IPC_CHANNELS.FS_PICK_FILES
  | typeof PHASE1_IPC_CHANNELS.FS_SAVE_FILE
  | typeof PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT
  | typeof PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT
  | typeof PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT
  | typeof PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS
  | typeof PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT;

export type Phase1IpcHandlerMap = {
  readonly [PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION]: Phase1IpcHandlerFn<OkBooleanOutput>;
  readonly [PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION]: Phase1IpcHandlerFn<KeychainSession | null>;
  readonly [PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION]: Phase1IpcHandlerFn<OkBooleanOutput>;
  readonly [PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT]: Phase1IpcHandlerFn<WorkspaceLayoutState | null>;
  readonly [PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT]: Phase1IpcHandlerFn<WorkspaceLayoutState>;
  readonly [PHASE1_IPC_CHANNELS.FS_PICK_FILES]: Phase1IpcHandlerFn<PickLocalFilesOutput>;
  readonly [PHASE1_IPC_CHANNELS.FS_SAVE_FILE]: Phase1IpcHandlerFn<SaveLocalFileOutput>;
  readonly [PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT]: Phase1IpcHandlerFn<CachedArtifactRecord>;
  readonly [PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT]: Phase1IpcHandlerFn<CachedArtifactRecord | null>;
  readonly [PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT]: Phase1IpcHandlerFn<OfflineDraftRecord>;
  readonly [PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS]: Phase1IpcHandlerFn<OfflineDraftRecord[]>;
  readonly [PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT]: Phase1IpcHandlerFn<OkBooleanOutput>;
};

export interface Phase1IpcRegistrar {
  readonly handle: (
    channel: Phase1OnlyChannelName,
    listener: (event: unknown, payload?: unknown) => Promise<unknown>,
  ) => void;
  readonly removeHandler?: (channel: Phase1OnlyChannelName) => void;
}

const PHASE1_CHANNELS: ReadonlyArray<Phase1OnlyChannelName> = [
  PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION,
  PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION,
  PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION,
  PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT,
  PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT,
  PHASE1_IPC_CHANNELS.FS_PICK_FILES,
  PHASE1_IPC_CHANNELS.FS_SAVE_FILE,
  PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT,
  PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT,
  PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT,
  PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS,
  PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT,
];

function createPhase1ValidatedHandler<TInput, TOutput>(
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Result<TOutput>, z.ZodTypeDef, unknown>,
  execute: (input: TInput) => Promise<Result<TOutput>>,
): Phase1IpcHandlerFn<TOutput> {
  return async (payload?: unknown): Promise<Result<TOutput>> => {
    const parsedInput = inputSchema.safeParse(payload);
    if (!parsedInput.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: parsedInput.error.issues[0]?.message ?? 'Invalid Phase 1 IPC payload',
      });
    }
    try {
      const outcome = await execute(parsedInput.data);
      const parsedOutput = outputSchema.safeParse(outcome);
      if (!parsedOutput.success) {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Phase 1 IPC service returned an invalid response',
        });
      }
      return parsedOutput.data;
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim().slice(0, 500)
          : 'Unhandled Phase 1 IPC service error';
      return err({ code: 'INTERNAL_ERROR', message });
    }
  };
}

export function createPhase1IpcHandlers(services: Phase1IpcRouterServices): Phase1IpcHandlerMap {
  return {
    [PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION].output,
      (input) => services.saveSession(input),
    ),
    [PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION].output,
      () => services.loadSession(),
    ),
    [PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION].output,
      () => services.clearSession(),
    ),
    [PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT].output,
      (input) => services.getLayout(input),
    ),
    [PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT].output,
      (input) => services.saveLayout(input),
    ),
    [PHASE1_IPC_CHANNELS.FS_PICK_FILES]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_PICK_FILES].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_PICK_FILES].output,
      (input) => services.pickFiles(input),
    ),
    [PHASE1_IPC_CHANNELS.FS_SAVE_FILE]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_SAVE_FILE].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.FS_SAVE_FILE].output,
      (input) => services.saveFile(input),
    ),
    [PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT].output,
      (input) => services.putArtifact(input),
    ),
    [PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT].output,
      (input) => services.getArtifact(input),
    ),
    [PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT].output,
      (input) => services.saveDraft(input),
    ),
    [PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS].output,
      (input) => services.listDrafts(input),
    ),
    [PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT]: createPhase1ValidatedHandler(
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT].input,
      Phase1IpcChannelContracts[PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT].output,
      (input) => services.clearDraft(input),
    ),
  };
}

export function registerPhase1IpcHandlers(
  registrar: Phase1IpcRegistrar,
  services: Phase1IpcRouterServices,
): () => void {
  const handlers = createPhase1IpcHandlers(services);
  for (const channel of PHASE1_CHANNELS) {
    registrar.removeHandler?.(channel);
    const handler = handlers[channel];
    registrar.handle(channel, (_event: unknown, payload?: unknown) => handler(payload));
  }
  return (): void => {
    for (const channel of PHASE1_CHANNELS) {
      registrar.removeHandler?.(channel);
    }
  };
}
