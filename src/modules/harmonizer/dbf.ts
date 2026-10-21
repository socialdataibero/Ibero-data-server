/**
 * Lector de tablas dBase / FoxPro (.dbf) para el armonizador. Devuelve todo como texto, igual
 * que la subida de CSV: sin convertir tipos, solo sin el relleno de ancho fijo.
 *
 * Formato: encabezado de 32 bytes, descriptores de columna de 32 bytes terminados en 0x0D y
 * registros de ancho fijo cuyo primer byte es `*` si el registro está borrado.
 */

export const DBF_ENCODINGS = [
  'utf-8',
  'windows-1252',
  'cp850',
  'cp437',
] as const;
export type DbfEncoding = (typeof DBF_ENCODINGS)[number];

/** De dónde salió la codificación: elegida al subir, del encabezado o deducida del texto. */
export type DbfEncodingSource = 'user' | 'header' | 'content';

export interface DbfTable {
  /** Nombres de columna tal como vienen (recortados), antes de quitar repetidos. */
  headers: string[];
  rows: string[][];
  /** Registros marcados como borrados (`*`), que no se leen. */
  deletedRecords: number;
  encoding: DbfEncoding;
  encodingSource: DbfEncodingSource;
}

export class DbfError extends Error {
  constructor(
    readonly code: 'dbf_invalid' | 'dbf_field_unsupported' | 'dbf_not_utf8',
    message: string,
  ) {
    super(message);
  }
}

// Mitad alta (0x80–0xFF) de las páginas de códigos de MS-DOS, que TextDecoder no conoce.
const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
  '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩' +
  '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

// Byte 29 del encabezado («language driver»). 0 significa que no se indicó.
const LANGUAGE_DRIVER: Record<number, DbfEncoding> = {
  0x01: 'cp437',
  0x02: 'cp850',
  0x03: 'windows-1252',
  0x57: 'windows-1252',
  0x58: 'windows-1252',
  0x59: 'windows-1252',
};

// Letras y signos del español: lo que suma al adivinar la codificación por el contenido.
const SPANISH_CHARS = new Set('áéíóúÁÉÍÓÚñÑüÜ¿¡°ºª');

const TEXT_TYPES = new Set(['C']);
const ASCII_TYPES = new Set(['N', 'F', 'D', 'L']);
const MEMO_TYPES = new Set(['M', 'G', 'P', 'B']);

interface Field {
  nameBytes: Buffer;
  type: string;
  offset: number;
  length: number;
}

function hasHighByte(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return true;
  return false;
}

function tableDecoder(high: string) {
  return (bytes: Uint8Array): string => {
    let out = '';
    for (const b of bytes)
      out += b < 0x80 ? String.fromCharCode(b) : high[b - 0x80];
    return out;
  };
}

function decoderFor(encoding: DbfEncoding): (bytes: Uint8Array) => string {
  switch (encoding) {
    case 'cp850':
      return tableDecoder(CP850_HIGH);
    case 'cp437':
      return tableDecoder(CP437_HIGH);
    default: {
      // UTF-8 estricto: un byte inválido lanza en vez de guardar «�» (como H-03 en CSV).
      const decoder = new TextDecoder(encoding, {
        fatal: encoding === 'utf-8',
      });
      return (bytes) => decoder.decode(bytes);
    }
  }
}

/** Puntaje de una decodificación: letras del español suman, cajas y controles restan. */
function spanishScore(texts: string[]): number {
  let score = 0;
  for (const text of texts) {
    for (const ch of text) {
      if (SPANISH_CHARS.has(ch)) score++;
      else if (/[\u0080-\u009f─-◿]/.test(ch)) score--;
    }
  }
  return score;
}

