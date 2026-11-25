import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ResourceMetadataService,
  categoriesOf,
  columnMetadata,
  columnsWithRole,
  editionWeight,
  isSample,
  missingCodesOf,
  roleColumn,
  roleOf,
  universeOf,
  weightColumn,
  type SourceMetadata,
} from './resource-metadata.js';

const sample: SourceMetadata = {
  version: 2,
  title: 'ENOE 2024',
  source: 'ENOE',
  design: 'sample',
  unit: 'person',
  unitPlural: 'personas',
  total: null,
  editions: [{ id: 'ed1', name: 'ENOE 2024', year: 2024, design: 'sample', unit: 'person', coverage: null, weight: 'FAC', certainty: null }],
  columns: [
    { name: 'EDAD', type: 'BIGINT', role: 'measure', missingCodes: ['999'], missingCodesAreNull: true },
    { name: 'FAC', type: 'BIGINT', role: 'weight' },
    { name: 'EST', type: 'BIGINT', role: 'stratum' },
    {
      name: 'SEXO',
      type: 'VARCHAR',
      role: 'category',
      universe: 'toda la población',
      categories: [
        { code: '1', label: 'Hombre', kind: 'value' },
        { code: '2', label: 'Mujer', kind: 'value' },
      ],
    },
    { name: 'ENT', type: 'VARCHAR', role: 'geographic', geoLevel: 'state' },
  ],
  origin: { surveyId: 's1', editionId: 'ed1', variables: ['EDAD', 'FAC', 'EST', 'SEXO', 'ENT'], signature: 'abc' },
};

describe('source metadata helpers', () => {
  it('find the expansion factor and the other roles', () => {
    expect(weightColumn(sample)).toBe('FAC');
    expect(roleColumn(sample, 'stratum')).toBe('EST');
    expect(roleColumn(sample, 'psu')).toBeNull();
    expect(isSample(sample)).toBe(true);
  });

  it('give the "not specified" codes of a column', () => {
    expect(missingCodesOf(sample, 'EDAD')).toEqual(['999']);
    expect(missingCodesOf(sample, 'FAC')).toEqual([]);
    expect(missingCodesOf(sample, 'NOPE')).toEqual([]);
    expect(columnMetadata(sample, 'FAC')).toEqual({ name: 'FAC', type: 'BIGINT', role: 'weight' });
  });

  it('give roles, categories, universe and the factor of each edition', () => {
    expect(roleOf(sample, 'SEXO')).toBe('category');
    expect(roleOf(sample, 'NOPE')).toBeNull();
    expect(columnsWithRole(sample, 'category', 'geographic').map((c) => c.name)).toEqual(['SEXO', 'ENT']);
    expect(categoriesOf(sample, 'SEXO').map((c) => c.label)).toEqual(['Hombre', 'Mujer']);
    expect(categoriesOf(sample, 'EDAD')).toEqual([]);
    expect(universeOf(sample, 'SEXO')).toBe('toda la población');
    expect(universeOf(sample, 'EDAD')).toBeNull();
    expect(editionWeight(sample, 'ed1')).toBe('FAC');
    expect(editionWeight(sample, 'other')).toBeNull();
  });

  it('work on resources without metadata', () => {
    expect(weightColumn(null)).toBeNull();
    expect(roleOf(null, 'EDAD')).toBeNull();
    expect(columnsWithRole(null, 'measure')).toEqual([]);
    expect(missingCodesOf(null, 'EDAD')).toEqual([]);
    expect(columnMetadata(null, 'EDAD')).toBeNull();
    expect(isSample(null)).toBe(false);
  });
});

describe('ResourceMetadataService.forResource', () => {
  function service(found: unknown) {
    const prisma = { resource: { findFirst: vi.fn(async () => found) } };
    return { service: new ResourceMetadataService(prisma as never), prisma };
  }

  it('reads the copy stored in the resource', async () => {
    const { service: s, prisma } = service({ sourceMetadata: { ...sample, extra: 1 } });
    expect(await s.forResource('d1', 'r1')).toEqual(sample);
    expect(prisma.resource.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', datasetId: 'd1' },
      select: { sourceMetadata: true },
    });
  });

  it('is null for a resource without metadata', async () => {
    expect(await service({ sourceMetadata: null }).service.forResource('d1', 'r1')).toBeNull();
  });

  it('a resource of another dataset is not found', async () => {
    await expect(service(null).service.forResource('d1', 'r1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
