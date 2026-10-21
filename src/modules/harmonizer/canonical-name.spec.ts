import { describe, expect, it } from 'vitest';
import { canonicalNameProblem, sameCanonicalName } from './canonical-name.js';

describe('canonicalNameProblem', () => {
  it.each(['edad', 'EDAD_JEFE', 'p5_2', 'ab', 'x'.repeat(64)])(
    'accepts %s',
    (name) => {
      expect(canonicalNameProblem(name)).toBeNull();
    },
  );

  it.each([
    ['e', 'length'],
    ['x'.repeat(65), 'length'],
    ['123', 'start'],
    ['_dataset', 'start'],
    ['_row', 'start'],
    ['ñandu', 'start'],
    ['muni)(&/%$', 'chars'],
    ['edad,sexo', 'chars'],
    ['edad jefe', 'chars'],
    ['año', 'chars'],
    ['edad-jefe', 'chars'],
  ])('rejects %s', (name, reason) => {
    expect(canonicalNameProblem(name)).toBe(reason);
  });
});

describe('sameCanonicalName', () => {
  it('ignores case', () => {
    expect(sameCanonicalName('edad', 'EDAD')).toBe(true);
    expect(sameCanonicalName('edad', 'edad1')).toBe(false);
  });
});
