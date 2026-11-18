/**
 * Saving an export as CSV, Excel or PDF: the CSV comes from the API as before; Excel and PDF are
 * the same table converted by the server (`/exports/file`, the console `/platform/exports/file`).
 */
import { exportFileName } from './compliance';

import type { RequestOptions } from './client';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
};

type Api = <T>(path: string, options?: Omit<RequestOptions, 'token'>) => Promise<T>;

type ConvertedFile = { fileName: string; mimeType: string; contentBase64: string };

function save(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Saves the export in the chosen format; `fileName` is the CSV's name when the API gives one. */
export async function saveExport(
  api: Api,
  input: {
    title: string;
    csv: string;
    format: ExportFormat;
    fileName?: string;
    /** In the platform console. */
    platform?: boolean;
  },
): Promise<void> {
  if (input.format === 'csv') {
    save(
      new Blob([input.csv], { type: 'text/csv;charset=utf-8' }),
      input.fileName ?? exportFileName(input.title),
    );
    return;
  }
  const file = await api<ConvertedFile>(
    input.platform ? '/platform/exports/file' : '/exports/file',
    { method: 'POST', body: { title: input.title, csv: input.csv, format: input.format } },
  );
  const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
  save(new Blob([bytes], { type: file.mimeType }), file.fileName);
}
