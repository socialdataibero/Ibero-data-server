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

/** Motivo por el que el nombre no es válido, o `null` si cumple las reglas. */
export function canonicalNameProblem(name: string): string | null {
  if (name.length < CANONICAL_NAME_MIN || name.length > CANONICAL_NAME_MAX) {
    return `debe tener entre ${CANONICAL_NAME_MIN} y ${CANONICAL_NAME_MAX} caracteres`;
  }
  if (!STARTS_WITH_LETTER.test(name)) {
    return 'debe empezar con una letra sin acento';
  }
  if (!IDENTIFIER.test(name)) {
    return 'solo puede tener letras sin acento, números y guion bajo (_), sin espacios';
  }
  return null;
}

/** Los nombres no distinguen mayúsculas: DuckDB trata `edad` y `EDAD` como la misma columna. */
export function sameCanonicalName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
