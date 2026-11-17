import { describe, expect, it } from 'vitest';
import { Utf8LineChecker, firstInvalidUtf8 } from './utf8-check.js';

/** The line the synchronous upload reports (`decodeUtf8` in harmonizer.service.ts), or null. */
function referenceLine(buf: Buffer): number | null {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return null;
  } catch {
    const lossy = new TextDecoder('utf-8').decode(buf);
    return lossy.slice(0, lossy.indexOf('�')).split('\n').length;
  }
}

function checkInChunks(buf: Buffer, sizes: number[]): number | null {
  const checker = new Utf8LineChecker();
  let offset = 0;
  let i = 0;
  while (offset < buf.length) {
    const size = sizes[i++ % sizes.length];
    const line = checker.push(buf.subarray(offset, offset + size));
    if (line !== null) return line;
    offset += size;
  }
  return checker.end();
}

// Deterministic pseudo-random numbers, so a failure can be reproduced.
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const PIECES = ['a', 'b', ',', '\n', 'á', 'ñ', '€', '😀', '"', ' '].map((t) =>
  Buffer.from(t),
);
const BAD = [0xff, 0xc3, 0xe2, 0x82, 0xed, 0xa0, 0xf4, 0x90, 0xc0, 0xaf].map(
  (b) => Buffer.from([b]),
);

describe('firstInvalidUtf8', () => {
  it('finds the start of the first bad sequence', () => {
    expect(firstInvalidUtf8(Buffer.from('añb'))).toBe(-1);
    expect(firstInvalidUtf8(Buffer.from([0x61, 0xff]))).toBe(1);
    expect(firstInvalidUtf8(Buffer.from([0x61, 0xc3, 0x0a]))).toBe(1); // lead byte without its pair
    expect(firstInvalidUtf8(Buffer.from([0xe0, 0x80, 0x80]))).toBe(0); // overlong
    expect(firstInvalidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(0); // surrogate
    expect(firstInvalidUtf8(Buffer.from([0xf4, 0x90, 0x80, 0x80]))).toBe(0); // above U+10FFFF
  });
});

describe('Utf8LineChecker', () => {
  it('accepts UTF-8 split anywhere, BOM included', () => {
    const text = Buffer.from('﻿nombre,ciudad\nJosé,Mérida\n😀,€\n');
    for (let size = 1; size <= text.length; size++) {
      expect(checkInChunks(text, [size])).toBeNull();
    }
  });

  it('reports the line of a Latin-1 accent', () => {
    const latin1 = Buffer.concat([
      Buffer.from('a,b\n1,2\nJos'),
      Buffer.from([0xe9]),
      Buffer.from(',3\n'),
    ]);
    expect(checkInChunks(latin1, [4])).toBe(3);
  });

  it('reports a character cut at the end of the file', () => {
    expect(checkInChunks(Buffer.from([0x61, 0x0a, 0xc3]), [1])).toBe(2);
  });

  it('agrees with the synchronous upload on random files and random chunk sizes', () => {
    const next = random(42);
    for (let n = 0; n < 2000; n++) {
      const parts: Buffer[] = [];
      const length = 1 + Math.floor(next() * 40);
      for (let k = 0; k < length; k++) {
        parts.push(
          next() < 0.05
            ? BAD[Math.floor(next() * BAD.length)]
            : PIECES[Math.floor(next() * PIECES.length)],
        );
      }
      const buf = Buffer.concat(parts);
      const sizes = [1 + Math.floor(next() * 7), 1 + Math.floor(next() * 13)];
      expect(
        checkInChunks(buf, sizes),
        `case ${n}: ${buf.toString('hex')}`,
      ).toBe(referenceLine(buf));
    }
  });
});
