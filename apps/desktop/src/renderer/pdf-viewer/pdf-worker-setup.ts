import { GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let configuredWorkerSrc: string | null = null;

export function resolveLocalPdfWorkerUrl(): string {
  return pdfWorkerUrl;
}

export function configureLocalPdfWorker(): string {
  if (configuredWorkerSrc === null) {
    configuredWorkerSrc = resolveLocalPdfWorkerUrl();
    GlobalWorkerOptions.workerSrc = configuredWorkerSrc;
  }
  return configuredWorkerSrc;
}
