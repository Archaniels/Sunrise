import { z } from 'zod';
import { KeychainSessionSchema, type KeychainSession } from '../auth/contracts.js';
import {
  PickLocalFilesInputSchema,
  PickLocalFilesOutputSchema,
  SaveLocalFileInputSchema,
  SaveLocalFileOutputSchema,
  type PickLocalFilesInput,
  type PickLocalFilesOutput,
  type SaveLocalFileInput,
  type SaveLocalFileOutput,
} from '../files/contracts.js';
import {
  CachedArtifactRecordSchema,
  ClearOfflineDraftInputSchema,
  GetCachedArtifactInputSchema,
  ListOfflineDraftsInputSchema,
  OfflineDraftRecordSchema,
  SaveOfflineDraftInputSchema,
  type CachedArtifactRecord,
  type ClearOfflineDraftInput,
  type GetCachedArtifactInput,
  type ListOfflineDraftsInput,
  type OfflineDraftRecord,
  type SaveOfflineDraftInput,
} from '../quick-open/contracts.js';
import { createResultSchema, type Result } from '../result.js';
import {
  GetWorkspaceLayoutInputSchema,
  WorkspaceLayoutStateSchema,
  type GetWorkspaceLayoutInput,
  type WorkspaceLayoutState,
} from '../workspace/contracts.js';
import { IPC_CHANNELS } from './channels.js';
import { EmptyInputSchema, IpcChannelContracts, type SunrisePreloadApi } from './contracts.js';

export const PHASE1_IPC_CHANNELS = {
  ...IPC_CHANNELS,
  AUTH_SAVE_SESSION: 'auth:saveSession',
  AUTH_LOAD_SESSION: 'auth:loadSession',
  AUTH_CLEAR_SESSION: 'auth:clearSession',
  WORKSPACE_GET_LAYOUT: 'workspace:getLayout',
  WORKSPACE_SAVE_LAYOUT: 'workspace:saveLayout',
  FS_PICK_FILES: 'fs:pickFiles',
  FS_SAVE_FILE: 'fs:saveFile',
  CACHE_PUT_ARTIFACT: 'cache:putArtifact',
  CACHE_GET_ARTIFACT: 'cache:getArtifact',
  CACHE_SAVE_DRAFT: 'cache:saveDraft',
  CACHE_LIST_DRAFTS: 'cache:listDrafts',
  CACHE_CLEAR_DRAFT: 'cache:clearDraft',
} as const;

export type Phase1IpcChannelName = (typeof PHASE1_IPC_CHANNELS)[keyof typeof PHASE1_IPC_CHANNELS];

export const PHASE1_PRELOAD_EXPOSED_KEYS = [
  'app',
  'window',
  'shell',
  'auth',
  'workspace',
  'files',
  'cache',
] as const;

const OkBooleanOutputSchema = z.object({
  completed: z.literal(true),
});

export type OkBooleanOutput = z.infer<typeof OkBooleanOutputSchema>;

export const Phase1IpcChannelContracts = {
  ...IpcChannelContracts,
  [PHASE1_IPC_CHANNELS.AUTH_SAVE_SESSION]: {
    input: KeychainSessionSchema,
    output: createResultSchema(OkBooleanOutputSchema),
  },
  [PHASE1_IPC_CHANNELS.AUTH_LOAD_SESSION]: {
    input: EmptyInputSchema,
    output: createResultSchema(KeychainSessionSchema.nullable()),
  },
  [PHASE1_IPC_CHANNELS.AUTH_CLEAR_SESSION]: {
    input: EmptyInputSchema,
    output: createResultSchema(OkBooleanOutputSchema),
  },
  [PHASE1_IPC_CHANNELS.WORKSPACE_GET_LAYOUT]: {
    input: GetWorkspaceLayoutInputSchema,
    output: createResultSchema(WorkspaceLayoutStateSchema.nullable()),
  },
  [PHASE1_IPC_CHANNELS.WORKSPACE_SAVE_LAYOUT]: {
    input: WorkspaceLayoutStateSchema,
    output: createResultSchema(WorkspaceLayoutStateSchema),
  },
  [PHASE1_IPC_CHANNELS.FS_PICK_FILES]: {
    input: PickLocalFilesInputSchema,
    output: createResultSchema(PickLocalFilesOutputSchema),
  },
  [PHASE1_IPC_CHANNELS.FS_SAVE_FILE]: {
    input: SaveLocalFileInputSchema,
    output: createResultSchema(SaveLocalFileOutputSchema),
  },
  [PHASE1_IPC_CHANNELS.CACHE_PUT_ARTIFACT]: {
    input: CachedArtifactRecordSchema,
    output: createResultSchema(CachedArtifactRecordSchema),
  },
  [PHASE1_IPC_CHANNELS.CACHE_GET_ARTIFACT]: {
    input: GetCachedArtifactInputSchema,
    output: createResultSchema(CachedArtifactRecordSchema.nullable()),
  },
  [PHASE1_IPC_CHANNELS.CACHE_SAVE_DRAFT]: {
    input: SaveOfflineDraftInputSchema,
    output: createResultSchema(OfflineDraftRecordSchema),
  },
  [PHASE1_IPC_CHANNELS.CACHE_LIST_DRAFTS]: {
    input: ListOfflineDraftsInputSchema,
    output: createResultSchema(z.array(OfflineDraftRecordSchema)),
  },
  [PHASE1_IPC_CHANNELS.CACHE_CLEAR_DRAFT]: {
    input: ClearOfflineDraftInputSchema,
    output: createResultSchema(OkBooleanOutputSchema),
  },
} as const;

export interface Phase1SunrisePreloadApi extends SunrisePreloadApi {
  readonly auth: {
    readonly saveSession: (session: KeychainSession) => Promise<Result<OkBooleanOutput>>;
    readonly loadSession: () => Promise<Result<KeychainSession | null>>;
    readonly clearSession: () => Promise<Result<OkBooleanOutput>>;
  };
  readonly workspace: {
    readonly getLayout: (
      input: GetWorkspaceLayoutInput,
    ) => Promise<Result<WorkspaceLayoutState | null>>;
    readonly saveLayout: (layout: WorkspaceLayoutState) => Promise<Result<WorkspaceLayoutState>>;
  };
  readonly files: {
    readonly pickFiles: (input: PickLocalFilesInput) => Promise<Result<PickLocalFilesOutput>>;
    readonly saveFile: (input: SaveLocalFileInput) => Promise<Result<SaveLocalFileOutput>>;
  };
  readonly cache: {
    readonly putArtifact: (record: CachedArtifactRecord) => Promise<Result<CachedArtifactRecord>>;
    readonly getArtifact: (
      input: GetCachedArtifactInput,
    ) => Promise<Result<CachedArtifactRecord | null>>;
    readonly saveDraft: (input: SaveOfflineDraftInput) => Promise<Result<OfflineDraftRecord>>;
    readonly listDrafts: (input: ListOfflineDraftsInput) => Promise<Result<OfflineDraftRecord[]>>;
    readonly clearDraft: (input: ClearOfflineDraftInput) => Promise<Result<OkBooleanOutput>>;
  };
}
