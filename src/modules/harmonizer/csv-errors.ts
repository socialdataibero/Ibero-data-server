/**
 * Error bodies for CSV files, shared by the synchronous upload and the import worker so both
 * answer with the same `code`, `message` and `params`.
 */

/** `400 csv_not_utf8`: `line` is the line of the first byte that is not UTF-8. */
export function csvNotUtf8Body(line: number) {
  return {
    code: 'csv_not_utf8',
    message: `The file is not UTF-8 and its accents would be lost (the first unreadable character is on line ${line}). Save it as "CSV UTF-8" and upload it again.`,
    params: { line },
  };
}

/**
 * Explains a CSV that could not be parsed (H-07): the line and what to check, instead of the
 * parser's internal rule ("Invalid Opening Quote"). `lastRecordLine` is the line where the
 * last good row ended.
 */
export function csvError(
  err: unknown,
  lastRecordLine: number,
): { message: string; params: Record<string, unknown> } {
  const info = (err ?? {}) as {
    code?: string;
    lines?: number;
    record?: unknown[];
    columns?: unknown[];
  };
  switch (info.code) {
    case 'CSV_QUOTE_NOT_CLOSED': {
      const line = lastRecordLine + 1;
      return {
        message: `A value opens a quote (") and never closes it, starting at line ${line}.`,
        params: { problem: 'quote_not_closed', line },
      };
    }
    case 'CSV_RECORD_INCONSISTENT_COLUMNS':
      if (info.record && info.columns) {
        return {
          message: `The row on line ${info.lines} has ${info.record.length} columns and the header has ${info.columns.length}.`,
          params: {
            problem: 'inconsistent_columns',
            line: info.lines,
            rowColumns: info.record.length,
            headerColumns: info.columns.length,
          },
        };
      }
      break;
  }
  const where = info.lines ? ` near line ${info.lines}` : '';
  return {
    message: `The file could not be read as CSV${where}.`,
    params: {
      problem: 'unreadable',
      ...(info.lines ? { line: info.lines } : {}),
    },
  };
}
