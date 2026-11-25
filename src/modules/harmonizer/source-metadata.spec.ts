import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UploadDatasetDto } from './dto/upload-dataset.dto.js';
import { MappingChoiceDto } from './dto/mapping-choice.dto.js';
import { createHarmonizerServices } from './harmonizer.testing.js';
import {
  assertSourceRoles,
  normalizeCertaintyCodes,
  buildSourceMetadata,
  parseSourceMetadata,
  missingSourceInfo,
  sourceInfoRequiredBody,
  type MetadataEdition,
  type RoleChoice,
  type MetadataVariable,
} from './source-metadata.js';
import type { VariableAnalysis } from './variables/variable-role.js';

const upload = (fields: Record<string, unknown>) =>
  plainToInstance(UploadDatasetDto, { name: 'ENOE 2024', year: 2024, surveyId: 's1', ...fields });

const details = async (dto: object) =>
  (await validate(dto, { whitelist: true })).flatMap((e) => Object.values(e.constraints ?? {}));

/** The error body a check throws, or null if it passes. */
function thrown(fn: () => unknown): Record<string, unknown> | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as Record<string, unknown>;
  }
}

describe('upload: source design and unit', () => {
  it('without design: names the design', async () => {
    const dto = upload({ unit: 'person' });
    expect(await details(dto)).toEqual([]);
    expect(missingSourceInfo(dto)).toEqual(['design']);
    expect(sourceInfoRequiredBody(['design'])).toEqual({
      statusCode: 400,
      code: 'source_info_required',
      message: 'Missing the source design (census or sample).',
      params: { missing: ['design'] },
    });
  });

  it('without unit: names the unit', async () => {
    const dto = upload({ design: 'census' });
    expect(missingSourceInfo(dto)).toEqual(['unit']);
    expect(sourceInfoRequiredBody(['unit']).message).toBe(
      'Missing the unit of analysis (person, dwelling or household).',
    );
  });

  it('without both: one error names both', async () => {
    const dto = upload({});
    expect(missingSourceInfo(dto)).toEqual(['design', 'unit']);
    expect(sourceInfoRequiredBody(['design', 'unit'])).toMatchObject({
      message:
        'Missing the source design (census or sample) and the unit of analysis (person, dwelling or household).',
      params: { missing: ['design', 'unit'] },
    });
  });

  it('empty fields count as missing, not as invalid', async () => {
    const dto = upload({ design: '', unit: '' });
    expect(await details(dto)).toEqual([]);
    expect(missingSourceInfo(dto)).toEqual(['design', 'unit']);
  });

  it('rejects values outside the allowed ones', async () => {
    expect(await details(upload({ design: 'muestral', unit: 'house' }))).toEqual([
      'design must be one of: census, sample.',
      'unit must be one of: person, dwelling, household.',
    ]);
  });

  it('accepts every allowed value', async () => {
    for (const design of ['census', 'sample'])
      for (const unit of ['person', 'dwelling', 'household']) {
        const dto = upload({ design, unit });
        expect(await details(dto)).toEqual([]);
        expect(missingSourceInfo(dto)).toEqual([]);
      }
  });
});

describe('mapping: role values', () => {
  it('accepts weight, stratum, psu and null; rejects others', async () => {
    const choice = (role: unknown) => plainToInstance(MappingChoiceDto, { column: 'A', choice: '', role });
    for (const role of ['weight', 'stratum', 'psu', 'certainty', null, undefined])
      expect(await details(choice(role))).toEqual([]);
    expect(await details(choice('factor'))).toEqual(['role must be one of: weight, stratum, psu, certainty.']);
  });
});

