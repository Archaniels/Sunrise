import type { FilePreviewResponse } from '@sunrise/shared';
import type { ReactElement } from 'react';

export interface FilePreviewPaneProps {
  readonly fileName: string;
  readonly preview: FilePreviewResponse;
}

export function FilePreviewPane({ fileName, preview }: FilePreviewPaneProps): ReactElement {
  if (preview.previewType === 'image') {
    return (
      <figure className="flex flex-col gap-3 p-4">
        <img
          src={preview.previewUrl}
          alt={fileName}
          className="max-h-96 rounded border border-slate-800 object-contain"
        />
        <figcaption className="text-xs text-slate-400">{preview.mimeType}</figcaption>
      </figure>
    );
  }

  if (preview.previewType === 'json') {
    return (
      <section className="p-4">
        <pre className="overflow-auto rounded bg-slate-900 p-4 text-xs text-emerald-300">
          {preview.formattedJson}
        </pre>
        {preview.truncated && (
          <p className="mt-2 text-xs text-amber-400">Preview truncated to 2 MB limit.</p>
        )}
      </section>
    );
  }

  if (preview.previewType === 'text') {
    return (
      <section className="p-4">
        <pre className="overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-4 text-xs text-slate-200">
          {preview.content}
        </pre>
        {preview.truncated && (
          <p className="mt-2 text-xs text-amber-400">Preview truncated to 2 MB limit.</p>
        )}
      </section>
    );
  }

  return (
    <section className="p-6 text-sm text-slate-300">
      <p className="font-medium">{fileName}</p>
      <p className="text-xs text-slate-400">
        Binary file ({preview.mimeType}) — {preview.sizeBytes} bytes
      </p>
    </section>
  );
}
