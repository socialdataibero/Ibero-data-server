import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ExportFile } from '../harmonizer/export-file.js';
import { ResourcesService, toResourceResponse } from './resources.service.js';

function setup(file: Partial<ExportFile> = {}) {
  const body = Readable.from([Buffer.from('PAR1....PAR1')]);
  const exported: ExportFile = {
    filename: 'harmonized_Censo_2020.parquet',
    contentType: 'application/vnd.apache.parquet',
    body,
    size: 12,
    ...file,
  };
  const saved: string[] = [];
  const storage = {
    saveStream: vi.fn(async (datasetId: string, name: string, stream: Readable) => {
      for await (const chunk of stream) saved.push(String(chunk));
      return `${datasetId}/uuid-${name}`;
    }),
    resolvePath: vi.fn((key: string) => `/storage/${key}`),
    remove: vi.fn(async () => undefined),
  };
  // Like Prisma: `sizeBytes` is a BIGINT column, read back as a `bigint`.
  const prisma = {
    resource: {
      create: vi.fn(async ({ data }) => ({ id: 'r1', ...data, sizeBytes: BigInt(data.sizeBytes) })),
    },
  };
  const analysis = { describeSchema: vi.fn(async () => [{ name: 'EDAD', type: 'BIGINT' }]) };
  const harmonizer = {
    exportDataset: vi.fn(async () => exported),
    exportSurvey: vi.fn(async () => exported),
  };
  const service = new ResourcesService(
    prisma as never,
    storage as never,
    analysis as never,
    harmonizer as never,
  );
  return { service, storage, prisma, harmonizer, body, saved };
}

describe('ResourcesService.attachHarmonized', () => {
  it('needs editionId, or surveyId with optional variables', async () => {
    const { service, harmonizer } = setup();
    for (const dto of [{}, { editionId: 'e', surveyId: 's' }, { editionId: 'e', variables: ['EDAD'] }]) {
      await expect(service.attachHarmonized('d1', dto)).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: 'harmonized_source_invalid' },
      });
    }
    expect(harmonizer.exportDataset).not.toHaveBeenCalled();
  });

  it('saves the edition Parquet straight to storage and creates the resource', async () => {
    const { service, storage, prisma, harmonizer, saved } = setup();
    const resource = await service.attachHarmonized('d1', { editionId: 'e1' });
    expect(harmonizer.exportDataset).toHaveBeenCalledWith('e1', 'parquet');
    expect(storage.saveStream).toHaveBeenCalledWith('d1', 'harmonized_Censo_2020.parquet', expect.any(Readable));
    expect(saved.join('')).toBe('PAR1....PAR1');
    expect(prisma.resource.create).toHaveBeenCalledWith({
      data: {
        datasetId: 'd1',
        filename: 'harmonized_Censo_2020.parquet',
        format: 'parquet',
        sizeBytes: 12,
        storageKey: 'd1/uuid-harmonized_Censo_2020.parquet',
        columns: [{ name: 'EDAD', type: 'BIGINT' }],
        sourceMetadata: Prisma.DbNull,
      },
    });
    expect(resource).toMatchObject({ id: 'r1', sizeBytes: 12 });
  });

  it('exports the survey with its variables', async () => {
    const { service, harmonizer } = setup();
    await service.attachHarmonized('d1', { surveyId: 's1', variables: ['EDAD', 'SEXO'] });
    expect(harmonizer.exportSurvey).toHaveBeenCalledWith('s1', 'parquet', ['EDAD', 'SEXO'], { forResource: true });
  });

  it('saves a view over 2 GB (it no longer fits a 32-bit size) and answers its size as a number', async () => {
    const size = 3_000_000_000;
    const { service, storage } = setup({ size });
    const resource = await service.attachHarmonized('d1', { editionId: 'e1' });
    expect(storage.saveStream).toHaveBeenCalled();
    expect(resource.sizeBytes).toBe(size);
    expect(JSON.parse(JSON.stringify(resource))).toMatchObject({ sizeBytes: size });
  });

  it('removes the stored file when the resource cannot be created', async () => {
    const { service, storage, prisma } = setup();
    prisma.resource.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.attachHarmonized('d1', { editionId: 'e1' })).rejects.toThrow('db down');
    expect(storage.remove).toHaveBeenCalledWith('d1/uuid-harmonized_Censo_2020.parquet');
  });
});

