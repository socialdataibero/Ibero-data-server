/**
 * Diccionarios de variables (descriptores) para el armonizador: qué significa cada columna de un
 * archivo y cada código de sus categorías. Se leen dos formatos:
 *
 * - El descriptor del INEGI (`.xls` o `.xlsx`), una hoja por tabla (VIVIENDAS, PERSONAS…) con las
 *   columnas «Descripción», «Mnemónico», «Pregunta y categoría», «Rango válido», «Longitud» y, desde
 *   2020, «Tipo». Cada variable ocupa una fila y sus categorías van en las filas siguientes.
 * - La plantilla CSV de la plataforma, para encuestas que no son del INEGI o descriptores en PDF.
 */
import { parse } from 'csv-parse/sync';
import { read, utils } from 'xlsx';
import type { ValueType } from './harmonized-view.js';

/**
 * - `value`: una categoría con su código (`1` = Hombre).
 * - `missing`: «No especificado»; sus códigos se proponen como no especificado al mapear.
 * - `blank`: «Blanco por pase» (la pregunta no aplicaba); en los datos es una celda vacía.
 * - `range`: un rango (`1..130` = Años cumplidos), no un código.
 * - `catalog`: los códigos vienen de un catálogo externo que no está en el descriptor.
 */
export type CategoryKind = 'value' | 'missing' | 'blank' | 'range' | 'catalog';

export interface CodebookCategory {
  code: string;
  label: string;
  kind: CategoryKind;
}

export interface CodebookVariableInput {
  table: string;
  position: number;
  name: string;
  label: string | null;
  question: string | null;
  section: string | null;
  declaredType: ValueType | null;
  validRange: string | null;
  length: number | null;
  categories: CodebookCategory[];
}

export interface ParsedCodebook {
  format: 'inegi' | 'csv';
  variables: CodebookVariableInput[];
}

export type CodebookProblem =
  | 'unreadable'
  | 'no_dictionary'
  | 'missing_variable_column'
  | 'bad_type'
  | 'empty';

