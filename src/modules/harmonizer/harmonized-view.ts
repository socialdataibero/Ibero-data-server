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

/** Tipo de una variable canónica en el Parquet exportado. El CSV siempre es texto. */
export type ValueType = 'text' | 'integer' | 'decimal';
export const VALUE_TYPES: readonly ValueType[] = ['text', 'integer', 'decimal'];

const INTEGER = /^[+-]?\d+$/;
const LEADING_ZERO = /^[+-]?0\d/;
// Más de 15 dígitos suele ser un identificador (folio, CURP numérica), no una cantidad.
const MAX_INFERRED_INTEGER_DIGITS = 15;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// `1e309` tiene forma de número pero desborda DOUBLE: DuckDB lo convertiría en Infinity.
function isFiniteNumber(value: string): boolean {
  return PLAIN_NUMBER.test(value) && Number.isFinite(Number(value));
}

function fitsType(value: string, type: ValueType): boolean {
  if (type === 'text') return true;
  if (type === 'decimal') return isFiniteNumber(value);
  if (!INTEGER.test(value)) return false;
  const n = BigInt(value);
  return n >= INT64_MIN && n <= INT64_MAX;
}

/**
 * Tipo sugerido para una columna a partir de sus valores no faltantes. Es número solo
 * si todos los valores lo son. Un cero inicial (`01`, clave de entidad) la deja como
 * texto para no perderlo. Una columna sin valores también queda como texto.
 */
export function inferValueType(values: Iterable<string | number | null>): ValueType {
  let type: ValueType | null = null;
  for (const raw of values) {
    if (raw === null) continue;
    const value = String(raw).trim();
    if (value === '') continue;
    if (LEADING_ZERO.test(value)) return 'text';
    if (INTEGER.test(value)) {
      if (value.replace(/^[+-]/, '').length > MAX_INFERRED_INTEGER_DIGITS)
        return 'text';
      type ??= 'integer';
    } else if (isFiniteNumber(value)) {
      type = 'decimal';
    } else {
      return 'text';
    }
  }
  return type ?? 'text';
}

/** Valores distintos (recortados, en orden de aparición) que no caben en `type`. */
export function valuesNotFitting(
  values: Iterable<string | number | null>,
  type: ValueType,
  limit = 5,
): string[] {
  const bad = new Set<string>();
  if (type === 'text') return [];
  for (const raw of values) {
    if (raw === null) continue;
    const value = String(raw).trim();
    if (value === '' || fitsType(value, type)) continue;
    bad.add(value);
    if (bad.size >= limit) break;
  }
  return [...bad];
}

/** Valores de una columna de origen ya con los faltantes como `null`. */
export function sourceColumnValues(
  rows: RawData[],
  column: string,
  codes: Set<string> | undefined,
): (string | null)[] {
  return rows.map((raw) => cellValue(raw[column], codes));
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
