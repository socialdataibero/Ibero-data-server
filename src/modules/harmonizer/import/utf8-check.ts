import { isUtf8 } from 'node:buffer';

const NEWLINE = 0x0a;

function countNewlines(buf: Buffer, end = buf.length): number {
  let count = 0;
  let i = buf.indexOf(NEWLINE);
  while (i !== -1 && i < end) {
    count++;
    i = buf.indexOf(NEWLINE, i + 1);
  }
  return count;
}

/** Bytes a sequence starting with `lead` has, or 0 if `lead` cannot start one. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * Offset of the first byte that is not valid UTF-8 (the start of the bad sequence), or -1.
 * Same rules as the WHATWG decoder: no overlong forms, no surrogates, nothing above U+10FFFF.
 */
export function firstInvalidUtf8(buf: Buffer): number {
  let i = 0;
  while (i < buf.length) {
    const lead = buf[i];
    const len = sequenceLength(lead);
    if (len === 1) {
      i++;
      continue;
    }
    if (len === 0 || i + len > buf.length) return i;
    const second = buf[i + 1];
    let lo = 0x80;
    let hi = 0xbf;
    if (lead === 0xe0) lo = 0xa0;
    else if (lead === 0xed) hi = 0x9f;
    else if (lead === 0xf0) lo = 0x90;
    else if (lead === 0xf4) hi = 0x8f;
    if (second < lo || second > hi) return i;
    for (let k = 2; k < len; k++) {
      const b = buf[i + k];
      if (b < 0x80 || b > 0xbf) return i;
    }
    i += len;
  }
  return -1;
}

/**
 * Checks a stream of bytes for UTF-8, chunk by chunk, without holding the file in memory.
 * A character split between two chunks is carried over to the next one. When a byte is
 * invalid, `push` or `end` returns its line (1-based, counting `\n`), the same line the
 * synchronous upload reports; otherwise they return `null`.
 */
export class Utf8LineChecker {
  private carry: Buffer = Buffer.alloc(0);
  private linesBefore = 0;

  push(chunk: Buffer): number | null {
    const buf =
      this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const cut = this.completeLength(buf);
    const head = buf.subarray(0, cut);
    this.carry = Buffer.from(buf.subarray(cut));
    if (isUtf8(head)) {
      this.linesBefore += countNewlines(head);
      return null;
    }
    const bad = firstInvalidUtf8(head);
    return this.linesBefore + countNewlines(head, bad) + 1;
  }

  /** Call after the last chunk: an incomplete character at the very end is invalid. */
  end(): number | null {
    return this.carry.length > 0 ? this.linesBefore + 1 : null;
  }

  /** Length of `buf` without a possibly incomplete character at its end. */
  private completeLength(buf: Buffer): number {
    for (let back = 1; back <= Math.min(3, buf.length); back++) {
      const b = buf[buf.length - back];
      if (b < 0x80) return buf.length;
      if (b >= 0xc0) {
        const len = sequenceLength(b);
        // An invalid lead byte is left in place so that the check reports it.
        return len > back ? buf.length - back : buf.length;
      }
    }
    return buf.length;
  }
}