describe('toResourceResponse', () => {
  it('turns the BIGINT size into a JSON number, exact past 2^31 and 2^32', () => {
    const resource = { id: 'r1', filename: 'a.parquet', sizeBytes: 5_000_000_000n };
    expect(JSON.stringify(toResourceResponse(resource))).toBe(
      '{"id":"r1","filename":"a.parquet","sizeBytes":5000000000,"sourceMetadata":null}',
    );
    expect(() => JSON.stringify(resource)).toThrow(TypeError);
  });
});

describe('the resource in the API: source metadata (SDI-138)', () => {
  // As Postgres gives it back: jsonb sorts the keys, and a newer writer may add properties.
  const stored = {
    unit: 'person',
    design: 'sample',
    columns: [
      { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'] },
      { name: 'FAC', role: 'weight', type: 'BIGINT', universe: 'all' },
    ],
    version: 1,
    sourceEditionIds: ['ed1'],
    // A copy made before F2: said once for the whole file.
    missingCodesAreNull: true,
  };
  // A stored copy of version 1 answers as version 2.
  const metadata = {
    version: 2,
    title: null,
    source: null,
    design: 'sample',
    unit: 'person',
    unitPlural: 'personas',
    total: null,
    editions: [{ id: 'ed1', name: null, year: null, design: 'sample', unit: 'person', coverage: null, weight: 'FAC', certainty: null }],
    columns: [
      { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'], missingCodesAreNull: true },
      { name: 'FAC', type: 'BIGINT', role: 'weight' },
    ],
    origin: null,
  };
  const row = (id: string, sourceMetadata: unknown) => ({
    id,
    datasetId: 'd1',
    filename: `${id}.parquet`,
    format: 'parquet',
    sizeBytes: 10n,
    storageKey: `d1/${id}.parquet`,
    columns: [],
    sourceMetadata,
    createdAt: new Date(0),
  });

  function statusService(found: unknown) {
    const prisma = { resource: { findFirst: vi.fn(async () => found) } };
    return new ResourcesService(prisma as never, {} as never, {} as never, {} as never);
  }

  function listService(rows: unknown[]) {
    const prisma = { resource: { findMany: vi.fn(async () => rows) } };
    return new ResourcesService(prisma as never, {} as never, {} as never, {} as never);
  }

  it('a resource with metadata of version 1 answers it as version 2: design, unit, editions, codes and role', async () => {
    const [resource] = await listService([row('r1', stored)]).findAll('d1');
    expect(resource.sourceMetadata).toEqual(metadata);
    // The JSON a client receives.
    expect(JSON.parse(JSON.stringify(resource)).sourceMetadata).toEqual(metadata);
  });

  it('source-status: compares the stored signature with the current one, and reports a source that is gone', async () => {
    const linked = { ...metadata, origin: { surveyId: 's1', editionId: null, variables: ['EDAD'], signature: 'abc' } };
    const withSignature = (now: string | null) => {
      const prisma = { resource: { findFirst: vi.fn(async () => row('r1', linked)) } };
      const exports = { originSignature: vi.fn(async () => now) };
      return { service: new ResourcesService(prisma as never, {} as never, {} as never, exports as never), exports };
    };
    const same = withSignature('abc');
    expect(await same.service.sourceStatus('d1', 'r1')).toEqual({ linked: true, stale: false, reason: null });
    expect(same.exports.originSignature).toHaveBeenCalledWith('s1', null, ['EDAD']);
    expect(await withSignature('def').service.sourceStatus('d1', 'r1')).toEqual({ linked: true, stale: true, reason: 'changed' });
    expect(await withSignature(null).service.sourceStatus('d1', 'r1')).toEqual({ linked: true, stale: true, reason: 'source_missing' });
  });

  it('a resource without metadata answers sourceMetadata: null, without failing', async () => {
    const [uploaded, broken] = await listService([row('r2', null), row('r3', { version: 7 })]).findAll('d1');
    // An uploaded file is not linked to the harmonizer.
    expect(await statusService(row('r2', null)).sourceStatus('d1', 'r2')).toEqual({ linked: false, stale: false, reason: null });
    expect(uploaded).toHaveProperty('sourceMetadata', null);
    expect(broken).toHaveProperty('sourceMetadata', null);
    expect(JSON.parse(JSON.stringify(uploaded))).toHaveProperty('sourceMetadata', null);
  });
});
