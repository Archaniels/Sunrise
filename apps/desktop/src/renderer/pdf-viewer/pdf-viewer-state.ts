import {
  buildPdfAskRavenPayload,
  buildPdfCopyCitationPayload,
  buildPdfCreateNotePayload,
  canRoleMutatePdfAnnotations,
  clampPdfPage,
  clampPdfZoom,
  PDF_DEFAULT_ZOOM,
  PdfViewerStateSchema,
  type PdfAskRavenPayload,
  type PdfCopyCitationPayload,
  type PdfCreateNotePayload,
  type PdfDeepLinkTarget,
  type PdfHighlightColor,
  type PdfSearchMatch,
  type PdfSelectionActionType,
  type PdfSelectionContext,
  type PdfViewerState,
  type ProjectRole,
} from '@sunrise/shared';

export interface PdfViewerControllerInit {
  readonly projectId: string;
  readonly fileId: string;
  readonly referenceId: string | null;
  readonly totalPages: number;
  readonly role: ProjectRole;
}

export interface PdfViewerController {
  readonly getState: () => PdfViewerState;
  readonly setZoom: (zoom: number) => PdfViewerState;
  readonly goToPage: (pageNumber: number) => PdfViewerState;
  readonly toggleThumbnails: () => PdfViewerState;
  readonly openDeepLink: (target: PdfDeepLinkTarget) => PdfViewerState;
  readonly searchDocument: (query: string, pageTexts: readonly string[]) => PdfViewerState;
  readonly createSelectionAction: (
    action: PdfSelectionActionType,
    selection: PdfSelectionContext,
    color?: PdfHighlightColor,
  ) => PdfCopyCitationPayload | PdfCreateNotePayload | PdfAskRavenPayload;
}

function buildExcerpt(text: string, matchStart: number, matchLength: number): string {
  const start = Math.max(0, matchStart - 40);
  const end = Math.min(text.length, matchStart + matchLength + 60);
  const slice = text.slice(start, end).trim();
  return slice.length > 0 ? slice.slice(0, 500) : text.slice(0, 120);
}

function findMatchesInPages(query: string, pageTexts: readonly string[]): PdfSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [];
  }
  const matches: PdfSearchMatch[] = [];
  for (let pageIndex = 0; pageIndex < pageTexts.length; pageIndex += 1) {
    const pageText = pageTexts[pageIndex] ?? '';
    const lowered = pageText.toLowerCase();
    let searchFrom = 0;
    let matchIndex = 0;
    while (searchFrom < lowered.length) {
      const foundAt = lowered.indexOf(needle, searchFrom);
      if (foundAt === -1) {
        break;
      }
      matches.push({
        pageNumber: pageIndex + 1,
        matchIndex,
        excerpt: buildExcerpt(pageText, foundAt, needle.length),
      });
      matchIndex += 1;
      searchFrom = foundAt + needle.length;
    }
  }
  return matches;
}

export function createPdfViewerController(init: PdfViewerControllerInit): PdfViewerController {
  const safeTotalPages = Math.max(1, Math.min(10000, Math.floor(init.totalPages)));
  let state: PdfViewerState = PdfViewerStateSchema.parse({
    projectId: init.projectId,
    fileId: init.fileId,
    referenceId: init.referenceId,
    currentPage: 1,
    totalPages: safeTotalPages,
    zoom: PDF_DEFAULT_ZOOM,
    thumbnailsOpen: false,
    searchQuery: '',
    searchMatches: [],
    activeMatchIndex: -1,
    isReadOnly: !canRoleMutatePdfAnnotations(init.role),
  });

  const snapshot = (): PdfViewerState => ({
    ...state,
    searchMatches: [...state.searchMatches],
  });

  return {
    getState: snapshot,

    setZoom: (zoom): PdfViewerState => {
      state = PdfViewerStateSchema.parse({
        ...state,
        zoom: clampPdfZoom(zoom),
      });
      return snapshot();
    },

    goToPage: (pageNumber): PdfViewerState => {
      state = PdfViewerStateSchema.parse({
        ...state,
        currentPage: clampPdfPage(pageNumber, state.totalPages),
      });
      return snapshot();
    },

    toggleThumbnails: (): PdfViewerState => {
      state = PdfViewerStateSchema.parse({
        ...state,
        thumbnailsOpen: !state.thumbnailsOpen,
      });
      return snapshot();
    },

    openDeepLink: (target): PdfViewerState => {
      state = PdfViewerStateSchema.parse({
        ...state,
        projectId: target.projectId,
        fileId: target.fileId,
        referenceId: target.referenceId,
        currentPage: clampPdfPage(target.pageNumber, state.totalPages),
        searchQuery: target.searchExcerpt ?? state.searchQuery,
      });
      return snapshot();
    },

    searchDocument: (query, pageTexts): PdfViewerState => {
      const trimmed = query.slice(0, 300);
      const matches = findMatchesInPages(trimmed, pageTexts);
      state = PdfViewerStateSchema.parse({
        ...state,
        searchQuery: trimmed,
        searchMatches: matches,
        activeMatchIndex: matches.length > 0 ? 0 : -1,
      });
      return snapshot();
    },

    createSelectionAction: (
      action,
      selection,
      color = 'yellow',
    ): PdfCopyCitationPayload | PdfCreateNotePayload | PdfAskRavenPayload => {
      if (action === 'copy_citation') {
        return buildPdfCopyCitationPayload(selection);
      }
      if (action === 'create_note') {
        return buildPdfCreateNotePayload(selection, color);
      }
      return buildPdfAskRavenPayload(selection);
    },
  };
}
