import { codeKey } from './codebook.js';
import type { ValueType } from './harmonized-view.js';

/**
 * Value checks of a source column, as DuckDB SQL over the edition's raw Parquet, so that
 * mapping does not load the rows into Node. Each query must give exactly what the JavaScript
 * rules in `harmonized-view.ts` (`inferValueType`, `valuesNotFitting`) and `codebook.ts`
 * (`codeKey`) give over the same values; `column-checks.spec.ts` compares them.
 *
 * Every query first groups the column by its raw value and only then trims and checks the
 * distinct values: a column with few distinct values (most survey columns) costs one scan.
 * The queries read the view `data` with a `file_row_number` column (see
 * `AnalysisService.runInternalQueries`).
 */

/** What JavaScript's `String.prototype.trim` removes: WhiteSpace and LineTerminator. */
export const JS_WHITESPACE_CODES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
];
const JS_WHITESPACE_SQL = JS_WHITESPACE_CODES.map((c) => `chr(${c})`).join(' || ');

/** `value.trim()` in SQL. DuckDB's one-argument `trim` only removes spaces. */
export function jsTrimSql(expr: string): string {
  return `trim(coalesce(${expr}, ''), ${JS_WHITESPACE_SQL})`;
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlList(values: string[]): string {
  return values.map(sqlString).join(', ');
}

// The regular expressions of harmonized-view.ts. RE2's `[0-9]` is JavaScript's `\d` (no `u` flag).
const INTEGER = `'[+-]?[0-9]+'`;
/** `PLAIN_NUMBER` of harmonized-view.ts, as an SQL string for `regexp_full_match`. */
export const PLAIN_NUMBER = `'[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?'`;

function isInteger(v: string): string {
  return `regexp_full_match(${v}, ${INTEGER})`;
}
/** `isFiniteNumber`: plain number form, and not ±Infinity once read as a double (`1e309`). */
function isFiniteNumber(v: string): string {
  return `(regexp_full_match(${v}, ${PLAIN_NUMBER}) AND coalesce(isfinite(TRY_CAST(${v} AS DOUBLE)), false))`;
}
/** `fitsType(v, 'integer')`: integer form and within BIGINT. */
function fitsInteger(v: string): string {
  return `(${isInteger(v)} AND TRY_CAST(${v} AS BIGINT) IS NOT NULL)`;
}
function fits(v: string, type: ValueType): string {
  if (type === 'integer') return fitsInteger(v);
  if (type === 'decimal') return isFiniteNumber(v);
  return 'true';
}
/** A value that makes `inferValueType` answer `text`. */
function makesText(v: string): string {
  return `(regexp_matches(${v}, '^[+-]?0[0-9]') OR (${isInteger(v)} AND length(ltrim(${v}, '+-')) > 15) OR (NOT ${isInteger(v)} AND NOT ${isFiniteNumber(v)}))`;
}
/** `codeKey(v)` for a value that is already trimmed. */
function codeKeySql(v: string): string {
  return `CASE WHEN regexp_full_match(${v}, '[0-9]+') THEN CASE WHEN ltrim(${v}, '0') = '' THEN '0' ELSE ltrim(${v}, '0') END ELSE ${v} END`;
}

/**
 * Trimmed non-empty values of a raw column, one per distinct raw value, with the row where that
 * raw value first appears. Two raw values can trim to the same `v` (`9` and ` 9`): the
 * aggregates below do not mind, and whoever needs each `v` once groups again.
 */
function trimmedValues(rawColumn: string, withRow: boolean): string {
  const col = `"${rawColumn.replace(/"/g, '""')}"`;
  const grouped = withRow
    ? `SELECT ${col} AS r, min(file_row_number) AS rn FROM data GROUP BY ${col}`
    : `SELECT ${col} AS r, 0 AS rn FROM data GROUP BY ${col}`;
  return `SELECT * FROM (SELECT ${jsTrimSql('r')} AS v, rn FROM (${grouped})) WHERE v <> ''`;
}

/** Aggregate facts about the values left after a set of exclusions. */
export interface TypeFacts {
  any: boolean;
  makesText: boolean;
  nonInteger: boolean;
  notInteger: boolean;
  notDecimal: boolean;
}

/** `inferValueType` from the facts. */
export function inferredType(facts: TypeFacts): ValueType {
  if (facts.makesText) return 'text';
  if (facts.nonInteger) return 'decimal';
  return facts.any ? 'integer' : 'text';
}

/** `valuesNotFitting(values, type, 1).length === 0` from the facts. */
export function allFit(facts: TypeFacts, type: ValueType): boolean {
  if (type === 'integer') return !facts.notInteger;
  if (type === 'decimal') return !facts.notDecimal;
  return true;
}

function factColumns(keep: string, prefix: string): string[] {
  const agg = (expr: string) => `coalesce(bool_or(${expr}) FILTER (WHERE ${keep}), false)`;
  return [
    `count(*) FILTER (WHERE ${keep}) > 0 AS ${prefix}any`,
    `${agg(makesText('v'))} AS ${prefix}text`,
    `${agg(`NOT ${isInteger('v')}`)} AS ${prefix}nonint`,
    `${agg(`NOT ${fitsInteger('v')}`)} AS ${prefix}notint`,
    `${agg(`NOT ${isFiniteNumber('v')}`)} AS ${prefix}notdec`,
  ];
}

function readFacts(row: unknown[], offset: number): TypeFacts {
  return {
    any: row[offset] === true,
    makesText: row[offset + 1] === true,
    nonInteger: row[offset + 2] === true,
    notInteger: row[offset + 3] === true,
    notDecimal: row[offset + 4] === true,
  };
}

export interface ColumnTypeCheck {
  /** Raw Parquet column (`c0`, `c1`, …). */
  rawColumn: string;
  /** Values left out of `saved`: the column's saved codes of «No especificado» (trimmed). */
  missingCodes: string[];
  /**
   * Codes of the dictionary's «No especificado» categories, as written there; `null` when the
   * column has no dictionary entry. A value is one of them when its `codeKey` matches.
   */
  codebookMissing: string[] | null;
}

export interface ColumnTypeResult {
  /** Without the saved codes. */
  saved: TypeFacts;
  /** Only with a dictionary: without the values that are dictionary «No especificado» codes. */
  codebook: {
    facts: TypeFacts;
    /** Values of the column whose `codeKey` is a dictionary code, in order of appearance. */
    codeValues: string[];
  } | null;
}

/** One query per column; read its single row with `readColumnTypeResult`. */
export function columnTypeQuery(check: ColumnTypeCheck): string {
  const keepSaved =
    check.missingCodes.length > 0 ? `v NOT IN (${sqlList(check.missingCodes)})` : 'true';
  const columns = factColumns(keepSaved, 's_');
  if (check.codebookMissing !== null) {
    const keys = [...new Set(check.codebookMissing.map(codeKey).filter((k) => k !== ''))];
    const isCode = keys.length > 0 ? `(${codeKeySql('v')}) IN (${sqlList(keys)})` : 'false';
    columns.push(...factColumns(`NOT ${isCode}`, 'c_'));
    columns.push(`coalesce(list(v ORDER BY rn) FILTER (WHERE ${isCode}), []) AS c_values`);
    return `SELECT ${columns.join(', ')} FROM (${trimmedValues(check.rawColumn, keys.length > 0)})`;
  }
  return `SELECT ${columns.join(', ')} FROM (${trimmedValues(check.rawColumn, false)})`;
}

export function readColumnTypeResult(check: ColumnTypeCheck, row: unknown[]): ColumnTypeResult {
  return {
    saved: readFacts(row, 0),
    codebook:
      check.codebookMissing === null
        ? null
        : {
            facts: readFacts(row, 5),
            // Ordered by first appearance; the first of each value is where it first appears.
            codeValues: [...new Set((row[10] as unknown[]).map(String))],
          },
  };
}

export interface ValueFactsCheck {
  rawColumn: string;
  /** Trimmed codes of «No especificado»: those values are missing. */
  missingCodes: string[];
  /** Recoding applied to the other values: trimmed source value → code. */
  valueMap: Map<string, string>;
}

/**
 * Facts for `inferValueType(sourceColumnValues(rows, column, codes, valueMap))`: the column's
 * values as the export gives them. Without a recoding it is `columnTypeQuery` (same query, so it
 * shares its stored result). Read its single row with `readValueFacts`.
 */
export function valueFactsQuery(check: ValueFactsCheck): string {
  if (check.valueMap.size === 0) {
    return columnTypeQuery({
      rawColumn: check.rawColumn,
      missingCodes: check.missingCodes,
      codebookMissing: null,
    });
  }
  const keep =
    check.missingCodes.length > 0 ? `WHERE v NOT IN (${sqlList(check.missingCodes)})` : '';
  const recoded = `SELECT ${jsTrimSql('coalesce(m.dst, t.v)')} AS v FROM (SELECT * FROM (${trimmedValues(check.rawColumn, false)}) ${keep}) t LEFT JOIN (VALUES ${[
    ...check.valueMap,
  ]
    .map(([src, dst]) => `(${sqlString(src)}, ${sqlString(dst)})`)
    .join(', ')}) m(src, dst) ON m.src = t.v`;
  return `SELECT ${factColumns('true', 's_').join(', ')} FROM (${recoded}) WHERE v <> ''`;
}

export function readValueFacts(row: unknown[]): TypeFacts {
  return readFacts(row, 0);
}

/** The facts of several sets of values put together (`inferValueType` over all of them). */
export function mergeFacts(all: TypeFacts[]): TypeFacts {
  return {
    any: all.some((f) => f.any),
    makesText: all.some((f) => f.makesText),
    nonInteger: all.some((f) => f.nonInteger),
    notInteger: all.some((f) => f.notInteger),
    notDecimal: all.some((f) => f.notDecimal),
  };
}

export interface NotFittingCheck {
  rawColumn: string;
  type: ValueType;
  /** Trimmed codes of «No especificado»: those values are missing, not checked. */
  missingCodes: string[];
  /** Recoding applied before the check: trimmed source value → code. */
  valueMap?: Map<string, string>;
  limit?: number;
}

/**
 * `valuesNotFitting(sourceColumnValues(rows, column, codes, valueMap), type, limit)`: the
 * distinct values (trimmed, after recoding) that do not fit `type`, in order of first
 * appearance. One row per value.
 */
export function notFittingQuery(check: NotFittingCheck): string {
  const limit = Math.max(Math.trunc(check.limit ?? 5), 1);
  const keep =
    check.missingCodes.length > 0 ? `WHERE v NOT IN (${sqlList(check.missingCodes)})` : '';
  const entries = [...(check.valueMap ?? new Map<string, string>())];
  const mapped =
    entries.length > 0
      ? `SELECT ${jsTrimSql('coalesce(m.dst, t.v)')} AS x, t.rn FROM (SELECT * FROM (${trimmedValues(check.rawColumn, true)}) ${keep}) t LEFT JOIN (VALUES ${entries
          .map(([src, dst]) => `(${sqlString(src)}, ${sqlString(dst)})`)
          .join(', ')}) m(src, dst) ON m.src = t.v`
      : `SELECT v AS x, rn FROM (${trimmedValues(check.rawColumn, true)}) ${keep}`;
  return `SELECT x FROM (${mapped}) WHERE x <> '' AND NOT ${fits('x', check.type)} GROUP BY x ORDER BY min(rn) LIMIT ${limit}`;
}

export function readNotFitting(rows: unknown[][]): string[] {
  return rows.map((r) => String(r[0]));
}
