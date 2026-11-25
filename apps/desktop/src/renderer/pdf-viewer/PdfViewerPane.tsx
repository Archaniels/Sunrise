import type {
  PdfAnnotation,
  PdfSelectionActionType,
  PdfSelectionContext,
  PdfViewerState,
} from '@sunrise/shared';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Highlighter,
  PanelLeft,
  Search,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { getDocument, type RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { configureLocalPdfWorker } from './pdf-worker-setup.js';

export interface PdfViewerPaneProps {
  readonly state: PdfViewerState;
  readonly annotations: readonly PdfAnnotation[];
  readonly pdfData?: Uint8Array;
  readonly activeSelection: PdfSelectionContext | null;
  readonly onZoomChange: (nextZoom: number) => void;
  readonly onPageChange: (nextPage: number) => void;
  readonly onToggleThumbnails: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectionAction: (
    action: PdfSelectionActionType,
    selection: PdfSelectionContext,
  ) => void;
}

const HIGHLIGHT_COLOR_CLASSES: Readonly<Record<PdfAnnotation['color'], string>> = {
  yellow: 'bg-yellow-300/40 border-yellow-400',
  green: 'bg-emerald-300/40 border-emerald-400',
  blue: 'bg-sky-300/40 border-sky-400',
  pink: 'bg-pink-300/40 border-pink-400',
  purple: 'bg-purple-300/40 border-purple-400',
};

function readControlValue(target: unknown): string {
  if (typeof target === 'object' && target !== null && 'value' in target) {
    const value = Reflect.get(target, 'value');
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function isRenderCancelledError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = Reflect.get(error, 'name');
    return name === 'RenderingCancelledException' || name === 'AbortException';
  }
  return false;
}

export function PdfViewerPane({
  state,
  annotations,
  pdfData,
  activeSelection,
  onZoomChange,
  onPageChange,
  onToggleThumbnails,
  onSearchQueryChange,
  onSelectionAction,
}: PdfViewerPaneProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    configureLocalPdfWorker();
  }, []);

  useEffect(() => {
    if (!pdfData || !canvasRef.current) {
      setRenderError(null);
      return;
    }
    let cancelled = false;
    let activeRenderTask: RenderTask | null = null;
    const loadingTask = getDocument({ data: pdfData });

    const renderCurrentPage = async (): Promise<void> => {
      try {
        setRenderError(null);
        const doc = await loadingTask.promise;
        if (cancelled || !canvasRef.current) {
          return;
        }
        const page = await doc.getPage(state.currentPage);
        if (cancelled || !canvasRef.current) {
          return;
        }
        const viewport = page.getViewport({ scale: state.zoom });
        const canvas = canvasRef.current;
        Reflect.set(canvas, 'width', Math.floor(viewport.width));
        Reflect.set(canvas, 'height', Math.floor(viewport.height));
        activeRenderTask = page.render({ canvas, viewport });
        await activeRenderTask.promise;
      } catch (error: unknown) {
        if (!cancelled && !isRenderCancelledError(error)) {
          setRenderError('Unable to render this PDF page. The file may be corrupted or encrypted.');
        }
      }
    };

    void renderCurrentPage();
    return () => {
      cancelled = true;
      activeRenderTask?.cancel();
      void loadingTask.destroy().catch(() => undefined);
    };
  }, [pdfData, state.currentPage, state.zoom]);

  const pageAnnotations = annotations.filter((item) => item.pageNumber === state.currentPage);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Toggle PDF thumbnails"
            onClick={onToggleThumbnails}
            className="rounded bg-slate-900 p-1.5 hover:bg-slate-800"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Previous page"
            onClick={() => onPageChange(state.currentPage - 1)}
            className="rounded bg-slate-900 p-1.5 hover:bg-slate-800"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>
            Page {state.currentPage} / {state.totalPages}
          </span>
          <button
            type="button"
            aria-label="Next page"
            onClick={() => onPageChange(state.currentPage + 1)}
            className="rounded bg-slate-900 p-1.5 hover:bg-slate-800"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
            <input
              type="search"
              aria-label="Search inside PDF"
              value={state.searchQuery}
              onChange={(event) => onSearchQueryChange(readControlValue(event.currentTarget))}
              placeholder="Find in PDF..."
              className="rounded border border-slate-800 bg-slate-900 py-1 pl-7 pr-2 text-xs"
            />
          </label>
          <span className="text-slate-400">{state.searchMatches.length} match(es)</span>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => onZoomChange(state.zoom - 0.25)}
            className="rounded bg-slate-900 p-1.5 hover:bg-slate-800"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span>{Math.round(state.zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => onZoomChange(state.zoom + 0.25)}
            className="rounded bg-slate-900 p-1.5 hover:bg-slate-800"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {renderError !== null && (
        <div
          role="alert"
          className="border-b border-rose-800 bg-rose-950/80 px-3 py-2 text-xs text-rose-200"
        >
          {renderError}
        </div>
      )}

      {activeSelection !== null && (
        <div
          role="toolbar"
          aria-label="PDF text selection actions"
          className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs"
        >
          <button
            type="button"
            onClick={() => onSelectionAction('copy_citation', activeSelection)}
            className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy Citation
          </button>
          {!state.isReadOnly && (
            <button
              type="button"
              onClick={() => onSelectionAction('create_note', activeSelection)}
              className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700"
            >
              <Highlighter className="h-3.5 w-3.5" />
              Create Note
            </button>
          )}
          <button
            type="button"
            onClick={() => onSelectionAction('ask_raven', activeSelection)}
            className="flex items-center gap-1 rounded bg-indigo-700 px-2 py-1 text-white hover:bg-indigo-600"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Ask Raven
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {state.thumbnailsOpen && (
          <aside
            aria-label="PDF Page Thumbnails"
            className="w-36 overflow-auto border-r border-slate-800 p-2"
          >
            {Array.from({ length: state.totalPages }, (_, index) => index + 1).map((pageNum) => (
              <button
                key={pageNum}
                type="button"
                onClick={() => onPageChange(pageNum)}
                className={`mb-1.5 block w-full rounded border px-2 py-3 text-center text-xs ${
                  pageNum === state.currentPage
                    ? 'border-indigo-500 bg-indigo-950/60 text-white'
                    : 'border-slate-800 bg-slate-900 text-slate-400'
                }`}
              >
                Page {pageNum}
              </button>
            ))}
          </aside>
        )}

        <div className="relative flex flex-1 items-start justify-center overflow-auto p-4">
          <div className="relative inline-block">
            <canvas ref={canvasRef} className="rounded bg-white shadow" />
            {pageAnnotations.map((annotation) =>
              annotation.rects.map((rect, rectIdx) => (
                <div
                  key={`${annotation.id}-${rectIdx}`}
                  title={annotation.note || annotation.selectedText}
                  style={{
                    left: `${rect.x * 100}%`,
                    top: `${rect.y * 100}%`,
                    width: `${rect.width * 100}%`,
                    height: `${rect.height * 100}%`,
                  }}
                  className={`pointer-events-none absolute border ${HIGHLIGHT_COLOR_CLASSES[annotation.color]}`}
                />
              )),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
