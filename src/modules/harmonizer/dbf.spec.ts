import { describe, expect, it } from 'vitest';
import { DbfError, readDbf } from './dbf.js';

interface TestField {
  name: string;
  type: string;
  length: number;
}

/** Arma un DBF dBase III. Cada celda va como bytes ya codificados o texto ASCII. */
function buildDbf(
  fields: TestField[],
  records: { deleted?: boolean; values: (string | Buffer)[] }[],
  opts: { languageDriver?: number; recordCount?: number } = {},
): Buffer {
  const headerLength = 32 + 32 * fields.length + 1;
  const recordLength = 1 + fields.reduce((s, f) => s + f.length, 0);
  const header = Buffer.alloc(headerLength);
  header[0] = 0x03;
  header.writeUInt32LE(opts.recordCount ?? records.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  header[29] = opts.languageDriver ?? 0;
  fields.forEach((f, i) => {
    const pos = 32 + 32 * i;
    header.write(f.name, pos, 'latin1');
    header[pos + 11] = f.type.charCodeAt(0);
    header[pos + 16] = f.length;
  });
  header[headerLength - 1] = 0x0d;
  const body = records.map((r) => {
    const rec = Buffer.alloc(recordLength, 0x20);
    rec[0] = r.deleted ? 0x2a : 0x20;
    let offset = 1;
    fields.forEach((f, i) => {
      const value = r.values[i];
      const bytes = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value, 'latin1');
      // Los números van alineados a la derecha; el resto, a la izquierda.
      const at = f.type === 'N' ? offset + f.length - bytes.length : offset;
      bytes.copy(rec, at);
      offset += f.length;
    });
    return rec;
  });
  return Buffer.concat([header, ...body, Buffer.from([0x1a])]);
}

const cp850 = (bytes: number[]) => Buffer.from(bytes);

describe('readDbf', () => {
  it('lee columnas y valores como texto, sin el relleno de ancho fijo', () => {
    const buf = buildDbf(
      [
        { name: 'ENT', type: 'C', length: 4 },
        { name: 'EDAD', type: 'N', length: 3 },
        { name: 'FECHA', type: 'D', length: 8 },
        { name: 'JEFE', type: 'L', length: 1 },
      ],
      [
        { values: ['01', '7', '20200315', 'T'] },
        { values: [' 9', '', '', '?'] },
      ],
    );
    const table = readDbf(buf);
    expect(table.headers).toEqual(['ENT', 'EDAD', 'FECHA', 'JEFE']);
    // El espacio a la izquierda de un texto es dato y se conserva.
    expect(table.rows).toEqual([
      ['01', '7', '20200315', 'T'],
      [' 9', '', '', '?'],
    ]);
    expect(table.deletedRecords).toBe(0);
  });

  it('salta los registros marcados como borrados y los cuenta', () => {
    const buf = buildDbf(
      [{ name: 'ID', type: 'N', length: 2 }],
      [{ values: ['1'] }, { deleted: true, values: ['2'] }, { values: ['3'] }],
    );
    const table = readDbf(buf);
    expect(table.rows).toEqual([['1'], ['3']]);
    expect(table.deletedRecords).toBe(1);
  });

  it('usa la codificación que indica el encabezado (CP850)', () => {
    // «Peñón» en CP850: ñ = 0xA4, ó = 0xA2.
    const buf = buildDbf(
      [{ name: 'MUN', type: 'C', length: 10 }],
      [{ values: [cp850([0x50, 0x65, 0xa4, 0xa2, 0x6e])] }],
      { languageDriver: 0x02 },
    );
    const table = readDbf(buf);
    expect(table.rows).toEqual([['Peñón']]);
    expect(table).toMatchObject({
      encoding: 'cp850',
      encodingSource: 'header',
    });
  });

  it('sin indicación en el encabezado, distingue CP850 de Windows-1252 por el contenido', () => {
    const fields = [{ name: 'MUN', type: 'C', length: 12 }];
    const dos = readDbf(
      buildDbf(fields, [
        { values: [cp850([0x41, 0x63, 0x61, 0x74, 0xa0, 0x6e])] },
      ]),
    );
    expect(dos.rows).toEqual([['Acatán']]);
    expect(dos).toMatchObject({ encoding: 'cp850', encodingSource: 'content' });

    const win = readDbf(
      buildDbf(fields, [{ values: [Buffer.from('Acatán', 'latin1')] }]),
    );
    expect(win.rows).toEqual([['Acatán']]);
    expect(win).toMatchObject({
      encoding: 'windows-1252',
      encodingSource: 'content',
    });
  });

  it('detecta UTF-8 cuando todo el texto es UTF-8 válido', () => {
    const buf = buildDbf(
      [{ name: 'MUN', type: 'C', length: 12 }],
      [{ values: [Buffer.from('Peñón', 'utf8')] }],
    );
    const table = readDbf(buf);
    expect(table.rows).toEqual([['Peñón']]);
    expect(table).toMatchObject({
      encoding: 'utf-8',
      encodingSource: 'content',
    });
  });

  it('respeta la codificación elegida al subir, aunque el encabezado diga otra', () => {
    const buf = buildDbf(
      [{ name: 'MUN', type: 'C', length: 10 }],
      [{ values: [Buffer.from('Peñón', 'latin1')] }],
      { languageDriver: 0x02 },
    );
    const table = readDbf(buf, 'windows-1252');
    expect(table.rows).toEqual([['Peñón']]);
    expect(table).toMatchObject({
      encoding: 'windows-1252',
      encodingSource: 'user',
    });
  });

  it('rechaza UTF-8 elegido a mano si el texto no es UTF-8, con registro y columna', () => {
    const buf = buildDbf(
      [{ name: 'MUN', type: 'C', length: 10 }],
      [{ values: ['ok'] }, { values: [Buffer.from('Peñón', 'latin1')] }],
    );
    expect(() => readDbf(buf, 'utf-8')).toThrow(/registro 2, columna «MUN»/);
  });

  it('rechaza una columna memo y dice cuál es', () => {
    const buf = buildDbf(
      [
        { name: 'ID', type: 'N', length: 2 },
        { name: 'NOTAS', type: 'M', length: 10 },
      ],
      [{ values: ['1', '1'] }],
    );
    const err = (() => {
      try {
        readDbf(buf);
      } catch (e) {
        return e as DbfError;
      }
    })();
    expect(err).toBeInstanceOf(DbfError);
    expect(err?.code).toBe('dbf_field_unsupported');
    expect(err?.message).toMatch(/«NOTAS» es de tipo memo/);
  });

  it('rechaza un archivo truncado', () => {
    const buf = buildDbf(
      [{ name: 'ID', type: 'N', length: 2 }],
      [{ values: ['1'] }, { values: ['2'] }],
      { recordCount: 5 },
    );
    expect(() => readDbf(buf)).toThrow(
      /anuncia 5 registros y el archivo solo trae 2/,
    );
  });

  it('rechaza lo que no es un DBF', () => {
    const csv = Buffer.from('edad,sexo\n'.repeat(10), 'utf8');
    expect(() => readDbf(csv)).toThrow(DbfError);
  });
});
