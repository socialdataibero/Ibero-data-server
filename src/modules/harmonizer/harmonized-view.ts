export type RawData = Record<string, string>;

const FORMULA_START = /^[=+\-@\t\r]/;
export const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

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

export interface ColumnValues {
  /** Los valores más frecuentes; en un empate, el que aparece antes en el archivo. */
  top: { value: string; count: number }[];
  distinct: number;
  /** Hay más valores distintos que `distinct`: se dejó de contar en el tope. */
  distinctCapped: boolean;
  /** Celdas vacías o solo con espacios. */
  empty: number;
}