describe('assertSourceRoles', () => {
  const col = (column: string, role?: string, mapped = true): RoleChoice => ({ column, mapped, role });

  it('sample without weight fails', () => {
    expect(thrown(() => assertSourceRoles('sample', [col('EDAD'), col('EST', 'stratum')]))).toMatchObject({
      code: 'sample_weight_required',
    });
  });

  it('sample with weight passes, with or without stratum and PSU', () => {
    expect(thrown(() => assertSourceRoles('sample', [col('EDAD'), col('FAC', 'weight')]))).toBeNull();
    expect(
      thrown(() =>
        assertSourceRoles('sample', [col('FAC', 'weight'), col('EST', 'stratum'), col('UPM', 'psu')]),
      ),
    ).toBeNull();
    expect(thrown(() => assertSourceRoles('sample', [col('FAC', 'weight'), col('UPM', 'psu')]))).toBeNull();
  });

  it('a role repeated in two columns fails', () => {
    expect(
      thrown(() => assertSourceRoles('sample', [col('F1', 'weight'), col('F2', 'weight')])),
    ).toMatchObject({ code: 'source_role_repeated', params: { role: 'weight', columns: ['F1', 'F2'] } });
  });

  it('a certainty column needs the codes of a completely enumerated stratum', () => {
    const cert = (codes?: string[]): RoleChoice => ({ column: 'COB', mapped: true, role: 'certainty', certaintyCodes: codes });
    for (const codes of [undefined, [], [' ', '']]) {
      expect(thrown(() => assertSourceRoles('sample', [col('FAC', 'weight'), cert(codes)]))).toMatchObject({
        code: 'certainty_codes_required',
        params: { column: 'COB' },
      });
    }
    expect(thrown(() => assertSourceRoles('sample', [col('FAC', 'weight'), cert(['1'])]))).toBeNull();
    expect(normalizeCertaintyCodes([' 1', '1', '', '3 '])).toEqual(['1', '3']);
  });

  it('a role on an unmapped column fails', () => {
    expect(
      thrown(() => assertSourceRoles('sample', [col('FAC', 'weight', false)])),
    ).toMatchObject({ code: 'source_role_unmapped', params: { column: 'FAC', role: 'weight' } });
  });

  it('census and editions without design take no roles, and need none', () => {
    expect(thrown(() => assertSourceRoles('census', [col('EDAD')]))).toBeNull();
    expect(thrown(() => assertSourceRoles(null, [col('EDAD')]))).toBeNull();
    expect(thrown(() => assertSourceRoles('census', [col('FAC', 'weight')]))).toMatchObject({
      code: 'source_role_not_allowed',
      params: { column: 'FAC', role: 'weight', design: 'census' },
    });
    expect(thrown(() => assertSourceRoles(null, [col('FAC', 'weight')]))).toMatchObject({
      code: 'source_role_not_allowed',
    });
  });
});

