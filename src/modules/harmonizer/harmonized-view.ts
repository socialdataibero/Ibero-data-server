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

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Evita que Excel u hojas similares evalúen un texto como fórmula al abrir el CSV (H-12):
 * antepone un apóstrofo a lo que empieza con `=`, `+`, `-`, `@`, tabulador o retorno de carro.
 * Los números simples (`-5`, `+3.2`, `1e-3`) se dejan intactos porque no son fórmulas.
 */
export function neutralizeCsvFormula(value: string): string {
  if (!FORMULA_START.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
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
    view.rows.forEach((r, i) => {
      const row: HarmonizedRow = {};
      for (const h of wanted) {
        if (present.has(h)) row[h] = r[h] ?? null;
      }
      if (Object.keys(row).length === 0) return;
      row['_dataset'] = edition.name;
      row['_year'] = edition.year;
      // Número de registro en el archivo original (1 = primera fila de datos).
      // `_dataset` + `_row` identifica cada fila aunque el archivo no tenga
      // columna identificadora, o la repita entre ediciones (H-05).
      row['_row'] = i + 1;
      rows.push(row);
    });
  }

  return { headers: wanted, rows };
}
