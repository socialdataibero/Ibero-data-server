import { BadRequestException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { HarmonizerService } from '../harmonizer.service.js';
import { readCsvRows } from './csv-rows.js';
import { ImportError } from './import-error.js';

type Outcome =
  | { ok: true; columns: string[]; renamed: unknown[]; rows: string[][] }
  | { ok: false; code: string; message: string; params?: unknown };

/** The synchronous upload's parser (`HarmonizerService.parseCsv`), as the reference. */
function synchronous(text: string): Outcome {
  const service = new HarmonizerService(
    null as never,
    null as never,
    null as never,
  );
  try {
    const { columns, rows, renamed } = (
      service as unknown as {
        parseCsv(b: Buffer): {
          columns: string[];
          rows: Record<string, string>[];
          renamed: unknown[];
        };
      }
    ).parseCsv(Buffer.from(text));
    return {
      ok: true,
      columns,
      renamed,
      rows: rows.map((r) => columns.map((c) => r[c])),
    };
  } catch (err) {
    const body = (err as BadRequestException).getResponse() as {
      code: string;
      message: string;
      params?: unknown;
    };
    return {
      ok: false,
      code: body.code,
      message: body.message,
      ...(body.params ? { params: body.params } : {}),
    };
  }
}

async function streamed(text: string, chunkSize = 3): Promise<Outcome> {
  const chunks: Buffer[] = [];
  const buf = Buffer.from(text);
  for (let i = 0; i < buf.length; i += chunkSize)
    chunks.push(buf.subarray(i, i + chunkSize));
  const rows: string[][] = [];
  try {
    const { header } = await readCsvRows(
      Readable.from(chunks),
      () => {},
      (values) => rows.push(values),
    );
    return { ok: true, columns: header.columns, renamed: header.renamed, rows };
  } catch (err) {
    const body = (err as ImportError).toBody();
    return {
      ok: false,
      code: body.code,
      message: body.message,
      ...(body.params ? { params: body.params } : {}),
    };
  }
}

const CASES: Record<string, string> = {
  simple: 'a,b\n1,2\n3,4\n',
  bom: '﻿a,b\n1,2\n',
  crlf: 'a,b\r\n1,2\r\n3,4\r\n',
  'no final newline': 'a,b\n1,2',
  'blank lines': 'a,b\n\n1,2\n\n\n3,4\n',
  'quoted with comma and newline': 'a,b\n"x, y","línea\nnueva"\n',
  'escaped quotes': 'a,b\n"di ""hola""",2\n',
  'quote inside unquoted value (H-07)': 'a,b\n5" pantalla,{"k":1}\n',
  'spaces kept': 'a,b\n  1 , 2  \n',
  'header trimmed and deduplicated': ' EDAD ,EDAD,EDAD.1,,  \n1,2,3,4,5\n',
  'unclosed quote': 'a,b\n1,2\n"x,3\n4,5\n',
  'unclosed quote in first row': 'a,b\n"x,3\n',
  'row with fewer fields': 'a,b\n1,2\n3\n',
  'row with more fields': 'a,b\n1,2,3\n',
  'after a multi-line value': 'a,b\n\n1,"x\ny"\n4,5,6\n',
  empty: '',
  'only blank lines': '\n\n\n',
  'only spaces': '   \n',
  'header only': 'a,b\n',
  'header only with blank lines': 'a,b\n\n\n',
  'trailing comma': 'a,b,\n1,2,\n',
};

describe('readCsvRows (same results as the synchronous upload)', () => {
  for (const [name, text] of Object.entries(CASES)) {
    it(name, async () => {
      const expected = synchronous(text);
      expect(await streamed(text)).toEqual(expected);
      expect(await streamed(text, 1)).toEqual(expected);
      expect(await streamed(text, 1 << 20)).toEqual(expected);
    });
  }

  it('keeps the error codes of the synchronous upload', async () => {
    expect(await streamed(CASES.empty)).toMatchObject({
      ok: false,
      code: 'csv_empty',
    });
    expect(await streamed(CASES['header only'])).toMatchObject({
      ok: false,
      code: 'csv_no_rows',
    });
    expect(await streamed(CASES['unclosed quote'])).toMatchObject({
      ok: false,
      code: 'csv_invalid',
      params: { problem: 'quote_not_closed', line: 3 },
    });
    expect(await streamed(CASES['row with fewer fields'])).toMatchObject({
      ok: false,
      code: 'csv_invalid',
      params: {
        problem: 'inconsistent_columns',
        line: 3,
        rowColumns: 1,
        headerColumns: 2,
      },
    });
  });
});
