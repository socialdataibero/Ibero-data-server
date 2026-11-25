import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { CodebookVariableInfo } from '../codebook.js';
import type { MappingChoiceDto } from '../dto/mapping-choice.dto.js';
import {
  canonicalUpdates,
  mappingChanges,
  mappingCollisions,
  newCanonicalsToCreate,
  resolveChoices,
  type CanonicalRef,
  type ResolvedColumn,
  type SavedMapping,
} from './mapping-save-steps.js';

const canonical = (
  id: string,
  name: string,
  extra: Partial<CanonicalRef> = {},
): CanonicalRef => ({ id, name, description: null, dataType: null, ...extra });
const choices = (list: MappingChoiceDto[]) =>
  new Map(list.map((c) => [c.column, c]));
const label = (text: string) =>
  ({ label: text }) as unknown as CodebookVariableInfo;
const resolved = (
  column: string,
  canonicalId: string | null,
  extra: Partial<ResolvedColumn> = {},
): ResolvedColumn => ({
  column,
  canonicalId,
  missingCodes: [],
  role: null,
  certaintyCodes: [],
  dataType: undefined,
  ...extra,
});

describe('newCanonicalsToCreate', () => {
  it('creates each new name once, reusing names that already exist', () => {
    const byName = new Map([['EDAD', canonical('c1', 'EDAD')]]);
    const out = newCanonicalsToCreate(
      ['A', 'B', 'C', 'D'],
      choices([
        { column: 'A', choice: '__new__', newName: ' SEXO ' },
        { column: 'B', choice: '__new__', newName: 'SEXO' },
        { column: 'C', choice: '__new__', newName: 'EDAD' },
        { column: 'D', choice: '__new__', newName: '  ' },
      ]),
      byName,
      new Map(),
    );
    expect([...out]).toEqual([['SEXO', null]]);
  });

  it('takes the description sent, or else the label of the dictionary', () => {
    const out = newCanonicalsToCreate(
      ['A', 'B', 'C'],
      choices([
        {
          column: 'A',
          choice: '__new__',
          newName: 'X',
          newDescription: ' Sexo ',
        },
        { column: 'B', choice: '__new__', newName: 'Y', newDescription: ' ' },
        { column: 'C', choice: '__new__', newName: 'Z' },
      ]),
      new Map(),
      new Map([
        ['A', label('Del diccionario')],
        ['B', label('Edad')],
      ]),
    );
    expect([...out]).toEqual([
      ['X', 'Sexo'],
      ['Y', 'Edad'],
      ['Z', null],
    ]);
  });

  it('ignores columns that are not in the file or not new', () => {
    const out = newCanonicalsToCreate(
      ['A'],
      choices([
        { column: 'A', choice: 'cv:c1' },
        { column: 'B', choice: '__new__', newName: 'B' },
      ]),
      new Map(),
      new Map(),
    );
    expect(out.size).toBe(0);
  });
});

describe('resolveChoices', () => {
  const byId = new Map([
    ['c1', canonical('c1', 'EDAD')],
    ['c2', canonical('c2', 'SEXO')],
  ]);
  const byName = new Map([...byId.values()].map((c) => [c.name, c]));

  it('resolves new names, existing ids and unmapped columns, in file order', () => {
    const out = resolveChoices(
      ['ID', 'EDAD', 'SEXO', 'OTRA'],
      choices([
        {
          column: 'SEXO',
          choice: 'cv:c2',
          role: 'weight',
          dataType: 'integer',
        },
        {
          column: 'EDAD',
          choice: '__new__',
          newName: ' EDAD ',
          missingCodes: [' 999 ', '', '999', '998'],
        },
        { column: 'OTRA', choice: '__new__', newName: '' },
      ]),
      byId,
      byName,
    );
    expect(out).toEqual([
      resolved('ID', null),
      resolved('EDAD', 'c1', { missingCodes: ['999', '998'] }),
      resolved('SEXO', 'c2', { role: 'weight', dataType: 'integer' }),
      resolved('OTRA', null),
    ]);
  });

  it('rejects an id that is not a variable of the survey', () => {
    const call = () =>
      resolveChoices(
        ['A'],
        choices([{ column: 'A', choice: 'cv:otra' }]),
        byId,
        byName,
      );
    expect(call).toThrow(BadRequestException);
    try {
      call();
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'canonical_variable_not_found',
        params: { id: 'otra' },
      });
    }
  });
});

