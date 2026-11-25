import { describe, expect, it } from 'vitest';
import {
  checkAnalysis,
  readAnalysis,
  roleAllowsType,
  suggestRole,
  unconfirmedTypeOf,
  type VariableAnalysisInput,
} from './variable-role.js';

const variable = (
  extra: Partial<{
    dataType: 'text' | 'integer' | 'decimal' | null;
    known: string[];
  }> = {},
) => ({
  name: 'V',
  dataType: null,
  known: ['1', '2', '9'],
  ...extra,
});

/** The `code` and `params` of what `checkAnalysis` throws. */
function failure(input: VariableAnalysisInput, v = variable()) {
  try {
    checkAnalysis(input, v);
  } catch (err) {
    return (err as { getResponse(): unknown }).getResponse();
  }
  throw new Error('expected checkAnalysis to throw');
}

describe('checkAnalysis', () => {
  it('a yes/no variable with its universe and "yes" code', () => {
    expect(
      checkAnalysis(
        {
          role: 'dichotomous',
          universe: ' población de 3 años y más ',
          positiveValue: ' 1 ',
        },
        variable(),
      ),
    ).toEqual({
      role: 'dichotomous',
      universe: 'población de 3 años y más',
      universeRule: null,
      positiveValue: '1',
      geoLevel: null,
      unit: null,
      disaggregation: null,
    });
  });

  it('a yes/no variable needs a "yes" code that is one of its codes', () => {
    expect(failure({ role: 'dichotomous' })).toMatchObject({
      code: 'variable_analysis_invalid',
      params: { field: 'positiveValue', problem: 'required' },
    });
    expect(failure({ role: 'dichotomous', positiveValue: '3' })).toMatchObject({
      code: 'variable_positive_value_unknown',
      params: { value: '3', known: ['1', '2', '9'] },
    });
  });

  it('fields that do not go with the role are rejected, not dropped', () => {
    expect(failure({ role: 'category', positiveValue: '1' })).toMatchObject({
      params: { field: 'positiveValue', problem: 'not_for_role' },
    });
    expect(failure({ role: 'category', geoLevel: 'state' })).toMatchObject({
      params: { field: 'geoLevel', problem: 'not_for_role' },
    });
    expect(failure({ role: 'category', unit: 'años' })).toMatchObject({
      params: { field: 'unit', problem: 'not_for_role' },
    });
    expect(
      failure({ role: 'identifier', disaggregation: { summable: false } }),
    ).toMatchObject({
      params: { field: 'disaggregation', problem: 'not_for_role' },
    });
    expect(failure({ universe: 'todos' })).toMatchObject({
      params: { field: 'universe', problem: 'role_required' },
    });
  });

  it('a geographic variable needs its level; only it has a most detailed level', () => {
    expect(failure({ role: 'geographic' })).toMatchObject({
      params: { field: 'geoLevel', problem: 'required' },
    });
    expect(
      checkAnalysis(
        {
          role: 'geographic',
          geoLevel: 'municipality',
          disaggregation: { summable: true, maxLevel: 'municipality' },
        },
        variable(),
      ),
    ).toMatchObject({
      geoLevel: 'municipality',
      disaggregation: { summable: true, maxLevel: 'municipality' },
    });
    expect(failure({ role: 'geographic', geoLevel: 'entidad' })).toMatchObject({
      params: { field: 'geoLevel', problem: 'unknown' },
    });
  });

  it('a measure with its unit and age groups', () => {
    const cuts = [
      { from: 0, to: 4, label: ' 0 a 4 años ' },
      { from: 5, to: 59, label: '5 a 59 años' },
      { from: 60, to: null, label: '60 años y más' },
    ];
    expect(
      checkAnalysis(
        {
          role: 'measure',
          unit: 'años',
          disaggregation: { summable: true, cuts },
        },
        variable({ dataType: 'integer' }),
      ),
    ).toMatchObject({
      unit: 'años',
      disaggregation: {
        summable: true,
        cuts: [
          { from: 0, to: 4, label: '0 a 4 años' },
          { from: 5, to: 59, label: '5 a 59 años' },
          { from: 60, to: null, label: '60 años y más' },
        ],
      },
    });
  });

  it('groups must be in order, without overlap, labelled, and only the last open', () => {
    const measure = variable({ dataType: 'integer' });
    const check = (
      cuts: { from: number; to: number | null; label: string }[],
    ) =>
      failure(
        { role: 'measure', disaggregation: { summable: true, cuts } },
        measure,
      );
    expect(
      check([
        { from: 0, to: 10, label: 'a' },
        { from: 10, to: 20, label: 'b' },
      ]),
    ).toMatchObject({
      params: { field: 'disaggregation.cuts[1]', problem: 'overlap' },
    });
    expect(check([{ from: 5, to: 1, label: 'a' }])).toMatchObject({
      params: { problem: 'bounds' },
    });
    expect(
      check([
        { from: 0, to: null, label: 'a' },
        { from: 5, to: 9, label: 'b' },
      ]),
    ).toMatchObject({
      params: { field: 'disaggregation.cuts[0]', problem: 'open_not_last' },
    });
    expect(check([{ from: 0, to: 4, label: ' ' }])).toMatchObject({
      params: { problem: 'label_required' },
    });
    expect(
      failure(
        {
          role: 'category',
          disaggregation: {
            summable: true,
            cuts: [{ from: 0, to: 4, label: 'a' }],
          },
        },
        variable(),
      ),
    ).toMatchObject({
      params: { field: 'disaggregation.cuts', problem: 'not_for_role' },
    });
  });

  it('the role must fit the confirmed type', () => {
    expect(
      failure({ role: 'measure' }, variable({ dataType: null })),
    ).toMatchObject({
      code: 'variable_role_type_mismatch',
      params: { variable: 'V', role: 'measure', dataType: null },
    });
    expect(
      failure(
        { role: 'geographic', geoLevel: 'state' },
        variable({ dataType: 'integer' }),
      ),
    ).toMatchObject({
      code: 'variable_role_type_mismatch',
      params: { role: 'geographic', dataType: 'integer' },
    });
  });

  it('a universe rule points to another variable of the survey confirmed as a number', () => {
    const others = [
      { name: 'EDAD', dataType: 'integer' as const },
      { name: 'SEXO', dataType: 'text' as const },
    ];
    const input = (variable: string, min = 15): VariableAnalysisInput => ({
      role: 'ordinal',
      universe: 'población de 15 años y más',
      universeRule: { variable, min },
    });
    expect(checkAnalysis(input(' EDAD '), variable(), others).universeRule).toEqual({ variable: 'EDAD', min: 15 });
    const problem = (i: VariableAnalysisInput) => {
      try {
        checkAnalysis(i, variable(), others);
      } catch (err) {
        return ((err as { getResponse(): { params: unknown } }).getResponse()).params;
      }
      return null;
    };
    expect(problem(input('V'))).toEqual({ field: 'universeRule.variable', problem: 'self' });
    expect(problem(input('NADA'))).toEqual({ field: 'universeRule.variable', problem: 'unknown' });
    expect(problem(input('SEXO'))).toEqual({ field: 'universeRule.variable', problem: 'not_a_number' });
    expect(problem(input(''))).toEqual({ field: 'universeRule.variable', problem: 'required' });
    expect(problem(input('EDAD', Number.NaN))).toEqual({ field: 'universeRule.min', problem: 'not_a_number' });
    expect(problem({ role: null, universeRule: { variable: 'EDAD', min: 15 } })).toEqual({
      field: 'universeRule',
      problem: 'role_required',
    });
    expect(readAnalysis({ role: 'ordinal', universe: null, universeRule: { variable: 'EDAD', min: 15 }, positiveValue: null, geoLevel: null, unit: null, disaggregation: null }).universeRule).toEqual({ variable: 'EDAD', min: 15 });
    expect(readAnalysis({ role: 'ordinal', universe: null, universeRule: { min: 'x' }, positiveValue: null, geoLevel: null, unit: null, disaggregation: null }).universeRule).toBeNull();
  });

  it('no role clears everything; an unknown role is rejected', () => {
    expect(checkAnalysis({ role: null }, variable())).toEqual({
      role: null,
      universe: null,
      universeRule: null,
      positiveValue: null,
      geoLevel: null,
      unit: null,
      disaggregation: null,
    });
    expect(failure({ role: 'medida' })).toMatchObject({
      params: { field: 'role', problem: 'unknown' },
    });
  });
});

