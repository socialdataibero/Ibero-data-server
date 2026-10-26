import { describe, expect, it } from 'vitest';
import { utils, write } from 'xlsx';
import {
  CodebookError,
  categoryLabel,
  codeKey,
  codebookMissingCodes,
  normalizeLabel,
  parseCodebookCsv,
  parseCodebookWorkbook,
} from './codebook.js';

/** Libro con una hoja por tabla, a partir de filas como las del descriptor del INEGI. */
function workbook(sheets: Record<string, unknown[][]>, bookType: 'xlsx' | 'xls' = 'xlsx'): Buffer {
  const wb = utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), name);
  }
  return write(wb, { type: 'buffer', bookType }) as Buffer;
}

// Como el descriptor de 2010: sin columna «Tipo», sección en «Descripción», códigos como número.
const INEGI_2010 = [
  [null, 'CENSO DE POBLACIÓN Y VIVIENDA 2010'],
  [null, 'Cons.', 'Descripción', 'Mnemónico', 'Pregunta y categoría', 'Rango Válido', 'Longitud'],
  [],
  [null, null, 'IDENTIFICACIÓN GEOGRÁFICA'],
  [null, 1, 'Entidad Federativa', 'ENT', null, '{01..32}', 2],
  [null, 2, 'Localidad', 'LOC50K', 'Clave de la localidad', '{0000..9999}', 4],
  [null, null, null, null, 'Localidad de 50 000 y más habitantes', '{0001..9999}'],
  [null, null, null, null, 'Localidad menor de 50 000 habitantes', '0000'],
  [null, null, null, null, null, null, 206],
  [null, null, 'VARIABLES DE VIVIENDA'],
  [null, 3, 'Clase de vivienda particular', 'CLAVIVP', 'Clase de vivienda particular', '{1..7,9,b}', 1],
  [null, null, null, null, 'Casa independiente', 1],
  [null, null, null, null, 'Departamento en edificio', 2],
  [null, null, null, null, 'No especificado', 9],
  [null, null, null, null, 'Blanco por pase', 'b'],
  [null, 4, 'Entidad de nacimiento', 'LNACEDO_C', '¿En qué estado nació?', 'Ver catálogo', 3],
  [null, null, null, null, 'Descripción por catálogo', 'Tc_Entidad_2010'],
  [null, null, null, null, 'No especificado', 999],
];

// Como el de 2020: con «Tipo», sección en «Cons.» y «Nulo» en lugar de `b`.
const INEGI_2020 = [
  [null, 'TABLA: PERSONAS'],
  [null, 'Cons.', 'Descripción', 'Mnemónico', 'Pregunta y categoría', 'Tipo', 'Rango válido', 'Longitud'],
  [null, 'LISTA DE PERSONAS'],
  [null, 12, 'Sexo', 'SEXO', '(NOMBRE) es hombre:', 'Caracter', '{1,3}', 1],
  [null, null, null, null, 'Hombre', null, 1],
  [null, null, null, null, 'Mujer', null, 3],
  [null, 13, 'Edad', 'EDAD', '¿Cuántos años   cumplidos\ntiene?', 'Numérico', '{0..130,999}', 3],
  [null, null, null, null, 'Menos de un año', null, 0],
  [null, null, null, null, 'Años cumplidos', null, '1..130'],
  [null, null, null, null, 'No especificado', null, 999],
  [null, 14, 'Parentesco', 'PARENTESCO', '¿Qué es de la jefa?', 'Caracter', '{101..713,999,Nulo}', 3],
  [null, null, null, null, 'Blanco por pase', null, 'Nulo'],
];

