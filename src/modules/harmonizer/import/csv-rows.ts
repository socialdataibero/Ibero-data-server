import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import { csvError } from '../csv-errors.js';
import { dedupeHeaders, type RenamedColumn } from '../harmonizer.service.js';
import { ImportError } from './import-error.js';

export interface CsvHeader {
  columns: string[];
  renamed: RenamedColumn[];
}

/**
 * Reads a CSV stream row by row with the same csv-parse options as the synchronous upload
 * (`parseCsv` in harmonizer.service.ts), so values, quotes (H-07), blank lines and errors are
 * the same. Rows are arrays: with csv-parse's `columns` option every row would become an
 * object, which made reading three times slower. The checks `columns` did are done here:
 * a row with another number of fields is the same `inconsistent_columns` error.
 *
 * `onHeader` receives the trimmed and deduplicated header; `onRow` each data row, in order.
 * Throws `ImportError` with `csv_invalid`, `csv_empty` or `csv_no_rows`.
 */
export async function readCsvRows(
  source: Readable,
  onHeader: (header: CsvHeader) => void | Promise<void>,
  onRow: (values: string[]) => void,
): Promise<{ header: CsvHeader; rowCount: number }> {
  let header: CsvHeader | null = null;
  let rowCount = 0;
  // Kept by `on_record`, which runs inside the parser: an error can stop the stream before
  // this loop has consumed the rows parsed ahead of it, the header included.
  let recordsParsed = 0;
  let headerLength = 0;
  let lastRecordLine = 1;

  const parser = parse({
    bom: true,
    skip_empty_lines: true,
    trim: false,
    cast: false,
    relax_quotes: true,
    on_record: (record: string[], context: { lines: number }) => {
      recordsParsed++;
      // With `columns`, the header was not a record and did not move this line.
      if (recordsParsed === 1) headerLength = record.length;
      else lastRecordLine = context.lines;
      return record;
    },
  });
  source.on('error', (err) => parser.destroy(err));
  source.pipe(parser);

  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (header === null) {
        // Trimmed before deduplicating: `EDAD␣` and `EDAD` would be different columns.
        header = dedupeHeaders(record.map((h) => h.trim()));
        await onHeader(header);
        continue;
      }
      onRow(record);
      rowCount++;
    }
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const info = err as { code?: string; lines?: number; record?: unknown[] };
    // Without `columns`, csv-parse names this error differently and does not carry the header.
    const normalized =
      info.code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH'
        ? {
            code: 'CSV_RECORD_INCONSISTENT_COLUMNS',
            lines: info.lines,
            record: info.record,
            columns: Array.from({ length: headerLength }),
          }
        : err;
    if (!isCsvParseError(err)) throw err;
    throw new ImportError(
      400,
      'csv_invalid',
      csvError(normalized, lastRecordLine),
    );
  }

  if (header === null) {
    throw new ImportError(400, 'csv_empty', {
      message: 'The file is empty: it has no header and no data.',
    });
  }
  if (rowCount === 0) {
    throw new ImportError(400, 'csv_no_rows', {
      message: 'The file only has a header and no data rows.',
    });
  }
  return { header, rowCount };
}

function isCsvParseError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('CSV_');
}
