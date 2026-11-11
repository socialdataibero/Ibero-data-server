import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Temporary guard. Rebuilding the original CSV of an edition without a kept original still
 * loads every row into Node memory, and past ~500k rows that kills the whole server (measured
 * 2026-11-03, see planes-pendientes/escala-censo-nacional.md). Until it runs on DuckDB, it is
 * refused above a row limit. Remove this file and its call then. (Mapping and the harmonized
 * downloads no longer load the rows.)
 */
export const DEFAULT_FULL_READ_MAX_ROWS = 400_000;

export type FullReadOperation = 'original';

const OPERATION_TEXT: Record<FullReadOperation, string> = {
  original: 'Downloading the original file of',
};

/** `HARMONIZER_FULL_READ_MAX_ROWS`, or the default when it is unset or not a positive integer. */
export function fullReadMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HARMONIZER_FULL_READ_MAX_ROWS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_FULL_READ_MAX_ROWS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_FULL_READ_MAX_ROWS;
}

/** Throws `422 harmonizer_too_many_rows` when `rowCount` is over the limit. */
export function assertFullReadAllowed(
  operation: FullReadOperation,
  target: { edition?: string; survey?: string },
  rowCount: number,
  maxRows: number = fullReadMaxRows(),
): void {
  if (rowCount <= maxRows) return;
  const what =
    target.edition !== undefined
      ? `edition "${target.edition}"`
      : `survey "${target.survey}"`;
  throw new UnprocessableEntityException({
    code: 'harmonizer_too_many_rows',
    message: `${OPERATION_TEXT[operation]} ${what} is temporarily disabled: it has ${rowCount} rows and the limit is ${maxRows}. The paged views still work.`,
    params: { operation, ...target, rowCount, maxRows },
  });
}