describe('roleAllowsType and unconfirmedTypeOf', () => {
  it('a measure is a number; codes stay text; the rest take any type', () => {
    expect(roleAllowsType('measure', 'decimal')).toBe(true);
    expect(roleAllowsType('measure', 'text')).toBe(false);
    expect(roleAllowsType('category', null)).toBe(true);
    expect(roleAllowsType('key', 'integer')).toBe(false);
    expect(roleAllowsType('temporal', 'integer')).toBe(true);
    expect(unconfirmedTypeOf('geographic')).toBe('text');
    expect(unconfirmedTypeOf('measure')).toBeNull();
    expect(unconfirmedTypeOf(null)).toBeNull();
  });
});

describe('readAnalysis', () => {
  it('reads what is stored and ignores values of another shape', () => {
    expect(
      readAnalysis({
        role: 'otro',
        universe: 'todos',
        positiveValue: null,
        geoLevel: 'entidad',
        unit: null,
        disaggregation: { cuts: [] },
      }),
    ).toEqual({
      role: null,
      universe: 'todos',
      universeRule: null,
      positiveValue: null,
      geoLevel: null,
      unit: null,
      disaggregation: null,
    });
  });
});

describe('suggestRole', () => {
  const cat = (
    kind: 'value' | 'missing' | 'blank' | 'range' | 'catalog',
    code = '1',
  ) => ({ code, label: '', kind });

  it('from the dictionary: catalog, two codes, more codes, a range', () => {
    expect(suggestRole([cat('catalog', 'tc_ent')], [], null)).toBe(
      'geographic',
    );
    expect(
      suggestRole(
        [cat('value', '1'), cat('value', '3'), cat('missing', '9')],
        [],
        null,
      ),
    ).toBe('dichotomous');
    expect(
      suggestRole(
        [cat('value', '1'), cat('value', '2'), cat('value', '3')],
        [],
        null,
      ),
    ).toBe('category');
    expect(
      suggestRole([cat('range', '0..130'), cat('missing', '999')], [], null),
    ).toBe('measure');
  });

  it('without a dictionary: the common catalog, then a numeric type', () => {
    expect(suggestRole(null, [{ code: '1' }, { code: '2' }], null)).toBe(
      'dichotomous',
    );
    expect(
      suggestRole(null, [{ code: '1' }, { code: '2' }, { code: '3' }], 'text'),
    ).toBe('category');
    expect(suggestRole(null, [], 'integer')).toBe('measure');
    expect(suggestRole(null, [], 'text')).toBeNull();
  });
});