describe('mappingCollisions', () => {
  it('lists the groups of columns that share a canonical', () => {
    expect(
      mappingCollisions([
        resolved('A', 'c1'),
        resolved('B', 'c2'),
        resolved('C', 'c1'),
        resolved('D', null),
        resolved('E', null),
      ]),
    ).toEqual([['A', 'C']]);
  });

  it('is empty when every canonical comes from one column', () => {
    expect(
      mappingCollisions([resolved('A', 'c1'), resolved('B', 'c2')]),
    ).toEqual([]);
  });
});

describe('mappingChanges', () => {
  const saved = (
    id: string,
    canonicalVariableId: string,
    extra: Partial<SavedMapping> = {},
  ): SavedMapping => ({
    id,
    canonicalVariableId,
    missingCodes: [],
    role: null,
    certaintyCodes: [],
    ...extra,
  });

  it('inserts new columns, deletes unmapped ones and leaves equal ones alone', () => {
    const out = mappingChanges(
      'd1',
      [
        resolved('A', 'c1', { missingCodes: ['9'] }),
        resolved('B', null),
        resolved('C', 'c3'),
        resolved('D', null),
      ],
      new Map([
        ['B', saved('m2', 'c2')],
        ['C', saved('m3', 'c3')],
      ]),
    );
    expect(out).toEqual({
      toUpdate: [],
      toDelete: ['m2'],
      toInsert: [
        {
          datasetId: 'd1',
          sourceColumn: 'A',
          canonicalVariableId: 'c1',
          missingCodes: ['9'],
          role: null,
          certaintyCodes: [],
        },
      ],
    });
  });

  it('moving a column to another canonical drops its recoding', () => {
    const out = mappingChanges(
      'd1',
      [resolved('A', 'c2', { role: 'weight' })],
      new Map([['A', saved('m1', 'c1', { missingCodes: ['9'] })]]),
    );
    expect(out.toUpdate).toEqual([
      {
        id: 'm1',
        data: {
          canonicalVariableId: 'c2',
          missingCodes: [],
          role: 'weight',
          certaintyCodes: [],
          valueMap: {},
        },
      },
    ]);
  });

  it('changing only codes or role keeps the recoding', () => {
    const out = mappingChanges(
      'd1',
      [
        resolved('A', 'c1', { missingCodes: ['9', '8'] }),
        resolved('B', 'c2', { role: 'psu' }),
        resolved('C', 'c3', { missingCodes: ['8', '9'] }),
      ],
      new Map([
        ['A', saved('m1', 'c1', { missingCodes: ['9'] })],
        ['B', saved('m2', 'c2')],
        ['C', saved('m3', 'c3', { missingCodes: ['9', '8'] })],
      ]),
    );
    expect(out.toUpdate).toEqual([
      { id: 'm1', data: { missingCodes: ['9', '8'], role: null, certaintyCodes: [] } },
      { id: 'm2', data: { missingCodes: [], role: 'psu', certaintyCodes: [] } },
      // Same codes in another order are a change: the order is kept as entered.
      { id: 'm3', data: { missingCodes: ['8', '9'], role: null, certaintyCodes: [] } },
    ]);
  });
});

describe('canonicalUpdates', () => {
  it('confirms a changed type and fills an empty description from the dictionary', () => {
    const byId = new Map([
      ['c1', canonical('c1', 'EDAD', { dataType: 'text' })],
      ['c2', canonical('c2', 'SEXO', { description: 'Sexo' })],
      ['c3', canonical('c3', 'ENT', { dataType: 'text' })],
    ]);
    const out = canonicalUpdates(
      [
        resolved('EDAD', 'c1', { dataType: 'integer' }),
        resolved('SEXO', 'c2'),
        resolved('ENT', 'c3', { dataType: 'text' }),
        resolved('OTRA', null, { dataType: 'decimal' }),
      ],
      byId,
      new Map([
        ['EDAD', label('Edad en años')],
        ['SEXO', label('Sexo de la persona')],
      ]),
    );
    expect([...out]).toEqual([
      ['c1', { dataType: 'integer', description: 'Edad en años' }],
    ]);
  });
});