describe('parseCodebookWorkbook', () => {
  it('reads variables, categories and sections from a 2010-style sheet', () => {
    const { format, variables } = parseCodebookWorkbook(workbook({ VIVIENDAS: INEGI_2010 }, 'xls'));
    expect(format).toBe('inegi');
    expect(variables.map((v) => v.name)).toEqual(['ENT', 'LOC50K', 'CLAVIVP', 'LNACEDO_C']);
    const clavivp = variables[2];
    expect(clavivp).toMatchObject({
      table: 'VIVIENDAS',
      label: 'Clase de vivienda particular',
      section: 'VARIABLES DE VIVIENDA',
      declaredType: null,
      validRange: '{1..7,9,b}',
      length: 1,
    });
    // Los códigos que Excel guarda como número se leen como texto, sin `.0`.
    expect(clavivp.categories).toEqual([
      { code: '1', label: 'Casa independiente', kind: 'value' },
      { code: '2', label: 'Departamento en edificio', kind: 'value' },
      { code: '9', label: 'No especificado', kind: 'missing' },
      { code: '', label: 'Blanco por pase', kind: 'blank' },
    ]);
    expect(variables[1].categories.map((c) => c.kind)).toEqual(['range', 'value']);
    expect(variables[0].section).toBe('IDENTIFICACIÓN GEOGRÁFICA');
    expect(variables[3].categories.map((c) => c.kind)).toEqual(['catalog', 'missing']);
  });

  it('reads the declared type and collapses whitespace in a 2020-style sheet', () => {
    const { variables } = parseCodebookWorkbook(workbook({ PERSONAS: INEGI_2020 }));
    expect(variables.map((v) => [v.name, v.declaredType, v.section])).toEqual([
      ['SEXO', 'text', 'LISTA DE PERSONAS'],
      ['EDAD', 'integer', 'LISTA DE PERSONAS'],
      ['PARENTESCO', 'text', 'LISTA DE PERSONAS'],
    ]);
    expect(variables[1].question).toBe('¿Cuántos años cumplidos tiene?');
    expect(variables[1].categories).toEqual([
      { code: '0', label: 'Menos de un año', kind: 'value' },
      { code: '1..130', label: 'Años cumplidos', kind: 'range' },
      { code: '999', label: 'No especificado', kind: 'missing' },
    ]);
    expect(variables[2].categories).toEqual([{ code: '', label: 'Blanco por pase', kind: 'blank' }]);
  });

  it('keeps one table per sheet and skips sheets without a "Mnemónico" column', () => {
    const { variables } = parseCodebookWorkbook(
      workbook({ VIVIENDAS: INEGI_2010, PERSONAS: INEGI_2020, 'Modelo de datos': [['ENT C(2)']] }),
    );
    expect([...new Set(variables.map((v) => v.table))]).toEqual(['VIVIENDAS', 'PERSONAS']);
  });

  it('rejects a workbook with no dictionary sheet and a file that is not a workbook', () => {
    expect(() => parseCodebookWorkbook(workbook({ Hoja1: [['a', 'b'], [1, 2]] }))).toThrow(
      expect.objectContaining({ problem: 'no_dictionary' }),
    );
    expect(() => parseCodebookWorkbook(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]))).toThrow(CodebookError);
  });
});

describe('parseCodebookCsv', () => {
  it('reads one row per variable or category, with the first row giving the metadata', () => {
    const csv = [
      'Variable,Descripción,Tipo,Código,Etiqueta,Faltante',
      'sexo,Sexo,texto,1,Hombre,',
      'sexo,,,2,Mujer,',
      'sexo,,,9,No especificado,sí',
      'edad,Edad,entero,,,',
      'edad,,,0..130,Años cumplidos,',
    ].join('\n');
    const { format, variables } = parseCodebookCsv(csv);
    expect(format).toBe('csv');
    expect(variables).toHaveLength(2);
    expect(variables[0]).toMatchObject({ table: '', name: 'sexo', label: 'Sexo', declaredType: 'text' });
    expect(variables[0].categories).toEqual([
      { code: '1', label: 'Hombre', kind: 'value' },
      { code: '2', label: 'Mujer', kind: 'value' },
      { code: '9', label: 'No especificado', kind: 'missing' },
    ]);
    expect(variables[1]).toMatchObject({ declaredType: 'integer', categories: [{ kind: 'range' }] });
  });

  it('keeps variables of different tables apart', () => {
    const { variables } = parseCodebookCsv('tabla,variable\nVIV,ENT\nPER,ENT\n');
    expect(variables.map((v) => `${v.table}.${v.name}`)).toEqual(['VIV.ENT', 'PER.ENT']);
  });

  it('rejects a CSV without a variable column or with an unknown type', () => {
    expect(() => parseCodebookCsv('nombre,descripcion\nx,y\n')).toThrow(
      expect.objectContaining({ problem: 'missing_variable_column' }),
    );
    expect(() => parseCodebookCsv('variable,tipo\nx,fecha\n')).toThrow(
      expect.objectContaining({ problem: 'bad_type', params: { line: 2, value: 'fecha' } }),
    );
    expect(() => parseCodebookCsv('variable\n')).toThrow(expect.objectContaining({ problem: 'empty' }));
  });
});

describe('code helpers', () => {
  it('compares numeric codes without leading zeros and labels without accents or case', () => {
    expect(codeKey('040')).toBe('40');
    expect(codeKey('0')).toBe('0');
    expect(codeKey('000')).toBe('0');
    expect(codeKey(' H ')).toBe('H');
    expect(normalizeLabel('  Vivienda  en cuarto de azotea (de un edificio) ')).toBe(
      'vivienda en cuarto de azotea de un edificio',
    );
    expect(normalizeLabel('Categoría')).toBe('categoria');
  });

  it('finds the data spelling of the "No especificado" codes', () => {
    const categories = [
      { code: '1', label: 'Sí', kind: 'value' as const },
      { code: '9', label: 'No especificado', kind: 'missing' as const },
      { code: '99', label: 'No especificado (otro)', kind: 'missing' as const },
    ];
    // `9` está en los datos como `09`; `99` no aparece y se usa como lo escribe el diccionario.
    expect(codebookMissingCodes(categories, ['01', '09'])).toEqual(['09', '99']);
    expect(categoryLabel(categories, '01')).toBe('Sí');
    expect(categoryLabel(categories, '5')).toBeNull();
  });
});
