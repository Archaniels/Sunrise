import { GlobalWorkerOptions } from 'pdfjs-dist';

let configuredWorkerSrc: string | null = null;

export function resolveLocalPdfWorkerUrl(): string {
  return new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
}

export function configureLocalPdfWorker(): string {
  if (configuredWorkerSrc === null) {
    configuredWorkerSrc = resolveLocalPdfWorkerUrl();
    GlobalWorkerOptions.workerSrc = configuredWorkerSrc;
  }
  return configuredWorkerSrc;
}
