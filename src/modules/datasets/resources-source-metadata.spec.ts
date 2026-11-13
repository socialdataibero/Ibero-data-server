import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisService } from '../analysis/analysis.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { HarmonizerService, rawStorageKey } from '../harmonizer/harmonizer.service.js';
import { SOURCE_METADATA_KEY } from '../harmonizer/source-metadata.js';
import { ResourcesService } from './resources.service.js';

/**
 * "Usar en un dataset" end to end, with the real export (DuckDB over a stored edition) and
 * the real storage; only the database is simulated.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'resource-metadata-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const analysis = new AnalysisService({ threads: '2' });
  const storage = new LocalStorageService();
  Object.defineProperty(storage, 'root', { value: root });

  // A sample edition: FAC is the expansion factor, EST the stratum, 999 is "not specified" in EDAD.
  const columns = ['FOLIO', 'EDAD', 'FAC', 'EST'];
  const rows = [
    ['1001', '34', '245', '1'],
    ['1002', '999', '310', '2'],
    ['1003', '61', '180', '1'],
  ];
  const rawPath = storage.resolvePath(rawStorageKey('ed1'));
  await mkdir(dirname(rawPath), { recursive: true });
  const raw = ['c0', 'c1', 'c2', 'c3'];
  await analysis.writeRowsToParquet(
    raw,
    rows.map((r) => Object.fromEntries(r.map((v, i) => [raw[i], v]))),
    rawPath,
  );

  const edition = {
    id: 'ed1',
    surveyId: 's1',
    name: 'ENOE 2024 T1',
    year: 2024,
    columns,
    rowCount: rows.length,
    design: 'sample',
    unit: 'person',
    codebookId: null,
    codebookTable: null,
    survey: { name: 'ENOE' },
  };
  const mapping = (sourceColumn: string, missingCodes: string[] = [], role: string | null = null) => ({
    sourceColumn,
    missingCodes,
    role,
    valueMap: {},
    canonicalVariable: { name: sourceColumn },
  });
  const mappings = [
    mapping('FOLIO'),
    mapping('EDAD', ['999']),
    mapping('FAC', [], 'weight'),
    mapping('EST', [], 'stratum'),
  ];
  const resources: Record<string, unknown>[] = [];
  const prisma = {
    harmonizerDataset: { findUnique: vi.fn(async () => edition) },
    harmonizerMapping: { findMany: vi.fn(async () => mappings) },
    harmonizerCanonicalVariable: {
      findMany: vi.fn(async () => columns.map((name) => ({ name, dataType: null }))),
    },
    harmonizerColumnCheck: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({})) },
    resource: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        // Like Prisma: BIGINT reads back as bigint, and a JSON `DbNull` as null.
        const resource = {
          id: `r${resources.length + 1}`,
          ...data,
          sizeBytes: BigInt(data.sizeBytes as number),
          sourceMetadata: data.sourceMetadata === Prisma.DbNull ? null : data.sourceMetadata,
        };
        resources.push(resource);
        return resource;
      }),
      findMany: vi.fn(async () => resources),
    },
  };
  const harmonizer = new HarmonizerService(prisma as never, analysis, storage);
  const service = new ResourcesService(prisma as never, storage, analysis, harmonizer);
  return { service, prisma, edition, mappings, storage, analysis };
}

const expected = {
  version: 1,
  design: 'sample',
  unit: 'person',
  sourceEditionIds: ['ed1'],
  missingCodesAreNull: true,
  columns: [
    { name: 'FOLIO', type: 'BIGINT' },
    { name: 'EDAD', type: 'BIGINT', missingCodes: ['999'] },
    { name: 'FAC', type: 'BIGINT', role: 'weight' },
    { name: 'EST', type: 'BIGINT', role: 'stratum' },
  ],
};

describe('"Usar en un dataset" copies the source metadata', () => {
  it('stores design, unit, the 999 code, the weight and the edition id', async () => {
    const { service } = await setup();
    const resource = (await service.attachHarmonized('d1', { editionId: 'ed1' })) as Record<string, unknown>;
    expect(resource.sourceMetadata).toEqual(expected);
    // What was stored before (name and type of each column) is still there, and agrees.
    expect(resource.columns).toEqual(expected.columns.map(({ name, type }) => ({ name, type })));
  });

  it('is a snapshot: changing the mapping or the design afterwards does not change it', async () => {
    const { service, prisma, edition, mappings } = await setup();
    await service.attachHarmonized('d1', { editionId: 'ed1' });

    mappings[1].missingCodes = ['998', '999'];
    mappings[2].role = null;
    mappings[3].role = 'weight';
    edition.unit = 'household';

    const reads = prisma.harmonizerMapping.findMany.mock.calls.length;
    const [stored] = (await service.findAll('d1')) as Record<string, unknown>[];
    expect(stored.sourceMetadata).toEqual(expected);
    // Reading the resource never looks at the edition's current mapping.
    expect(prisma.harmonizerMapping.findMany.mock.calls.length).toBe(reads);

    // A resource created now copies the new state; the first one keeps its own.
    const second = (await service.attachHarmonized('d1', { editionId: 'ed1' })) as Record<string, unknown>;
    expect(second.sourceMetadata).toEqual({
      ...expected,
      unit: 'household',
      columns: [
        { name: 'FOLIO', type: 'BIGINT' },
        { name: 'EDAD', type: 'BIGINT', missingCodes: ['998', '999'] },
        { name: 'FAC', type: 'BIGINT' },
        { name: 'EST', type: 'BIGINT', role: 'weight' },
      ],
    });
    const [first] = (await service.findAll('d1')) as Record<string, unknown>[];
    expect(first.sourceMetadata).toEqual(expected);
  });
});

describe('"Usar en un dataset" keeps the metadata in the Parquet footer', () => {
  it('the stored resource file has in its footer exactly the metadata of the record', async () => {
    const { service, storage, analysis } = await setup();
    const resource = (await service.attachHarmonized('d1', { editionId: 'ed1' })) as Record<string, unknown>;
    // The file as it stays in storage, after the export's temporary file and the copy.
    const path = storage.resolvePath(resource.storageKey as string);
    expect(path.startsWith(root)).toBe(true);
    const footer = await analysis.readKvMetadata(path);
    expect(Object.keys(footer)).toEqual([SOURCE_METADATA_KEY]);
    const fromFile = JSON.parse(footer[SOURCE_METADATA_KEY]);
    expect(fromFile).toEqual(resource.sourceMetadata);
    expect(fromFile).toMatchObject({
      design: 'sample',
      unit: 'person',
      columns: expect.arrayContaining([{ name: 'EDAD', type: 'BIGINT', missingCodes: ['999'] }]),
    });
  });

  it('a view without metadata (an edition uploaded before SDI-135) writes no footer key', async () => {
    const { service, storage, analysis, edition } = await setup();
    (edition as { design: string | null }).design = null;
    const resource = (await service.attachHarmonized('d1', { editionId: 'ed1' })) as Record<string, unknown>;
    expect(resource.sourceMetadata).toBeNull();
    expect(await analysis.readKvMetadata(storage.resolvePath(resource.storageKey as string))).toEqual({});
  });
});
