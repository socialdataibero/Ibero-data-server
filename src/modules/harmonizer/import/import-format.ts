/** How an uploaded file is read, from its name. */
export type ImportFormat = 'csv' | 'csv_gz' | 'dbf';

/**
 * `.dbf` is a DBF table and `.gz` a gzip-compressed CSV (`.csv.gz`). Any other name is read as
 * CSV, as the synchronous upload does: its extension is not checked.
 */
export function importFormat(fileName: string): ImportFormat {
  if (/\.dbf$/i.test(fileName)) return 'dbf';
  if (/\.gz$/i.test(fileName)) return 'csv_gz';
  return 'csv';
}
