import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UploadDatasetDto } from './dto/upload-dataset.dto.js';
import { MappingChoiceDto } from './dto/mapping-choice.dto.js';
import { HarmonizerService } from './harmonizer.service.js';
import {
  assertSourceRoles,
  missingSourceInfo,
  sourceInfoRequiredBody,
  type RoleChoice,
} from './source-metadata.js';

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
    for (const role of ['weight', 'stratum', 'psu', null, undefined])
      expect(await details(choice(role))).toEqual([]);
    expect(await details(choice('factor'))).toEqual(['role must be one of: weight, stratum, psu.']);
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
    return { service: new HarmonizerService(prisma, {} as any, {} as any), prisma };
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
      { id: 'm-fac', sourceColumn: 'FAC', canonicalVariableId: 'v-fac', missingCodes: [], role: null, valueMap: {} },
      { id: 'm-est', sourceColumn: 'EST', canonicalVariableId: 'v-est', missingCodes: [], role: 'weight', valueMap: {} },
    ]);
    await service.saveMapping('d1', { columns: columns({ FAC: 'weight', EST: 'stratum' }) });
    expect(prisma.harmonizerMapping.update).toHaveBeenCalledWith({
      where: { id: 'm-fac' },
      data: { missingCodes: [], role: 'weight' },
    });
    expect(prisma.harmonizerMapping.update).toHaveBeenCalledWith({
      where: { id: 'm-est' },
      data: { missingCodes: [], role: 'stratum' },
    });
  });
});
