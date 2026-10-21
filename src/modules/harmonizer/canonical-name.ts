/**
 * Reglas del nombre de una variable canónica (report H-20 / SDI-67). El nombre es la
 * columna de la vista armonizada y del Parquet que se analiza con DuckDB, así que debe
 * servir como identificador sin comillas: empieza con letra y solo lleva letras sin acento,
 * dígitos y `_`. Eso también deja fuera las columnas de origen `_dataset`, `_year` y `_row`.
 */
export const CANONICAL_NAME_MIN = 2;
export const CANONICAL_NAME_MAX = 64;

const STARTS_WITH_LETTER = /^[A-Za-z]/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export type CanonicalNameProblem = 'length' | 'start' | 'chars';

export const CANONICAL_NAME_PROBLEM_TEXT: Record<CanonicalNameProblem, string> = {
  length: `it must be between ${CANONICAL_NAME_MIN} and ${CANONICAL_NAME_MAX} characters long`,
  start: 'it must start with an unaccented letter',
  chars: 'it can only contain unaccented letters, digits and underscores (_), without spaces',
};

/** Why the name is not valid, or `null` if it follows the rules. */
export function canonicalNameProblem(name: string): CanonicalNameProblem | null {
  if (name.length < CANONICAL_NAME_MIN || name.length > CANONICAL_NAME_MAX) return 'length';
  if (!STARTS_WITH_LETTER.test(name)) return 'start';
  if (!IDENTIFIER.test(name)) return 'chars';
  return null;
}

/** Los nombres no distinguen mayúsculas: DuckDB trata `edad` y `EDAD` como la misma columna. */
export function sameCanonicalName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