describe('saveMapping with roles', () => {
  const canonicals = [
    { id: 'v-edad', name: 'EDAD', description: null, dataType: null },
    { id: 'v-fac', name: 'FACTOR', description: null, dataType: null },
    { id: 'v-est', name: 'ESTRATO', description: null, dataType: null },
    { id: 'v-upm', name: 'UPM', description: null, dataType: null },
  ];

  function makeService(design: string | null) {
    const prisma: any = {
      harmonizerDataset: {
        findUnique: vi.fn(async () => ({
          id: 'd1',
          surveyId: 's1',
          name: 'ENOE 2024',
          year: 2024,
          columns: ['EDAD', 'FAC', 'EST', 'UPM'],
          rowCount: 10,
          design,
          unit: 'person',
          codebookId: null,
          codebookTable: null,
          survey: { name: 'ENOE' },
        })),
      },
      harmonizerCanonicalVariable: { findMany: vi.fn(async () => canonicals), update: vi.fn() },
      harmonizerMapping: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 0 })),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    return { service: createHarmonizerServices(prisma, {} as any, {} as any).mapping, prisma };
  }

  const columns = (roles: Record<string, string>) =>
    [
      ['EDAD', 'v-edad'],
      ['FAC', 'v-fac'],
      ['EST', 'v-est'],
      ['UPM', 'v-upm'],
    ].map(([column, id]) => ({ column, choice: `cv:${id}`, role: roles[column] as any }));

  const savedRoles = (prisma: any) =>
    Object.fromEntries(
      prisma.harmonizerMapping.createMany.mock.calls[0][0].data.map((m: any) => [m.sourceColumn, m.role]),
    );

  it('sample mapping without weight is rejected and nothing is written', async () => {
    const { service, prisma } = makeService('sample');
    await expect(service.saveMapping('d1', { columns: columns({ EST: 'stratum' }) })).rejects.toMatchObject({
      response: { code: 'sample_weight_required' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('sample mapping with weight is saved with its roles', async () => {
    const { service, prisma } = makeService('sample');
    await service.saveMapping('d1', { columns: columns({ FAC: 'weight', EST: 'stratum', UPM: 'psu' }) });
    expect(savedRoles(prisma)).toEqual({ EDAD: null, FAC: 'weight', EST: 'stratum', UPM: 'psu' });
  });

  it('sample mapping with weight and no stratum or PSU is saved', async () => {
    const { service, prisma } = makeService('sample');
    await service.saveMapping('d1', { columns: columns({ FAC: 'weight' }) });
    expect(savedRoles(prisma)).toEqual({ EDAD: null, FAC: 'weight', EST: null, UPM: null });
  });

  it('census mapping needs no weight', async () => {
    const { service, prisma } = makeService('census');
    await service.saveMapping('d1', { columns: columns({}) });
    expect(savedRoles(prisma)).toEqual({ EDAD: null, FAC: null, EST: null, UPM: null });
  });

  it('a saved role that changes is updated', async () => {
    const { service, prisma } = makeService('sample');
    prisma.harmonizerMapping.findMany.mockResolvedValueOnce([
      { id: 'm-fac', sourceColumn: 'FAC', canonicalVariableId: 'v-fac', missingCodes: [], role: null, certaintyCodes: [], valueMap: {} },
      { id: 'm-est', sourceColumn: 'EST', canonicalVariableId: 'v-est', missingCodes: [], role: 'weight', certaintyCodes: [], valueMap: {} },
    ]);
    await service.saveMapping('d1', { columns: columns({ FAC: 'weight', EST: 'stratum' }) });
    expect(prisma.harmonizerMapping.update).toHaveBeenCalledWith({
      where: { id: 'm-fac' },
      data: { missingCodes: [], role: 'weight', certaintyCodes: [] },
    });
    expect(prisma.harmonizerMapping.update).toHaveBeenCalledWith({
      where: { id: 'm-est' },
      data: { missingCodes: [], role: 'stratum', certaintyCodes: [] },
    });
  });
});

describe('buildSourceMetadata', () => {
  // A measure or a variable without a role: its codes are NULL in the file, counted per edition.
  const col = (canon: string, missingCodes: string[] = [], role: string | null = null, missingCount = 0) => ({
    canon,
    missingCodes,
    missingCodesAreNull: true,
    ...(missingCodes.length > 0 ? { missingCount } : {}),
    role,
  });
  // A variable of codes: its codes stay in the file.
  const kept = (canon: string, missingCodes: string[]) => ({
    canon,
    missingCodes,
    missingCodesAreNull: false,
    role: null,
  });
  const ags = { level: 'state' as const, code: '01', label: 'Aguascalientes' };
  const edition = (
    id: string,
    columns: MetadataEdition['columns'],
    design: string | null = 'sample',
    unit: string | null = 'person',
    coverage: MetadataEdition['coverage'] = ags,
  ): MetadataEdition => ({ id, name: `Edición ${id}`, year: 2000 + Number(id.slice(1)), design, unit, coverage, columns });
  const types = { _dataset: 'VARCHAR', _year: 'BIGINT', _row: 'BIGINT', EDAD: 'BIGINT', FAC: 'DOUBLE', EST: 'BIGINT', HLI: 'VARCHAR', MESRET: 'VARCHAR' };
  const origin = { surveyId: 's1', editionId: null, variables: ['EDAD'], signature: 'abc' };
  const empty = { label: null, categories: [], codeReview: null };
  const analysis = (a: Partial<VariableAnalysis>): VariableAnalysis => ({
    role: null,
    universe: null,
    universeRule: null,
    positiveValue: null,
    geoLevel: null,
    unit: null,
    disaggregation: null,
    ...a,
  });
  const build = (editions: MetadataEdition[], headers: string[], variables = new Map<string, MetadataVariable>()) =>
    buildSourceMetadata({
      survey: { name: 'Censo 2000 muestra', shortName: 'Censo 2000' },
      editions,
      variables,
      headers,
      types,
      origin,
    });

  it('one sample edition: survey, editions, design, unit, total, codes, roles and origin', () => {
    expect(
      build([edition('e1', [col('EDAD', ['999'], null, 12), col('FAC', [], 'weight'), col('EST', [], 'stratum')])], ['EDAD', 'FAC', 'EST']),
    ).toEqual({
      version: 2,
      title: 'Censo 2000 muestra',
      source: 'Censo 2000',
      design: 'sample',
      unit: 'person',
      unitPlural: 'personas',
      total: ags,
      editions: [{ id: 'e1', name: 'Edición e1', year: 2001, design: 'sample', unit: 'person', coverage: ags, weight: 'FAC', certainty: null }],
      columns: [
        { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'], missingCodesAreNull: true, missingCount: { e1: 12 } },
        { name: 'FAC', type: 'DOUBLE', role: 'weight' },
        { name: 'EST', type: 'BIGINT', role: 'stratum' },
      ],
      origin,
    });
  });

  it('an edition says which strata were enumerated completely, with the codes as in the file', () => {
    const cob = { ...col('COB', [], 'certainty'), certaintyCodes: ['C'] };
    const meta = build([edition('e1', [col('FAC', [], 'weight'), cob]), edition('e2', [col('FAC', [], 'weight')])], ['FAC', 'COB']);
    expect(meta?.editions.map((e) => e.certainty)).toEqual([{ column: 'COB', codes: ['C'] }, null]);
    // A role only some editions give is not the column's role.
    expect(meta?.columns.find((c) => c.name === 'COB')?.role).toBeUndefined();
    const one = build([edition('e1', [col('FAC', [], 'weight'), cob])], ['FAC', 'COB']);
    expect(one?.columns.find((c) => c.name === 'COB')?.role).toBe('certainty');
    // Not in the file (left out of the view): no certainty.
    expect(build([edition('e1', [col('FAC', [], 'weight'), cob])], ['FAC'])?.editions[0].certainty).toBeNull();
    expect(parseSourceMetadata(structuredClone(one))?.editions[0].certainty).toEqual({ column: 'COB', codes: ['C'] });
  });

  it('a universe rule travels with the column, as a column of the file', () => {
    const variables = new Map<string, MetadataVariable>([
      ['HLI', { ...empty, analysis: analysis({ role: 'ordinal', universe: 'población de 15 años y más', universeRule: { variable: 'EDAD', min: 15 } }) }],
    ]);
    const meta = build([edition('e1', [col('FAC', [], 'weight'), col('HLI'), col('EDAD')])], ['FAC', 'HLI', 'EDAD'], variables);
    const hli = meta?.columns.find((c) => c.name === 'HLI');
    expect(hli?.universeRule).toEqual({ column: 'EDAD', min: 15 });
    expect(parseSourceMetadata(structuredClone(meta))?.columns.find((c) => c.name === 'HLI')?.universeRule).toEqual({ column: 'EDAD', min: 15 });
    expect(meta?.columns.find((c) => c.name === 'EDAD')?.universeRule).toBeUndefined();
  });

  it('describes each variable: role, label, universe, categories, "yes" code, groups and code review', () => {
    const variables = new Map<string, MetadataVariable>([
      [
        'HLI',
        {
          label: 'Habla lengua indígena',
          analysis: analysis({
            role: 'dichotomous',
            universe: 'población de 5 años y más',
            positiveValue: '1',
            disaggregation: { summable: true, notApplicableLabel: 'No aplica (menores de 5 años)' },
          }),
          categories: [
            { code: '1', label: 'Sí', kind: 'value' },
            { code: '2', label: 'No', kind: 'value' },
            { code: '9', label: 'No especificado', kind: 'missing' },
          ],
          codeReview: 'ok',
        },
      ],
      [
        'EDAD',
        {
          ...empty,
          label: 'Edad',
          analysis: analysis({
            role: 'measure',
            unit: 'años',
            disaggregation: { summable: true, cuts: [{ from: 0, to: 14, label: '0 a 14' }, { from: 15, to: null, label: '15 y más' }] },
          }),
        },
      ],
      // A sample role wins over the use in analysis.
      ['FAC', { ...empty, analysis: analysis({ role: 'measure' }) }],
    ]);
    const meta = build(
      [edition('e1', [kept('HLI', ['9']), col('EDAD', ['999'], null, 3), col('FAC', [], 'weight')])],
      ['HLI', 'EDAD', 'FAC'],
      variables,
    );
    expect(meta?.columns).toEqual([
      {
        name: 'HLI',
        type: 'VARCHAR',
        role: 'dichotomous',
        label: 'Habla lengua indígena',
        universe: 'población de 5 años y más',
        categories: variables.get('HLI')!.categories,
        positiveValue: '1',
        notApplicableLabel: 'No aplica (menores de 5 años)',
        disaggregation: { summable: true },
        codeReview: 'ok',
        missingCodes: ['9'],
        missingCodesAreNull: false,
      },
      {
        name: 'EDAD',
        type: 'BIGINT',
        role: 'measure',
        label: 'Edad',
        unit: 'años',
        disaggregation: { summable: true, cuts: [{ from: 0, to: 14, label: '0 a 14' }, { from: 15, to: null, label: '15 y más' }] },
        missingCodes: ['999'],
        missingCodesAreNull: true,
        missingCount: { e1: 3 },
      },
      { name: 'FAC', type: 'DOUBLE', role: 'weight' },
    ]);
  });

  it('a census edition has no sample roles', () => {
    const meta = build([edition('e1', [col('FAC', [], 'weight')], 'census')], ['FAC']);
    expect(meta?.design).toBe('census');
    expect(meta?.columns).toEqual([{ name: 'FAC', type: 'DOUBLE' }]);
  });

  it('only without editions there is no metadata; an edition without design or unit leaves them null', () => {
    expect(build([], [])).toBeNull();
    const meta = build([edition('e1', [], null, null, null)], []);
    expect(meta).toMatchObject({ design: null, unit: null, unitPlural: null, total: null });
    expect(meta?.editions[0]).toMatchObject({ design: null, unit: null, coverage: null, weight: null });
  });

  it('a survey: origin columns, codes joined, roles kept when every edition agrees', () => {
    const meta = build(
      [
        edition('e1', [col('EDAD', ['999'], null, 3), col('FAC', [], 'weight'), col('EST', [], 'stratum')]),
        edition('e2', [col('EDAD', ['99', '999'], null, 5), col('FAC', [], 'weight'), col('EST')]),
      ],
      ['_dataset', '_year', '_row', 'EDAD', 'FAC', 'EST'],
    );
    expect(meta?.editions.map((e) => [e.id, e.weight])).toEqual([['e1', 'FAC'], ['e2', 'FAC']]);
    expect(meta?.columns).toEqual([
      { name: '_dataset', type: 'VARCHAR' },
      { name: '_year', type: 'BIGINT' },
      { name: '_row', type: 'BIGINT' },
      { name: 'EDAD', type: 'BIGINT', missingCodes: ['999', '99'], missingCodesAreNull: true, missingCount: { e1: 3, e2: 5 } },
      { name: 'FAC', type: 'DOUBLE', role: 'weight' },
      // Stratum in only one of the editions: not a stratum of the whole file.
      { name: 'EST', type: 'BIGINT' },
    ]);
  });

  it('a variable of codes keeps its codes in the file: not NULL, not counted', () => {
    const meta = build(
      [
        edition('e1', [kept('MESRET', ['99']), col('EDAD', ['999'], null, 4)]),
        // An edition without the measure: it is not in its count.
        edition('e2', [kept('MESRET', ['99', '98'])]),
      ],
      ['_dataset', '_year', '_row', 'MESRET', 'EDAD'],
    );
    expect(meta?.columns.slice(3)).toEqual([
      { name: 'MESRET', type: 'VARCHAR', missingCodes: ['99', '98'], missingCodesAreNull: false },
      { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'], missingCodesAreNull: true, missingCount: { e1: 4 } },
    ]);
  });

  it('editions that differ in design, unit, coverage or factor: root null, each edition its own', () => {
    const headers = ['_dataset', '_year', '_row', 'FAC', 'FAC2', 'EST'];
    const other = { level: 'state' as const, code: '02', label: 'Baja California' };
    const mixed = build(
      [edition('e1', [col('FAC', [], 'weight'), col('EST')]), edition('e2', [col('FAC2', [], 'weight')], 'census', 'household', other)],
      headers,
    );
    expect(mixed).toMatchObject({ design: null, unit: null, unitPlural: null, total: null });
    expect(mixed?.editions.map((e) => [e.design, e.unit, e.coverage?.code, e.weight])).toEqual([
      ['sample', 'person', '01', 'FAC'],
      ['census', 'household', '02', 'FAC2'],
    ]);
    // Two sample editions with different factors: no column is the factor of the whole file.
    const twoFactors = build([edition('e1', [col('FAC', [], 'weight')]), edition('e2', [col('FAC2', [], 'weight')])], headers);
    expect(twoFactors?.design).toBe('sample');
    expect(twoFactors?.columns.filter((c) => c.role)).toEqual([]);
    expect(twoFactors?.editions.map((e) => e.weight)).toEqual(['FAC', 'FAC2']);
  });

  it('the factor of an edition is given only when it is a column of the file', () => {
    expect(build([edition('e1', [col('FAC', [], 'weight')])], ['EDAD'])?.editions[0].weight).toBeNull();
  });
});

describe('parseSourceMetadata', () => {
  const stored = {
    version: 2,
    title: 'Censo 2000 muestra',
    source: 'Censo 2000',
    design: 'sample',
    unit: 'person',
    unitPlural: 'personas',
    total: { level: 'state', code: '01', label: 'Aguascalientes' },
    editions: [
      { id: 'e1', name: 'Muestra 2000', year: 2000, design: 'sample', unit: 'person', coverage: { level: 'state', code: '01', label: 'Aguascalientes' }, weight: 'FAC', certainty: null },
    ],
    columns: [
      { name: 'EDAD', type: 'BIGINT', role: 'measure', label: 'Edad', unit: 'años', disaggregation: { summable: true, cuts: [{ from: 0, to: null, label: 'Todas' }] }, missingCodes: ['999'], missingCodesAreNull: true, missingCount: { e1: 7 } },
      {
        name: 'HLI',
        type: 'VARCHAR',
        role: 'dichotomous',
        universe: 'población de 5 años y más',
        categories: [
          { code: '1', label: 'Sí', kind: 'value' },
          { code: '9', label: null, kind: 'missing' },
        ],
        positiveValue: '1',
        notApplicableLabel: 'No aplica',
        codeReview: 'reviewed',
        missingCodes: ['9'],
        missingCodesAreNull: false,
      },
      { name: 'MUN', type: 'VARCHAR', role: 'geographic', geoLevel: 'municipality' },
      { name: 'FAC', type: 'DOUBLE', role: 'weight' },
    ],
    origin: { surveyId: 's1', editionId: 'e1', variables: ['EDAD', 'HLI', 'MUN', 'FAC'], signature: 'abc' },
  };

  it('reads what buildSourceMetadata writes', () => {
    expect(parseSourceMetadata(structuredClone(stored))).toEqual(stored);
  });

  it('ignores properties it does not know and keeps a role added later', () => {
    const newer = structuredClone(stored) as Record<string, unknown> & typeof stored;
    newer.license = 'CC-BY';
    (newer.columns[3] as Record<string, unknown>).valueLabels = { 1: 'Hombre' };
    newer.columns.push({ name: 'CONG', type: 'BIGINT', role: 'cluster' });
    expect(parseSourceMetadata(newer)).toEqual({
      ...stored,
      columns: [...stored.columns, { name: 'CONG', type: 'BIGINT', role: 'cluster' }],
    });
  });

  it('reads a copy of version 1 as version 2: editions by id, sample roles, no origin', () => {
    const v1 = {
      version: 1,
      design: 'sample',
      unit: 'person',
      sourceEditionIds: ['e1', 'e2'],
      columns: [
        { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'], missingCodesAreNull: true, missingCount: { e1: 7 } },
        { name: 'HLI', type: 'VARCHAR', missingCodes: ['9'], missingCodesAreNull: false },
        { name: 'FAC', type: 'DOUBLE', role: 'weight' },
      ],
    };
    const edition = (id: string) => ({ id, name: null, year: null, design: 'sample', unit: 'person', coverage: null, weight: 'FAC', certainty: null });
    expect(parseSourceMetadata(v1)).toEqual({
      version: 2,
      title: null,
      source: null,
      design: 'sample',
      unit: 'person',
      unitPlural: 'personas',
      total: null,
      editions: [edition('e1'), edition('e2')],
      columns: v1.columns,
      origin: null,
    });
  });

  it('reads a copy made before F2 (one missingCodesAreNull for the whole file) as true per column', () => {
    const before = {
      version: 1,
      design: 'census',
      unit: 'person',
      sourceEditionIds: ['e1'],
      missingCodesAreNull: true,
      columns: [{ name: 'EDAD', type: 'BIGINT', missingCodes: ['999'] }],
    };
    expect(parseSourceMetadata(before)?.columns).toEqual([
      { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'], missingCodesAreNull: true },
    ]);
  });

  it('no metadata, an unknown version or a malformed one is null', () => {
    expect(parseSourceMetadata(null)).toBeNull();
    expect(parseSourceMetadata(undefined)).toBeNull();
    expect(parseSourceMetadata({ ...stored, version: 3 })).toBeNull();
    expect(parseSourceMetadata({ ...stored, design: 'muestral' })).toBeNull();
    expect(parseSourceMetadata({ ...stored, columns: [{ name: 'EDAD' }] })).toBeNull();
    expect(parseSourceMetadata({ ...stored, editions: [{ name: 'sin id' }] })).toBeNull();
    expect(
      parseSourceMetadata({ ...stored, columns: [{ name: 'HLI', type: 'VARCHAR', categories: [{ code: '1', label: 'Sí', kind: 'otro' }] }] })?.columns,
    ).toEqual([{ name: 'HLI', type: 'VARCHAR' }]);
    expect(
      parseSourceMetadata({ ...stored, columns: [{ name: 'EDAD', type: 'BIGINT', missingCodes: ['9'], missingCount: { e1: '3' } }] }),
    ).toBeNull();
  });
});