export class CodebookError extends Error {
  constructor(
    readonly problem: CodebookProblem,
    message: string,
    readonly params: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const COMBINING_MARKS = /\p{M}/gu;

/** Texto para comparar etiquetas y encabezados: sin acentos, en minúsculas y con un solo espacio. */
export function normalizeLabel(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Clave para comparar un código del diccionario con un valor de los datos: los códigos numéricos se
 * comparan sin ceros a la izquierda (`01`, `1` y `001` son el mismo código), los demás tal cual.
 */
export function codeKey(value: string): string {
  const v = value.trim();
  return /^\d+$/.test(v) ? v.replace(/^0+(?=\d)/, '') : v;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Texto de una celda. Un código guardado como número en Excel (`99`) se lee como `"99"`. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  return collapse(String(value));
}

function categoryKind(code: string, label: string, variableRange: string): CategoryKind {
  const normalizedLabel = normalizeLabel(label);
  const lowerCode = code.toLowerCase();
  if (lowerCode === 'b' || lowerCode === 'nulo' || normalizedLabel.startsWith('blanco por pase')) {
    return 'blank';
  }
  if (normalizedLabel.startsWith('no especificado')) return 'missing';
  if (code.includes('..')) return 'range';
  if (
    /^tc_/i.test(code) ||
    normalizedLabel.startsWith('descripcion por catalogo') ||
    (normalizeLabel(variableRange).includes('catalogo') && !/^\d+$/.test(code))
  ) {
    return 'catalog';
  }
  return 'value';
}

const DECLARED_TYPE: Record<string, ValueType> = {
  caracter: 'text',
  texto: 'text',
  text: 'text',
  numerico: 'integer',
  entero: 'integer',
  integer: 'integer',
  decimal: 'decimal',
};

/** Columna de cada dato en la fila de encabezado de una hoja del descriptor del INEGI. */
interface InegiHeader {
  row: number;
  description: number;
  name: number;
  question: number;
  type: number;
  range: number;
  length: number;
}

function findInegiHeader(rows: unknown[][]): InegiHeader | null {
  for (let r = 0; r < Math.min(rows.length, 50); r++) {
    const cells = (rows[r] ?? []).map((c) => normalizeLabel(cellText(c)));
    const name = cells.indexOf('mnemonico');
    if (name < 0) continue;
    const find = (prefix: string) => cells.findIndex((c) => c.startsWith(prefix));
    return {
      row: r,
      description: find('descripcion'),
      name,
      question: find('pregunta'),
      type: cells.indexOf('tipo'),
      range: find('rango'),
      length: find('longitud'),
    };
  }
  return null;
}

function parseInegiSheet(table: string, rows: unknown[][]): CodebookVariableInput[] {
  const header = findInegiHeader(rows);
  if (!header) return [];
  const at = (row: unknown[], index: number) => (index < 0 ? '' : cellText(row[index]));

  const variables: CodebookVariableInput[] = [];
  const seen = new Set<string>();
  let current: CodebookVariableInput | null = null;
  let section: string | null = null;

  for (let r = header.row + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const name = at(row, header.name);
    const description = at(row, header.description);
    const question = at(row, header.question);
    const range = at(row, header.range);

    if (name) {
      const lengthText = at(row, header.length);
      const length = /^\d+$/.test(lengthText) ? Number(lengthText) : null;
      current = {
        table,
        position: variables.length,
        name,
        label: description || null,
        question: question || null,
        section,
        declaredType: DECLARED_TYPE[normalizeLabel(at(row, header.type))] ?? null,
        validRange: range || null,
        length,
        categories: [],
      };
      // Un mnemónico repetido en la misma hoja se ignora: el primero manda.
      if (!seen.has(name)) {
        seen.add(name);
        variables.push(current);
      }
      continue;
    }

    // Fila de categoría: texto en «Pregunta y categoría» y código en «Rango válido».
    if (current && question && range) {
      const kind = categoryKind(range, question, current.validRange ?? '');
      current.categories.push({ code: kind === 'blank' ? '' : range, label: question, kind });
      continue;
    }

    // Título de sección (IDENTIFICACIÓN GEOGRÁFICA…): un texto sin código. Las filas de sumas
    // de «Longitud» solo traen un número y se saltan.
    const title = row
      .map((c) => cellText(c))
      .find((text) => text !== '' && !/^[\d.=]/.test(text));
    if (title && !range && !question) {
      section = title;
      current = null;
    }
  }
  return variables;
}

/** Lee un descriptor del INEGI (`.xls` o `.xlsx`). Las hojas sin columna «Mnemónico» se ignoran. */
export function parseCodebookWorkbook(buffer: Buffer): ParsedCodebook {
  let workbook;
  try {
    workbook = read(buffer, {
      type: 'buffer',
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellDates: false,
    });
  } catch {
    throw new CodebookError('unreadable', 'The file could not be read as an Excel workbook.');
  }
  const variables: CodebookVariableInput[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    variables.push(...parseInegiSheet(sheetName.trim(), rows));
  }
  if (variables.length === 0) {
    throw new CodebookError(
      'no_dictionary',
      'No sheet of the workbook has a "Mnemónico" column, so no variable could be read.',
    );
  }
  return { format: 'inegi', variables };
}

/** Columnas de la plantilla CSV, por su encabezado sin acentos ni mayúsculas. */
const CSV_COLUMNS = {
  tabla: 'table',
  variable: 'variable',
  descripcion: 'label',
  pregunta: 'question',
  seccion: 'section',
  tipo: 'type',
  codigo: 'code',
  etiqueta: 'codeLabel',
  faltante: 'missing',
} as const;
type CsvField = (typeof CSV_COLUMNS)[keyof typeof CSV_COLUMNS];

export const CODEBOOK_CSV_HEADER = Object.keys(CSV_COLUMNS);

const YES = new Set(['si', 'yes', 'x', '1', 'true', 'verdadero']);

/**
 * Lee la plantilla CSV. Cada fila es una variable o una categoría de ella: la primera fila de cada
 * variable da su descripción y su tipo, y cada fila con `codigo` o `etiqueta` agrega una categoría.
 */
export function parseCodebookCsv(text: string): ParsedCodebook {
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as string[][];
  } catch {
    throw new CodebookError('unreadable', 'The file could not be read as CSV.');
  }
  const [headerRow, ...rows] = records;
  if (!headerRow) throw new CodebookError('empty', 'The file is empty.');

  const index = new Map<CsvField, number>();
  headerRow.forEach((h, i) => {
    const field = CSV_COLUMNS[normalizeLabel(h).replace(/ /g, '_') as keyof typeof CSV_COLUMNS];
    if (field && !index.has(field)) index.set(field, i);
  });
  if (!index.has('variable')) {
    throw new CodebookError(
      'missing_variable_column',
      `The CSV has no "variable" column. Expected columns: ${CODEBOOK_CSV_HEADER.join(', ')}.`,
    );
  }
  const at = (row: string[], field: CsvField) => {
    const i = index.get(field);
    return i === undefined ? '' : collapse(row[i] ?? '');
  };

  const byKey = new Map<string, CodebookVariableInput>();
  const variables: CodebookVariableInput[] = [];
  rows.forEach((row, i) => {
    const line = i + 2;
    const name = at(row, 'variable');
    if (!name) return;
    const table = at(row, 'table');
    const typeText = at(row, 'type');
    let declaredType: ValueType | null = null;
    if (typeText) {
      declaredType = DECLARED_TYPE[normalizeLabel(typeText)] ?? null;
      if (!declaredType) {
        throw new CodebookError(
          'bad_type',
          `Line ${line}: type "${typeText}" is not valid. Use texto, entero or decimal.`,
          { line, value: typeText },
        );
      }
    }
    const key = `${table}\u0000${name}`;
    let variable = byKey.get(key);
    if (!variable) {
      variable = {
        table,
        position: variables.length,
        name,
        label: null,
        question: null,
        section: null,
        declaredType: null,
        validRange: null,
        length: null,
        categories: [],
      };
      byKey.set(key, variable);
      variables.push(variable);
    }
    variable.label ??= at(row, 'label') || null;
    variable.question ??= at(row, 'question') || null;
    variable.section ??= at(row, 'section') || null;
    variable.declaredType ??= declaredType;

    const code = at(row, 'code');
    const codeLabel = at(row, 'codeLabel');
    if (code || codeLabel) {
      const kind: CategoryKind = YES.has(normalizeLabel(at(row, 'missing')))
        ? 'missing'
        : code.includes('..')
          ? 'range'
          : code === ''
            ? 'blank'
            : 'value';
      variable.categories.push({ code, label: codeLabel, kind });
    }
  });
  if (variables.length === 0) {
    throw new CodebookError('empty', 'The CSV has no variables.');
  }
  return { format: 'csv', variables };
}

/** Variable del diccionario como la ve el mapeo: solo lo necesario para describir una columna. */
export interface CodebookVariableInfo {
  name: string;
  label: string | null;
  question: string | null;
  section: string | null;
  declaredType: ValueType | null;
  categories: CodebookCategory[];
}

/**
 * Valores de los datos que corresponden a los códigos de «No especificado» del diccionario. Un
 * código se busca por `codeKey`, así que `99` encuentra `099` si los datos tienen ceros a la
 * izquierda. Si un código no aparece en los datos, se usa tal como lo escribe el diccionario.
 */
export function codebookMissingCodes(
  categories: CodebookCategory[],
  dataValues: Iterable<string>,
): string[] {
  const byKey = new Map<string, string[]>();
  for (const value of dataValues) {
    const key = codeKey(value);
    byKey.set(key, [...(byKey.get(key) ?? []), value]);
  }
  const codes = new Set<string>();
  for (const category of categories) {
    if (category.kind !== 'missing' || category.code === '') continue;
    const found = byKey.get(codeKey(category.code));
    if (found) found.forEach((v) => codes.add(v));
    else codes.add(category.code);
  }
  return [...codes];
}

/** Etiqueta de un valor de los datos según las categorías del diccionario, o `null`. */
export function categoryLabel(categories: CodebookCategory[], value: string): string | null {
  const key = codeKey(value);
  const match = categories.find(
    (c) => (c.kind === 'value' || c.kind === 'missing') && c.code !== '' && codeKey(c.code) === key,
  );
  return match?.label ?? null;
}
