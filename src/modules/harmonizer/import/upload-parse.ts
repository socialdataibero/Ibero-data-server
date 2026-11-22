import { BadRequestException } from '@nestjs/common';
import { csvNotUtf8Body } from '../csv-errors.js';
import {
  DbfError,
  readDbf,
  type DbfEncoding,
  type DbfEncodingSource,
} from '../dbf.js';
import type { UploadEncoding } from '../dto/upload-dataset.dto.js';
import type { RawData } from '../harmonized-view.js';

/** Reading of uploaded files shared by the one-request upload and the import worker. */

export interface RenamedColumn {
  // Posición de la columna en el archivo, empezando en 1.
  position: number;
  original: string;
  renamed: string;
}

// Cómo se leyó el archivo subido, para que el cliente avise al usuario. No se guarda.
export type UploadSource =
  | { format: 'csv' }
  | {
      format: 'dbf';
      encoding: DbfEncoding;
      encodingSource: DbfEncodingSource;
      deletedRecords: number;
    };

export interface ParsedUpload {
  columns: string[];
  rows: RawData[];
  renamed: RenamedColumn[];
  source: UploadSource;
}

// Los encabezados repetidos se renombran con `.1`, `.2`, … y se informa al
// usuario (H-10). El sufijo salta los nombres que ya existen en el archivo:
// con `EDAD, EDAD, EDAD.1` la segunda pasa a `EDAD.2`, no a otro `EDAD.1`.
// Un encabezado vacío recibe `columna_N` (N = su posición) y también se informa.
export function dedupeHeaders(headers: string[]): {
  columns: string[];
  renamed: RenamedColumn[];
} {
  const named = headers.map((h, i) =>
    h.trim() === '' ? `columna_${i + 1}` : h,
  );
  const taken = new Set(named);
  const seen = new Set<string>();
  const renamed: RenamedColumn[] = [];
  const columns = named.map((h, i) => {
    let name = h;
    if (seen.has(h)) {
      let n = 1;
      while (taken.has(`${h}.${n}`)) n++;
      name = `${h}.${n}`;
      taken.add(name);
    } else {
      seen.add(h);
    }
    if (name !== headers[i]) {
      renamed.push({ position: i + 1, original: headers[i], renamed: name });
    }
    return name;
  });
  return { columns, renamed };
}

// Un archivo que no es UTF-8 (p. ej. Latin-1) se decodificaría con U+FFFD en
// lugar de cada carácter acentuado, y el byte original se perdería para siempre.
export function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const lossy = new TextDecoder('utf-8').decode(buffer);
    const line = lossy.slice(0, lossy.indexOf('\uFFFD')).split('\n').length;
    throw new BadRequestException(csvNotUtf8Body(line));
  }
}

/** Reads an uploaded DBF into rows. Shared by the synchronous upload and the import worker. */
export function parseDbfUpload(
  buffer: Buffer,
  encoding: UploadEncoding | undefined,
): ParsedUpload {
  let table;
  try {
    table = readDbf(buffer, encoding === 'auto' ? undefined : encoding);
  } catch (err) {
    if (err instanceof DbfError) {
      throw new BadRequestException({
        code: err.code,
        message: err.message,
        params: err.params,
      });
    }
    throw err;
  }
  if (table.rows.length === 0) {
    throw new BadRequestException({
      code: 'dbf_no_rows',
      message:
        'The DBF file has no records, or all of them are marked as deleted.',
    });
  }
  const { columns, renamed } = dedupeHeaders(table.headers);
  return {
    columns,
    rows: table.rows.map((values) =>
      Object.fromEntries(columns.map((col, i) => [col, values[i]])),
    ),
    renamed,
    source: {
      format: 'dbf',
      encoding: table.encoding,
      encodingSource: table.encodingSource,
      deletedRecords: table.deletedRecords,
    },
  };
}
