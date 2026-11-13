import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  ResourceMetadataService,
  columnMetadata,
  isSample,
  missingCodesOf,
  roleColumn,
  weightColumn,
  type SourceMetadata,
} from './resource-metadata.js';

const sample: SourceMetadata = {
  version: 1,
  design: 'sample',
  unit: 'person',
  sourceEditionIds: ['ed1'],
  missingCodesAreNull: true,
  columns: [
    { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'] },
    { name: 'FAC', type: 'BIGINT', role: 'weight' },
    { name: 'EST', type: 'BIGINT', role: 'stratum' },
  ],
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

  it('work on resources without metadata', () => {
    expect(weightColumn(null)).toBeNull();
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
