import { quoteIdent } from '../analysis/recipe.js';
import type { ParquetColumnType } from '../analysis/analysis.service.js';
import { stringify } from 'csv-stringify/sync';
import { PLAIN_NUMBER, jsTrimSql, sqlString } from './column-checks.js';
import { neutralizeCsvFormula } from './harmonized-view.js';

/**
 * The harmonized exports as DuckDB SQL over an edition's raw Parquet (positional columns
 * `c0…cN` plus `file_row_number`), so a download never loads the rows into Node. The values are
 * exactly those of `buildDatasetView` / `buildSurveyView` in harmonized-view.ts;
 * `harmonized-export.spec.ts` compares them.
 */

/** One column of an edition's harmonized view. */
export interface ExportColumn {
  /** Canonical name: the column of the view. */
  canon: string;
  /** Raw Parquet column (`c0`, `c1`, …). */
  rawColumn: string;
  /** Codes of «No especificado» (trimmed values that become `null`). */
  missingCodes: string[];
  /** Recoding: trimmed value → common code. */
  valueMap: Map<string, string>;
}

/**
 * The view's columns, in the order of `buildDatasetView`: one per canonical, at the position
 * where the file first has a column mapped to it. Its values come from the last such column,
 * because the view assigns them in header order and the last one wins (a repeated header of an
 * edition uploaded before headers were deduplicated, H-10).
 */
export function exportColumns(
  fileColumns: string[],
  mappings: {
    sourceColumn: string;
    canon: string;
    missingCodes: string[];
    valueMap: Map<string, string>;
  }[],
): ExportColumn[] {
  const bySource = new Map(mappings.map((m) => [m.sourceColumn, m]));
  const byCanon = new Map<string, ExportColumn>();
  fileColumns.forEach((name, i) => {
    const m = bySource.get(name);
    if (!m) return;
    const column = {
      canon: m.canon,
      rawColumn: `c${i}`,
      missingCodes: m.missingCodes,
      valueMap: m.valueMap,
    };
    const existing = byCanon.get(m.canon);
    if (existing) Object.assign(existing, column);
    else byCanon.set(m.canon, column);
  });
  return [...byCanon.values()];
}

/**
 * `cellValue` of harmonized-view.ts: empty after trimming, or a missing code, is `NULL`; then a
 * recoded value becomes its code; anything else stays as stored (not trimmed). `r` is the raw
 * value (`''` for a `NULL` cell, as the paged view reads it) and `t` its JavaScript trim.
 */
function cellSql(column: ExportColumn, r: string, t: string): string {
  const missing =
    column.missingCodes.length > 0
      ? `${t} = '' OR ${t} IN (${column.missingCodes.map(sqlString).join(', ')})`
      : `${t} = ''`;
  const value =
    column.valueMap.size > 0
      ? `CASE ${t} ${[...column.valueMap]
          .map(([from, to]) => `WHEN ${sqlString(from)} THEN ${sqlString(to)}`)
          .join(' ')} ELSE ${r} END`
      : r;
  return `CASE WHEN ${missing} THEN NULL ELSE ${value} END`;
}

/** `writeRowsToParquet`'s conversion of a text value to a Parquet type. */
function typed(expr: string, type: ParquetColumnType | undefined): string {
  return !type || type === 'VARCHAR' ? expr : `CAST(TRIM(${expr}) AS ${type})`;
}

/**
 * SELECT over `source` (a view of one edition's raw Parquet) that gives `_ibero_rn` (the row's
 * `file_row_number`, from 0) and
 * one column per entry of `output`: the harmonized value of the edition's column with that
 * canonical name, or `NULL` when the edition does not have it. With `types`, each value is
 * converted as the Parquet export does.
 */
export function editionSelectSql(
  source: string,
  columns: ExportColumn[],
  output: string[],
  types?: Record<string, ParquetColumnType>,
): string {
  const byCanon = new Map(columns.map((c, i) => [c.canon, { column: c, i }]));
  // Internal names start with `_`, which a canonical name never does.
  const inner = [
    'file_row_number AS _ibero_rn',
    ...columns.flatMap((c, i) => [
      `coalesce(${quoteIdent(c.rawColumn)}, '') AS _r${i}`,
      `${jsTrimSql(quoteIdent(c.rawColumn))} AS _t${i}`,
    ]),
  ];
  const outer = output.map((canon) => {
    const found = byCanon.get(canon);
    const type = types?.[canon];
    const expr = found
      ? typed(cellSql(found.column, `_r${found.i}`, `_t${found.i}`), type)
      : `CAST(NULL AS ${type ?? 'VARCHAR'})`;
    return `${expr} AS ${quoteIdent(canon)}`;
  });
  return `SELECT ${['_ibero_rn', ...outer].join(', ')} FROM (SELECT ${inner.join(', ')} FROM ${quoteIdent(source)})`;
}

export interface SurveyExportEdition {
  /** View of the edition's raw Parquet. */
  source: string;
  name: string;
  year: number;
  columns: ExportColumn[];
}

/**
 * The survey export as one SELECT per edition, in the given order, to be written one after
 * another (`AnalysisService.copyInternalQueryToParquet`): `_dataset`, `_year`, `_row` and then
 * `wanted`. `_row` is the record number in the file, from 1. With no editions, one SELECT with
 * the columns and no rows.
 */