function isUtf8(samples: Buffer[]): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (const s of samples) decoder.decode(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sin codificación elegida, primero el encabezado; si no la dice, el texto: UTF-8 si todo
 * es UTF-8 válido, y si no, la que deje más letras del español (Windows-1252 en empate).
 */
function detectEncoding(
  buf: Buffer,
  samples: Buffer[],
): { encoding: DbfEncoding; encodingSource: DbfEncodingSource } {
  const fromHeader = LANGUAGE_DRIVER[buf[29]];
  if (fromHeader) return { encoding: fromHeader, encodingSource: 'header' };
  if (samples.length === 0 || isUtf8(samples)) {
    return { encoding: 'utf-8', encodingSource: 'content' };
  }
  const cp850 = spanishScore(samples.map(decoderFor('cp850')));
  const win = spanishScore(samples.map(decoderFor('windows-1252')));
  return {
    encoding: cp850 > win ? 'cp850' : 'windows-1252',
    encodingSource: 'content',
  };
}

// Nombres de columna y celdas de texto con algún byte ≥ 0x80: lo único que cambia entre
// codificaciones.
function nonAsciiTexts(buf: Buffer, fields: Field[], live: number[]): Buffer[] {
  const texts = fields.map((f) => f.nameBytes).filter(hasHighByte);
  const textFields = fields.filter((f) => TEXT_TYPES.has(f.type));
  for (const start of live) {
    for (const f of textFields) {
      const bytes = buf.subarray(start + f.offset, start + f.offset + f.length);
      if (hasHighByte(bytes)) texts.push(bytes);
    }
  }
  return texts;
}

function invalid(detail: string): DbfError {
  return new DbfError(
    'dbf_invalid',
    `No se pudo leer el archivo como DBF: ${detail}. Revisa que sea una tabla dBase o FoxPro (.dbf) completa.`,
  );
}

function readFields(buf: Buffer, headerLength: number): Field[] {
  const fields: Field[] = [];
  let offset = 1; // el byte 0 de cada registro es la marca de borrado
  let pos = 32;
  for (; pos + 32 <= headerLength && buf[pos] !== 0x0d; pos += 32) {
    const raw = buf.subarray(pos, pos + 11);
    const end = raw.indexOf(0);
    const type = String.fromCharCode(buf[pos + 11]).toUpperCase();
    // En Clipper y FoxPro una columna de texto de más de 255 usa el byte de decimales como
    // byte alto del ancho; en dBase ese byte vale 0 para texto.
    const length =
      type === 'C' ? buf[pos + 16] + buf[pos + 17] * 256 : buf[pos + 16];
    fields.push({
      nameBytes: end === -1 ? raw : raw.subarray(0, end),
      type,
      offset,
      length,
    });
    offset += length;
  }
  if (buf[pos] !== 0x0d) {
    throw invalid(
      'la lista de columnas del encabezado no termina donde debería',
    );
  }
  return fields;
}

function unsupportedField(name: string, type: string): DbfError {
  if (MEMO_TYPES.has(type)) {
    return new DbfError(
      'dbf_field_unsupported',
      `La columna «${name}» es de tipo memo (${type}): su contenido está en un archivo aparte (.dbt o .fpt) que no se sube junto con el .dbf. Exporta la tabla a CSV desde el programa que la creó y súbela de nuevo.`,
    );
  }
  return new DbfError(
    'dbf_field_unsupported',
    `La columna «${name}» es de tipo «${type}», que el armonizador no sabe leer. Solo se leen columnas de texto (C), número (N, F), fecha (D) y lógico (L). Exporta la tabla a CSV desde el programa que la creó y súbela de nuevo.`,
  );
}

export function readDbf(buf: Buffer, requested?: DbfEncoding): DbfTable {
  if (buf.length < 33)
    throw invalid('es demasiado corto para tener encabezado');
  const recordCount = buf.readUInt32LE(4);
  const headerLength = buf.readUInt16LE(8);
  const recordLength = buf.readUInt16LE(10);
  if (headerLength < 33 || headerLength > buf.length || recordLength < 1) {
    throw invalid('el encabezado no tiene un tamaño válido');
  }

  // `_NullFlags` es una columna interna de Visual FoxPro, no un dato.
  const fields = readFields(buf, headerLength).filter((f) => f.type !== '0');
  if (fields.length === 0) throw invalid('no tiene columnas');
  const widths = fields.reduce(
    (sum, f) => Math.max(sum, f.offset + f.length),
    1,
  );
  if (widths > recordLength) {
    throw invalid(
      'los anchos de las columnas no caben en el largo del registro',
    );
  }
  const complete = Math.floor((buf.length - headerLength) / recordLength);
  if (complete < recordCount) {
    throw invalid(
      `está incompleto: el encabezado anuncia ${recordCount} registros y el archivo solo trae ${complete}`,
    );
  }
  for (const f of fields) {
    if (!TEXT_TYPES.has(f.type) && !ASCII_TYPES.has(f.type)) {
      throw unsupportedField(
        decoderFor('windows-1252')(f.nameBytes).trim(),
        f.type,
      );
    }
  }

  const live: number[] = [];
  let deletedRecords = 0;
  for (let r = 0; r < recordCount; r++) {
    const start = headerLength + r * recordLength;
    if (buf[start] === 0x2a) deletedRecords++;
    else live.push(start);
  }

  const chosen = requested
    ? { encoding: requested, encodingSource: 'user' as const }
    : detectEncoding(buf, nonAsciiTexts(buf, fields, live));
  const decode = decoderFor(chosen.encoding);

  const decodeOrFail = (bytes: Buffer, where: string): string => {
    if (!hasHighByte(bytes)) return bytes.toString('latin1');
    try {
      return decode(bytes);
    } catch {
      throw new DbfError(
        'dbf_not_utf8',
        `El archivo no está en UTF-8 (${where}). Elige otra codificación al subirlo, por ejemplo «Detectar automáticamente».`,
      );
    }
  };

  const headers = fields.map((f, i) =>
    decodeOrFail(f.nameBytes, `nombre de la columna ${i + 1}`).trim(),
  );
  const rows = live.map((start) =>
    fields.map((f, i) => {
      const bytes = buf.subarray(start + f.offset, start + f.offset + f.length);
      if (TEXT_TYPES.has(f.type)) {
        const record = (start - headerLength) / recordLength + 1;
        // El texto se rellena con espacios a la derecha: se quitan solo esos.
        return decodeOrFail(
          bytes,
          `registro ${record}, columna «${headers[i]}»`,
        ).replace(/[ \0]+$/, '');
      }
      // Números, fechas (AAAAMMDD) y lógicos son ASCII alineados con espacios.
      return bytes.toString('latin1').replace(/^[ \0]+|[ \0]+$/g, '');
    }),
  );

  return { headers, rows, deletedRecords, ...chosen };
}
