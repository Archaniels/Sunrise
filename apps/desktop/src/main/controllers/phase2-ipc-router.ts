import {
  err,
  PHASE2_IPC_CHANNELS,
  Phase2IpcChannelContracts,
  type GetPdfViewerStateInput,
  type OkBooleanOutput,
  type PdfCopyCitationPayload,
  type PdfDeepLinkTarget,
  type PdfViewerState,
  type Result,
} from '@sunrise/shared';
import type { z } from 'zod';

export interface Phase2IpcRouterServices {
  readonly copyCitation: (payload: PdfCopyCitationPayload) => Promise<Result<OkBooleanOutput>>;
  readonly getViewerState: (
    input: GetPdfViewerStateInput,
  ) => Promise<Result<PdfViewerState | null>>;
  readonly saveViewerState: (state: PdfViewerState) => Promise<Result<PdfViewerState>>;
  readonly openDeepLink: (target: PdfDeepLinkTarget) => Promise<Result<PdfDeepLinkTarget>>;
}

export type Phase2IpcHandlerFn<TOutput> = (payload?: unknown) => Promise<Result<TOutput>>;

export type Phase2OnlyChannelName =
  | typeof PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION
  | typeof PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE
  | typeof PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE
  | typeof PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK;

export type Phase2IpcHandlerMap = {
  readonly [PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION]: Phase2IpcHandlerFn<OkBooleanOutput>;
  readonly [PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE]: Phase2IpcHandlerFn<PdfViewerState | null>;
  readonly [PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE]: Phase2IpcHandlerFn<PdfViewerState>;
  readonly [PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK]: Phase2IpcHandlerFn<PdfDeepLinkTarget>;
};

export interface Phase2IpcRegistrar {
  readonly handle: (
    channel: Phase2OnlyChannelName,
    listener: (event: unknown, payload?: unknown) => Promise<unknown>,
  ) => void;
  readonly removeHandler?: (channel: Phase2OnlyChannelName) => void;
}

const PHASE2_CHANNELS: ReadonlyArray<Phase2OnlyChannelName> = [
  PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION,
  PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE,
  PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE,
  PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK,
];

function createPhase2ValidatedHandler<TInput, TOutput>(
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
  outputSchema: z.ZodType<Result<TOutput>, z.ZodTypeDef, unknown>,
  execute: (input: TInput) => Promise<Result<TOutput>>,
): Phase2IpcHandlerFn<TOutput> {
  return async (payload?: unknown): Promise<Result<TOutput>> => {
    const parsedInput = inputSchema.safeParse(payload);
    if (!parsedInput.success) {
      return err({
        code: 'VALIDATION_ERROR',
        message: parsedInput.error.issues[0]?.message ?? 'Invalid Phase 2 IPC payload',
      });
    }
    try {
      const outcome = await execute(parsedInput.data);
      const parsedOutput = outputSchema.safeParse(outcome);
      if (!parsedOutput.success) {
        return err({
          code: 'INTERNAL_ERROR',
          message: 'Phase 2 IPC service returned an invalid response',
        });
      }
      return parsedOutput.data;
    } catch (error: unknown) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim().slice(0, 500)
          : 'Unhandled Phase 2 IPC service error';
      return err({ code: 'INTERNAL_ERROR', message });
    }
  };
}

export function createPhase2IpcHandlers(services: Phase2IpcRouterServices): Phase2IpcHandlerMap {
  return {
    [PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION]: createPhase2ValidatedHandler(
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION].input,
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.REFERENCES_COPY_CITATION].output,
      (input) => services.copyCitation(input),
    ),
    [PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE]: createPhase2ValidatedHandler(
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE].input,
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_GET_VIEWER_STATE].output,
      (input) => services.getViewerState(input),
    ),
    [PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE]: createPhase2ValidatedHandler(
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE].input,
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_SAVE_VIEWER_STATE].output,
      (input) => services.saveViewerState(input),
    ),
    [PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK]: createPhase2ValidatedHandler(
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK].input,
      Phase2IpcChannelContracts[PHASE2_IPC_CHANNELS.PDF_OPEN_DEEP_LINK].output,
      (input) => services.openDeepLink(input),
    ),
  };
}

export function registerPhase2IpcHandlers(
  registrar: Phase2IpcRegistrar,
  services: Phase2IpcRouterServices,
): () => void {
  const handlers = createPhase2IpcHandlers(services);
  for (const channel of PHASE2_CHANNELS) {
    registrar.removeHandler?.(channel);
    const handler = handlers[channel];
    registrar.handle(channel, (_event: unknown, payload?: unknown) => handler(payload));
  }
  return (): void => {
    for (const channel of PHASE2_CHANNELS) {
      registrar.removeHandler?.(channel);
    }
  };
}
