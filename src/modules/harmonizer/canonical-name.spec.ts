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
    ['e', 'entre 2 y 64'],
    ['x'.repeat(65), 'entre 2 y 64'],
    ['123', 'empezar con una letra'],
    ['_dataset', 'empezar con una letra'],
    ['_row', 'empezar con una letra'],
    ['ñandu', 'empezar con una letra'],
    ['muni)(&/%$', 'solo puede tener'],
    ['edad,sexo', 'solo puede tener'],
    ['edad jefe', 'solo puede tener'],
    ['año', 'solo puede tener'],
    ['edad-jefe', 'solo puede tener'],
  ])('rejects %s', (name, reason) => {
    expect(canonicalNameProblem(name)).toContain(reason);
  });
});

describe('sameCanonicalName', () => {
  it('ignores case', () => {
    expect(sameCanonicalName('edad', 'EDAD')).toBe(true);
    expect(sameCanonicalName('edad', 'edad1')).toBe(false);
  });
});
