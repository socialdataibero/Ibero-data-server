export type RawData = Record<string, string>;
/** `null` es un valor faltante: celda vacía, solo espacios o código de no especificado. */
export type HarmonizedRow = Record<string, string | number | null>;

export interface HarmonizedView {
  headers: string[];
  rows: HarmonizedRow[];
}

export interface DatasetEdition {
  name: string;
  year: number;
  columns: string[];
  columnToCanonical: Map<string, string>;
  /** Códigos de no especificado por columna de origen. */
  missingCodes?: Map<string, Set<string>>;
  rows: RawData[];
}

function cellValue(
  value: string | undefined,
  codes: Set<string> | undefined,
): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || codes?.has(trimmed)) return null;
  return value ?? null;
}

export function buildDatasetView(edition: DatasetEdition): HarmonizedView {
  if (edition.columnToCanonical.size === 0) {
    return { headers: [], rows: [] };
  }

  const headers: string[] = [];
  for (const col of edition.columns) {
    const canon = edition.columnToCanonical.get(col);
    if (canon && !headers.includes(canon)) headers.push(canon);
  }

  const rows = edition.rows.map((raw) => {
    const row: HarmonizedRow = {};
    for (const col of edition.columns) {
      const canon = edition.columnToCanonical.get(col);
      if (canon)
        row[canon] = cellValue(raw[col], edition.missingCodes?.get(col));
    }
    return row;
  });

  return { headers, rows };
}

export function buildSurveyView(
  editions: DatasetEdition[],
  wanted: string[],
): HarmonizedView {
  if (wanted.length === 0) {
    return { headers: [], rows: [] };
  }

  const rows: HarmonizedRow[] = [];
  for (const edition of editions) {
    const view = buildDatasetView(edition);
    const present = new Set(view.headers);
    for (const r of view.rows) {
      const row: HarmonizedRow = {};
      for (const h of wanted) {
        if (present.has(h)) row[h] = r[h] ?? null;
      }
      if (Object.keys(row).length === 0) continue;
      row['_dataset'] = edition.name;
      row['_year'] = edition.year;
      rows.push(row);
    }
  }

  return { headers: wanted, rows };
}
