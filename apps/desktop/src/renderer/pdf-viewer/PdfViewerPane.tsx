import type {
  IpcUnsubscribe,
  PdfAnnotation,
  PdfDeepLinkOpenedListener,
  PdfDeepLinkTarget,
  PdfRect,
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
import { getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { configureLocalPdfWorker } from './pdf-worker-setup.js';

export interface PdfViewerPaneProps {
  readonly state: PdfViewerState;
  readonly annotations: readonly PdfAnnotation[];
  readonly pdfData?: Uint8Array;
  readonly citeKey?: string | null;
  readonly activeSelection: PdfSelectionContext | null;
  readonly onZoomChange: (nextZoom: number) => void;
  readonly onPageChange: (nextPage: number) => void;
  readonly onToggleThumbnails: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectionAction: (
    action: PdfSelectionActionType,
    selection: PdfSelectionContext,
  ) => void;
  readonly onTextSelected?: (selection: PdfSelectionContext | null) => void;
  readonly subscribeDeepLink?: (listener: PdfDeepLinkOpenedListener) => IpcUnsubscribe;
  readonly onDeepLinkReceived?: (target: PdfDeepLinkTarget) => void;
}

const HIGHLIGHT_COLOR_CLASSES: Readonly<Record<PdfAnnotation['color'], string>> = {
  yellow: 'bg-yellow-300/40 border-yellow-400',
  green: 'bg-emerald-300/40 border-emerald-400',
  blue: 'bg-sky-300/40 border-sky-400',
  pink: 'bg-pink-300/40 border-pink-400',
  purple: 'bg-purple-300/40 border-purple-400',
};

interface DomRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

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

function readNumericProp(obj: unknown, key: string): number {
  if (typeof obj !== 'object' || obj === null) {
    return 0;
  }
  const value = Reflect.get(obj, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readDomRect(obj: unknown): DomRectLike | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }
  const width = readNumericProp(obj, 'width');
  const height = readNumericProp(obj, 'height');
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    left: readNumericProp(obj, 'left'),
    top: readNumericProp(obj, 'top'),
    width,
    height,
  };
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeClientRects(rawRects: unknown, containerRect: DomRectLike): PdfRect[] {
  const rects: PdfRect[] = [];
  const listLength = readNumericProp(rawRects, 'length');
  for (let index = 0; index < listLength && rects.length < 50; index += 1) {
    const rect = readDomRect(Reflect.get(rawRects as object, index));
    if (!rect) {
      continue;
    }
    const x = clampUnit((rect.left - containerRect.left) / containerRect.width);
    const y = clampUnit((rect.top - containerRect.top) / containerRect.height);
    const width = Math.max(0.001, Math.min(1 - x, rect.width / containerRect.width));
    const height = Math.max(0.001, Math.min(1 - y, rect.height / containerRect.height));
    rects.push({ x, y, width, height });
  }
  return rects;
}

function readSelectionRectsFromContainer(
  selectionObj: object,
  container: HTMLDivElement,
): PdfRect[] {
  const getRangeAt = Reflect.get(selectionObj, 'getRangeAt');
  const getBoundingRect = Reflect.get(container, 'getBoundingClientRect');
  if (typeof getRangeAt !== 'function' || typeof getBoundingRect !== 'function') {
    return [];
  }
  const containerRect = readDomRect(getBoundingRect.call(container));
  if (!containerRect) {
    return [];
  }
  const range: unknown = getRangeAt.call(selectionObj, 0);
  if (typeof range !== 'object' || range === null) {
    return [];
  }
  const getClientRects = Reflect.get(range, 'getClientRects');
  if (typeof getClientRects !== 'function') {
    return [];
  }
  const rawRects: unknown = getClientRects.call(range);
  if (typeof rawRects !== 'object' || rawRects === null) {
    return [];
  }
  return normalizeClientRects(rawRects, containerRect);
}

function extractSelectionContext(
  state: PdfViewerState,
  citeKey: string | null,
  container: HTMLDivElement | null,
): PdfSelectionContext | null {
  if (!container) {
    return null;
  }
  const getSelectionFn: unknown = Reflect.get(globalThis, 'getSelection');
  if (typeof getSelectionFn !== 'function') {
    return null;
  }
  const selectionObj: unknown = getSelectionFn.call(globalThis);
  if (typeof selectionObj !== 'object' || selectionObj === null) {
    return null;
  }
  const toStringFn = Reflect.get(selectionObj, 'toString');
  const rangeCount = readNumericProp(selectionObj, 'rangeCount');
  const rawText = typeof toStringFn === 'function' ? String(toStringFn.call(selectionObj)) : '';
  const selectedText = rawText.trim().slice(0, 5000);
  if (rangeCount <= 0 || selectedText.length === 0) {
    return null;
  }
  const rects = readSelectionRectsFromContainer(selectionObj, container);
  const safeRects: PdfRect[] =
    rects.length > 0 ? rects : [{ x: 0.05, y: 0.05, width: 0.5, height: 0.03 }];
  return {
    projectId: state.projectId,
    fileId: state.fileId,
    referenceId: state.referenceId,
    citeKey,
    pageNumber: state.currentPage,
    selectedText,
    rects: safeRects,
  };
}

function resetTextLayerElement(
  container: HTMLDivElement,
  width: number,
  height: number,
  scale: number,
): void {
  Reflect.set(container, 'innerHTML', '');
  const styleObj: unknown = Reflect.get(container, 'style');
  if (typeof styleObj === 'object' && styleObj !== null) {
    Reflect.set(styleObj, 'width', `${Math.floor(width)}px`);
    Reflect.set(styleObj, 'height', `${Math.floor(height)}px`);
    const setProperty = Reflect.get(styleObj, 'setProperty');
    if (typeof setProperty === 'function') {
      setProperty.call(styleObj, '--scale-factor', String(scale));
    }
  }
}

export function PdfViewerPane({
  state,
  annotations,
  pdfData,
  citeKey = null,
  activeSelection,
  onZoomChange,
  onPageChange,
  onToggleThumbnails,
  onSearchQueryChange,
  onSelectionAction,
  onTextSelected,
  subscribeDeepLink,
  onDeepLinkReceived,
}: PdfViewerPaneProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [loadedDoc, setLoadedDoc] = useState<PDFDocumentProxy | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [localSelection, setLocalSelection] = useState<PdfSelectionContext | null>(null);

  useEffect(() => {
    configureLocalPdfWorker();
  }, []);

  useEffect(() => {
    if (!subscribeDeepLink || !onDeepLinkReceived) {
      return;
    }
    return subscribeDeepLink(onDeepLinkReceived);
  }, [subscribeDeepLink, onDeepLinkReceived]);

  useEffect(() => {
    if (!pdfData) {
      setLoadedDoc(null);
      setRenderError(null);
      return;
    }
    let cancelled = false;
    const loadingTask = getDocument({ data: new Uint8Array(pdfData) });

    const loadDocument = async (): Promise<void> => {
      try {
        setRenderError(null);
        const doc = await loadingTask.promise;
        if (!cancelled) {
          setLoadedDoc(doc);
        }
      } catch (error: unknown) {
        if (!cancelled && !isRenderCancelledError(error)) {
          setLoadedDoc(null);
          setRenderError(
            'Unable to load this PDF document. The file may be corrupted or encrypted.',
          );
        }
      }
    };

    void loadDocument();
    return () => {
      cancelled = true;
      setLoadedDoc(null);
      void loadingTask.destroy().catch(() => undefined);
    };
  }, [state.fileId, pdfData]);

  useEffect(() => {
    if (!loadedDoc || !canvasRef.current) {
      return;
    }
    let cancelled = false;
    let activeRenderTask: RenderTask | null = null;
    let activeTextLayer: TextLayer | null = null;

    const renderCurrentPage = async (): Promise<void> => {
      try {
        setRenderError(null);
        const page = await loadedDoc.getPage(state.currentPage);
        if (cancelled || !canvasRef.current) {
          return;
        }
        const viewport = page.getViewport({ scale: state.zoom });
        const canvas = canvasRef.current;
        Reflect.set(canvas, 'width', Math.floor(viewport.width));
        Reflect.set(canvas, 'height', Math.floor(viewport.height));
        activeRenderTask = page.render({ canvas, viewport });
        await activeRenderTask.promise;
        if (cancelled || !textLayerRef.current) {
          return;
        }
        const textContent = await page.getTextContent();
        if (cancelled || !textLayerRef.current) {
          return;
        }
        resetTextLayerElement(textLayerRef.current, viewport.width, viewport.height, state.zoom);
        activeTextLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerRef.current,
          viewport,
        });
        await activeTextLayer.render();
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
      activeTextLayer?.cancel();
    };
  }, [loadedDoc, state.currentPage, state.zoom]);

  const handleTextSelectionEnd = (): void => {
    const context = extractSelectionContext(state, citeKey, textLayerRef.current);
    setLocalSelection(context);
    onTextSelected?.(context);
  };

  const effectiveSelection = activeSelection ?? localSelection;
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

      {effectiveSelection !== null && (
        <div
          role="toolbar"
          aria-label="PDF text selection actions"
          className="flex items-center gap-2 border-b border-slate-800 bg-slate-900/90 px-3 py-1.5 text-xs"
        >
          <button
            type="button"
            onClick={() => onSelectionAction('copy_citation', effectiveSelection)}
            className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy Citation
          </button>
          {!state.isReadOnly && (
            <button
              type="button"
              onClick={() => onSelectionAction('create_note', effectiveSelection)}
              className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 hover:bg-slate-700"
            >
              <Highlighter className="h-3.5 w-3.5" />
              Create Note
            </button>
          )}
          <button
            type="button"
            onClick={() => onSelectionAction('ask_raven', effectiveSelection)}
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
            <div
              ref={textLayerRef}
              aria-label="PDF selectable text layer"
              onMouseUp={handleTextSelectionEnd}
              className="textLayer absolute inset-0 select-text overflow-hidden leading-none opacity-25"
            />
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
