import { z } from 'zod';
import {
  GetPdfViewerStateInputSchema,
  PdfCopyCitationPayloadSchema,
  PdfDeepLinkTargetSchema,
  PdfViewerStateSchema,
  type GetPdfViewerStateInput,
  type PdfCopyCitationPayload,
  type PdfDeepLinkTarget,
  type PdfViewerState,
} from '../pdf-viewer/contracts.js';
import { createResultSchema, type Result } from '../result.js';
import {
  PHASE1_IPC_CHANNELS,
  PHASE1_PRELOAD_EXPOSED_KEYS,
  Phase1IpcChannelContracts,
  type OkBooleanOutput,
  type Phase1SunrisePreloadApi,
} from './phase1-contracts.js';

export const PHASE2_IPC_EVENT_CHANNELS = {
  PDF_DEEP_LINK_OPENED: 'pdf:deepLinkOpened',
} as const;

export type Phase2IpcEventChannelName =
  (typeof PHASE2_IPC_EVENT_CHANNELS)[keyof typeof PHASE2_IPC_EVENT_CHANNELS];

export const PHASE2_IPC_CHANNELS = {
  ...PHASE1_IPC_CHANNELS,
  REFERENCES_COPY_CITATION: 'references:copyCitation',
  PDF_GET_VIEWER_STATE: 'pdf:getViewerState',
  PDF_SAVE_VIEWER_STATE: 'pdf:saveViewerState',
  PDF_OPEN_DEEP_LINK: 'pdf:openDeepLink',
  PDF_DEEP_LINK_OPENED: PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED,
} as const;

export type Phase2IpcChannelName = (typeof PHASE2_IPC_CHANNELS)[keyof typeof PHASE2_IPC_CHANNELS];

export const PHASE2_PRELOAD_EXPOSED_KEYS = [
  ...PHASE1_PRELOAD_EXPOSED_KEYS,
  'references',
  'pdf',
] as const;

const OkCompletedOutputSchema = z.object({
  completed: z.literal(true),
});

export const Phase2IpcChannelContracts = {
  ...Phase1IpcChannelContracts,
  [PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION]: {
    input: PdfCopyCitationPayloadSchema,
    output: createResultSchema(OkCompletedOutputSchema),
  },
  [PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE]: {
    input: GetPdfViewerStateInputSchema,
    output: createResultSchema(PdfViewerStateSchema.nullable()),
  },
  [PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE]: {
    input: PdfViewerStateSchema,
    output: createResultSchema(PdfViewerStateSchema),
  },
  [PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK]: {
    input: PdfDeepLinkTargetSchema,
    output: createResultSchema(PdfDeepLinkTargetSchema),
  },
} as const;

export const Phase2IpcEventContracts = {
  [PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED]: {
    payload: PdfDeepLinkTargetSchema,
  },
} as const;

export type PdfDeepLinkOpenedListener = (target: PdfDeepLinkTarget) => void;

export type IpcUnsubscribe = () => void;

export interface Phase2SunrisePreloadApi extends Phase1SunrisePreloadApi {
  readonly references: {
    readonly copyCitation: (payload: PdfCopyCitationPayload) => Promise<Result<OkBooleanOutput>>;
  };
  readonly pdf: {
    readonly getViewerState: (
      input: GetPdfViewerStateInput,
    ) => Promise<Result<PdfViewerState | null>>;
    readonly saveViewerState: (state: PdfViewerState) => Promise<Result<PdfViewerState>>;
    readonly openDeepLink: (target: PdfDeepLinkTarget) => Promise<Result<PdfDeepLinkTarget>>;
    readonly onDeepLinkOpened: (listener: PdfDeepLinkOpenedListener) => IpcUnsubscribe;
  };
}
