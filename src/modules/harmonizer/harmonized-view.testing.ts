import {
  PLAIN_NUMBER,
  type ColumnValues,
  type RawData,
  type ValueType,
} from './harmonized-view.js';

/**
 * For specs only: the harmonized view and the type rules written in JavaScript, as the server
 * ran them before the paged views moved to SQL (refactor R4). They are the reference the specs
 * compare the SQL with: `harmonized-export.ts` (the cell value) and `column-checks.ts` (types).
 * Nothing outside the specs imports this file, and it is left out of the build.
 */

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
  /** Columnas de origen que conservan sus códigos de no especificado (variables de códigos). */
  keepMissingCodes?: Set<string>;
  /** Recodificación por columna de origen: valor recortado → código común. */
  valueMaps?: Map<string, Map<string, string>>;
  rows: RawData[];
  /** Filas del archivo antes de `rows[0]`, cuando `rows` es una página. */
  rowOffset?: number;
}

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
export function inferValueType(
  values: Iterable<string | number | null>,
): ValueType {
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

/**
 * Resumen de los valores de una columna de origen para mostrarlos al mapear. Los valores
 * se recortan y se cuentan tal como vienen, sin quitar los códigos de no especificado.
 * Para acotar la memoria se cuentan como mucho `maxDistinct` valores distintos; los que
 * aparecen después no entran al resumen.
 */
export function columnValues(
  rows: RawData[],
  column: string,
  limit = 5,
  maxDistinct = 1000,
): ColumnValues {
  const counts = new Map<string, number>();
  let empty = 0;
  let distinctCapped = false;
  for (const raw of rows) {
    const value = (raw[column] ?? '').trim();
    if (value === '') {
      empty++;
      continue;
    }
    const count = counts.get(value);
    if (count !== undefined) counts.set(value, count + 1);
    else if (counts.size < maxDistinct) counts.set(value, 1);
    else distinctCapped = true;
  }
  // `sort` es estable: los empates conservan el orden de aparición del Map.
  const top = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
  return { top, distinct: counts.size, distinctCapped, empty };
}

/** Valores de una columna de origen ya con los faltantes como `null` y recodificados. */
export function sourceColumnValues(
  rows: RawData[],
  column: string,
  codes: Set<string> | undefined,
  valueMap?: Map<string, string>,
): (string | null)[] {
  return rows.map((raw) => cellValue(raw[column], codes, valueMap));
}

/**
 * Valor de una celda en la vista armonizada. Primero los faltantes pasan a `null`: el vacío
 * siempre y el código de no especificado salvo que la columna conserve sus códigos
 * (`keepCodes`); luego, si la columna está recodificada, el valor recortado se cambia por su
 * código común (también un código conservado). Los valores sin recodificación quedan tal cual.
 */
function cellValue(
  value: string | undefined,
  codes: Set<string> | undefined,
  valueMap?: Map<string, string>,
  keepCodes = false,
): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || (!keepCodes && codes?.has(trimmed))) return null;
  return valueMap?.get(trimmed) ?? value ?? null;
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
        row[canon] = cellValue(
          raw[col],
          edition.missingCodes?.get(col),
          edition.valueMaps?.get(col),
          edition.keepMissingCodes?.has(col) ?? false,
        );
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
      row['_row'] = (edition.rowOffset ?? 0) + i + 1;
      rows.push(row);
    });
  }

  return { headers: wanted, rows };
}
