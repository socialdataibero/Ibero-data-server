import type { Readable } from 'node:stream';
import { asciiFold } from './matching.js';
import type { SourceMetadata } from './source-metadata.js';

/** What a harmonizer download returns: the file and how to send it. */

export type ExportFormat = 'csv' | 'parquet';

export interface ExportFile {
  filename: string;
  contentType: string;
  /**
   * The whole file, or a stream for files too large to hold in memory. A stream over a temporary
   * file deletes it when it closes, also when it is destroyed without being read.
   */
  body: Buffer | Readable;
  /** Size in bytes, when it is known before sending. */
  size?: number;
  /**
   * Parquet exports only: the metadata of the source (see source-metadata.ts), or `null` when the
   * view has none. A resource saved from this file keeps a copy.
   */
  metadata?: SourceMetadata | null;
}

/** Temporary files of the downloads: `ibero-harmonized-<uuid>.<csv|parquet>`. */
export const EXPORT_TEMP_FILE =
  /^ibero-harmonized-[0-9a-f-]{36}\.(csv|parquet)/;

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
};

export function isExportFormat(fmt: string): fmt is ExportFormat {
  return fmt === 'csv' || fmt === 'parquet';
}

export function safeFileBase(name: string, fallback: string): string {
  return (
    asciiFold(name)
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '') || fallback
  );
}
