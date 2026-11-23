import { keptMissingCodes, type ExportColumn } from '../harmonized-export.js';

/**
 * A row of a JSON view; `null` is a missing value: an empty cell or only spaces («no aplica»),
 * or a missing code of a column that does not keep its codes.
 */
export type ViewRow = Record<string, string | number | null>;

export interface View {
  headers: string[];
  rows: ViewRow[];
  /**
   * Parallel to `rows`: the headers whose value in that row is a «No especificado» code kept by
   * its column (variables of codes, F2), so the screen can tell it from a valid answer.
   */
  notSpecified: string[][];
}

/**
 * The rows that `editionPageSql` read, as objects: one key per column of the view, in the order
 * of `columns`. The first value of each row is `_ibero_rn`, which the JSON view does not show.
 */
export function pageRows(
  columns: ExportColumn[],
  rows: unknown[][],
): ViewRow[] {
  return rows.map((r) =>
    Object.fromEntries(
      columns.map((c, i) => [c.canon, r[i + 1] as string | null]),
    ),
  );
}

/** For each row, the columns whose value is one of their kept «No especificado» codes. */
function notSpecifiedOf(columns: ExportColumn[]) {
  const kept = columns
    .map((c) => ({ canon: c.canon, codes: new Set(keptMissingCodes(c)) }))
    .filter((c) => c.codes.size > 0);
  return (row: ViewRow): string[] =>
    kept
      .filter((c) => {
        const value = row[c.canon];
        return typeof value === 'string' && c.codes.has(value.trim());
      })
      .map((c) => c.canon);
}

/** The view of one edition: its columns, and the rows of the page. */
export function editionView(columns: ExportColumn[], rows: ViewRow[]): View {
  if (columns.length === 0) return { headers: [], rows: [], notSpecified: [] };
  return {
    headers: columns.map((c) => c.canon),
    rows,
    notSpecified: rows.map(notSpecifiedOf(columns)),
  };
}

/** One edition's page in the survey view. */
export interface SurveyViewPage {
  name: string;
  year: number;
  /** Rows of the file before the first row of `rows`. */
  rowOffset: number;
  /** The edition's columns for the requested variables. */
  columns: ExportColumn[];
  rows: ViewRow[];
}

/**
 * The survey view: the requested variables (`wanted`) as headers, and the pages of the editions
 * stacked in order. Each row has the variables its edition has (the others are left out, not
 * `null`) followed by `_dataset`, `_year` and `_row`, the record number in its file (from 1), so
 * `_dataset` + `_row` identify a row even if the file repeats or lacks an id (H-05). A row that
 * gives none of the requested variables is left out. Each edition marks its own kept codes: `9`
 * can be «No especificado» in one edition and a valid value in another.
 */
export function surveyView(pages: SurveyViewPage[], wanted: string[]): View {
  if (wanted.length === 0) return { headers: [], rows: [], notSpecified: [] };
  const rows: ViewRow[] = [];
  const notSpecified: string[][] = [];
  for (const page of pages) {
    const present = new Set(page.columns.map((c) => c.canon));
    const marks = notSpecifiedOf(page.columns);
    page.rows.forEach((r, i) => {
      const row: ViewRow = {};
      for (const h of wanted) {
        if (present.has(h)) row[h] = r[h] ?? null;
      }
      if (Object.keys(row).length === 0) return;
      row['_dataset'] = page.name;
      row['_year'] = page.year;
      row['_row'] = page.rowOffset + i + 1;
      rows.push(row);
      notSpecified.push(marks(r));
    });
  }
  return { headers: wanted, rows, notSpecified };
}