export function surveyParquetSql(
  editions: SurveyExportEdition[],
  wanted: string[],
  types: Record<string, ParquetColumnType>,
): string[] {
  const origin = (e: SurveyExportEdition) => [
    `${sqlString(e.name)} AS "_dataset"`,
    `CAST(${Math.trunc(e.year)} AS BIGINT) AS "_year"`,
    `CAST(_ibero_rn + 1 AS BIGINT) AS "_row"`,
  ];
  const names = wanted.map(quoteIdent);
  if (editions.length === 0) {
    const empty = [
      'CAST(NULL AS VARCHAR) AS "_dataset"',
      'CAST(NULL AS BIGINT) AS "_year"',
      'CAST(NULL AS BIGINT) AS "_row"',
      ...wanted.map((w, i) => `CAST(NULL AS ${types[w] ?? 'VARCHAR'}) AS ${names[i]}`),
    ];
    return [`SELECT ${empty.join(', ')} WHERE false`];
  }
  return editions.map(
    (e) =>
      `SELECT ${[...origin(e), ...names].join(', ')} FROM (${editionSelectSql(e.source, e.columns, wanted, types)})`,
  );
}

/** The edition export as one SELECT (no origin columns). */
export function editionParquetSql(
  source: string,
  columns: ExportColumn[],
  types: Record<string, ParquetColumnType>,
): string {
  const names = columns.map((c) => quoteIdent(c.canon));
  return `SELECT ${names.join(', ')} FROM (${editionSelectSql(source, columns, columns.map((c) => c.canon), types)})`;
}

/**
 * The rebuilt original file (editions without a kept original): every column of the file, in
 * header order, with its values as stored and a `NULL` cell as `''`. A repeated header (an
 * edition uploaded before headers were deduplicated, H-10) gives the values of its last column
 * in both positions, as the download did when it read each row into an object by header name.
 */
export function originalSelectSql(fileColumns: string[], source = 'data'): string {
  return `SELECT ${fileColumns
    .map((name, i) => `coalesce(${quoteIdent(`c${fileColumns.lastIndexOf(name)}`)}, '') AS _o${i}`)
    .join(', ')} FROM ${quoteIdent(source)}`;
}

/*
 * CSV lines built in SQL, so DuckDB writes the CSV itself (`AnalysisService.writeInternalLines`)
 * instead of handing every row to JavaScript: on the census that took 259 s. The bytes are
 * those `csv-stringify` writes with the options of the downloads (`harmonized-export.spec.ts`
 * compares them).
 */

/**
 * `neutralizeCsvFormula` (harmonized-view.ts): a leading `'` on a value that starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return and is not a plain number.
 */
function neutralizeSql(v: string): string {
  return `CASE WHEN regexp_matches(${v}, '^[=+\\-@\\t\\r]') AND NOT regexp_full_match(${v}, ${PLAIN_NUMBER}) THEN '''' || ${v} ELSE ${v} END`;
}

/**
 * One field as `csv-stringify` writes it (delimiter `,`, quote and escape `"`, record delimiter
 * `\n`): nothing for `NULL` or `''`; quoted, with its quotes doubled, when it has a quote, a
 * comma or a line feed (a carriage return alone is not quoted); otherwise as it is.
 */
function csvFieldSql(v: string): string {
  return `CASE WHEN ${v} IS NULL OR ${v} = '' THEN '' WHEN contains(${v}, '"') OR contains(${v}, ',') OR contains(${v}, chr(10)) THEN '"' || replace(${v}, '"', '""') || '"' ELSE ${v} END`;
}

/** A literal field, written by `csv-stringify` itself. */
function csvLiteral(value: string): string {
  return stringify([[value]]).slice(0, -1);
}

/**
 * The fields of a line. One call, not a chain of `||`: with 500 columns the chain is deeper than
 * DuckDB accepts. No field is `NULL`, so `concat_ws` keeps them all.
 */
function joinFields(fields: string[]): string {
  return fields.length > 0 ? `concat_ws(',', ${fields.join(', ')})` : `''`;
}

/**
 * The CSV lines of an edition's harmonized view, as the download writes its rows: values with
 * formula neutralization, `output` as in `editionSelectSql` (a column the edition does not have
 * is empty). With `origin`, each line starts with `_dataset`, `_year` and `_row`, as in the
 * survey download. One column, `line`, without its line break.
 */
export function editionCsvLinesSql(
  source: string,
  columns: ExportColumn[],
  output: string[],
  origin?: { name: string; year: number },
): string {
  const values = output.map((_, i) => `_v${i}`);
  const neutralized = output.map(
    (canon, i) => `${neutralizeSql(quoteIdent(canon))} AS ${values[i]}`,
  );
  const fields = [
    ...(origin
      ? [
          sqlString(csvLiteral(neutralizeCsvFormula(origin.name))),
          sqlString(String(origin.year)),
          'CAST(_ibero_rn + 1 AS VARCHAR)',
        ]
      : []),
    ...values.map(csvFieldSql),
  ];
  return `SELECT ${joinFields(fields)} AS line FROM (SELECT ${['_ibero_rn', ...neutralized].join(', ')} FROM (${editionSelectSql(source, columns, output)}))`;
}

/** The CSV lines of the rebuilt original file: values as stored, no neutralization. */
export function originalCsvLinesSql(source: string, fileColumns: string[]): string {
  return `SELECT ${joinFields(fileColumns.map((_, i) => csvFieldSql(`_o${i}`)))} AS line FROM (${originalSelectSql(fileColumns, source)})`;
}
