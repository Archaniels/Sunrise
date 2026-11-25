import {
  err,
  GetPdfViewerStateInputSchema,
  ok,
  PdfCopyCitationPayloadSchema,
  PdfDeepLinkTargetSchema,
  PdfViewerStateSchema,
  PHASE2_IPC_EVENT_CHANNELS,
  type GetPdfViewerStateInput,
  type OkBooleanOutput,
  type PdfCopyCitationPayload,
  type PdfDeepLinkTarget,
  type PdfViewerState,
  type Result,
} from '@sunrise/shared';

export interface DeepLinkTargetWindow {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly send: (channel: string, payload: unknown) => void;
  };
}

export function createDeepLinkBroadcaster(
  getWindow: () => DeepLinkTargetWindow | null,
): (target: PdfDeepLinkTarget) => void {
  return (target: PdfDeepLinkTarget): void => {
    const win = getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(PHASE2_IPC_EVENT_CHANNELS.PDF_DEEP_LINK_OPENED, target);
    }
  };
}

export interface Phase2DesktopServiceDeps {
  readonly writeClipboardText: (text: string) => void;
  readonly onDeepLinkOpened?: (target: PdfDeepLinkTarget) => void;
}

export interface Phase2DesktopService {
  readonly copyCitation: (payload: PdfCopyCitationPayload) => Promise<Result<OkBooleanOutput>>;
  readonly getViewerState: (
    input: GetPdfViewerStateInput,
  ) => Promise<Result<PdfViewerState | null>>;
  readonly saveViewerState: (state: PdfViewerState) => Promise<Result<PdfViewerState>>;
  readonly openDeepLink: (target: PdfDeepLinkTarget) => Promise<Result<PdfDeepLinkTarget>>;
}

function makeViewerStateKey(projectId: string, fileId: string): string {
  return `${projectId}:${fileId}`;
}

export function createPhase2DesktopService(deps: Phase2DesktopServiceDeps): Phase2DesktopService {
  const viewerStates = new Map<string, PdfViewerState>();

  return {
    copyCitation: async (payload): Promise<Result<OkBooleanOutput>> => {
      const parsed = PdfCopyCitationPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid citation copy payload',
        });
      }
      deps.writeClipboardText(parsed.data.formattedCitation);
      return ok({ completed: true });
    },

    getViewerState: async (input): Promise<Result<PdfViewerState | null>> => {
      const parsed = GetPdfViewerStateInputSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF viewer state lookup',
        });
      }
      const key = makeViewerStateKey(parsed.data.projectId, parsed.data.fileId);
      return ok(viewerStates.get(key) ?? null);
    },

    saveViewerState: async (state): Promise<Result<PdfViewerState>> => {
      const parsed = PdfViewerStateSchema.safeParse(state);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF viewer state',
        });
      }
      const key = makeViewerStateKey(parsed.data.projectId, parsed.data.fileId);
      viewerStates.set(key, parsed.data);
      return ok(parsed.data);
    },

    openDeepLink: async (target): Promise<Result<PdfDeepLinkTarget>> => {
      const parsed = PdfDeepLinkTargetSchema.safeParse(target);
      if (!parsed.success) {
        return err({
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid PDF deep link target',
        });
      }
      deps.onDeepLinkOpened?.(parsed.data);
      return ok(parsed.data);
    },
  };
}
