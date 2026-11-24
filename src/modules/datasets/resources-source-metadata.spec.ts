import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisService } from '../analysis/analysis.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { createHarmonizerServices } from '../harmonizer/harmonizer.testing.js';
import { rawStorageKey } from '../harmonizer/edition-files.js';
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
    coverage: { level: 'country', code: '00', label: 'Nacional' },
    createdAt: new Date('2026-11-22T00:00:00Z'),
    survey: { name: 'ENOE' },
  };
  const survey = { id: 's1', name: 'ENOE', shortName: 'ENOE 2024', organizationId: 'o1' };
  const mapping = (sourceColumn: string, missingCodes: string[] = [], role: string | null = null) => ({
    sourceColumn,
    missingCodes,
    role,
    valueMap: {},
    datasetId: 'ed1',
    dataset: edition,
    canonicalVariableId: sourceColumn,
    canonicalVariable: { name: sourceColumn, role: null },
  });
  const mappings = [
    mapping('FOLIO'),
    mapping('EDAD', ['999']),
    mapping('FAC', [], 'weight'),
    mapping('EST', [], 'stratum'),
  ];
  const resources: Record<string, unknown>[] = [];
  const prisma = {
    harmonizerSurvey: { findUnique: vi.fn(async () => survey) },
    harmonizerDataset: {
      findUnique: vi.fn(async () => edition),
      findMany: vi.fn(async () => [{ ...edition, mappings }]),
    },
    harmonizerMapping: { findMany: vi.fn(async () => mappings) },
    harmonizerCanonicalVariable: {
      findMany: vi.fn(async () =>
        columns.map((name) => ({
          id: name,
          name,
          description: name === 'EDAD' ? 'Edad en años' : null,
          dataType: null,
          categories: null,
          reviewedSignature: null,
          role: name === 'EDAD' ? 'measure' : null,
          universe: null,
          positiveValue: null,
          geoLevel: null,
          unit: name === 'EDAD' ? 'años' : null,
          disaggregation: null,
        })),
      ),
    },
    harmonizerColumnProfile: { findMany: vi.fn(async () => []), createMany: vi.fn(async () => ({})) },
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
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
    },
  };
  const harmonizer = createHarmonizerServices(prisma as never, analysis, storage).exports;
  const service = new ResourcesService(prisma as never, storage, analysis, harmonizer);
  return { service, prisma, edition, mappings, storage, analysis };
}

const nacional = { level: 'country', code: '00', label: 'Nacional' };
const expected = {
  version: 2,
  title: 'ENOE',
  source: 'ENOE 2024',
  design: 'sample',
  unit: 'person',
  unitPlural: 'personas',
  total: nacional,
  editions: [{ id: 'ed1', name: 'ENOE 2024 T1', year: 2024, design: 'sample', unit: 'person', coverage: nacional, weight: 'FAC' }],
  columns: [
    { name: 'FOLIO', type: 'BIGINT' },
    // One cell had 999 before it became NULL (D13).
    { name: 'EDAD', type: 'BIGINT', role: 'measure', label: 'Edad en años', unit: 'años', missingCodes: ['999'], missingCodesAreNull: true, missingCount: { ed1: 1 } },
    { name: 'FAC', type: 'BIGINT', role: 'weight' },
    { name: 'EST', type: 'BIGINT', role: 'stratum' },
  ],
  origin: { surveyId: 's1', editionId: 'ed1', variables: ['FOLIO', 'EDAD', 'FAC', 'EST'], signature: expect.stringMatching(/^[0-9a-f]{64}$/) },
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
      unitPlural: 'hogares',
      editions: [{ ...expected.editions[0], unit: 'household', weight: 'EST' }],
      columns: [
        { name: 'FOLIO', type: 'BIGINT' },
        { ...expected.columns[1], missingCodes: ['998', '999'] },
        { name: 'FAC', type: 'BIGINT' },
        { name: 'EST', type: 'BIGINT', role: 'weight' },
      ],
    });
    const [first] = (await service.findAll('d1')) as Record<string, unknown>[];
    expect(first.sourceMetadata).toEqual(expected);
    // The signature tells the two apart, and the first one is out of date.
    const sig = (r: Record<string, unknown>) => (r.sourceMetadata as { origin: { signature: string } }).origin.signature;
    expect(sig(second)).not.toBe(sig(first));
    const storedById = (id: unknown) => async () =>
      (await prisma.resource.findMany()).find((r: Record<string, unknown>) => r.id === id);
    prisma.resource.findFirst = vi.fn(storedById(first.id));
    expect(await service.sourceStatus('d1', first.id as string)).toEqual({ linked: true, stale: true, reason: 'changed' });
    prisma.resource.findFirst = vi.fn(storedById(second.id));
    expect(await service.sourceStatus('d1', second.id as string)).toEqual({ linked: true, stale: false, reason: null });
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
      columns: expect.arrayContaining([expected.columns[1]]),
    });
  });

  it('an edition uploaded before SDI-135 (no design) still gets metadata, with design null', async () => {
    const { service, storage, analysis, edition } = await setup();
    (edition as { design: string | null }).design = null;
    const resource = (await service.attachHarmonized('d1', { editionId: 'ed1' })) as Record<string, unknown>;
    expect(resource.sourceMetadata).toMatchObject({ design: null, unit: 'person' });
    // Without a sample design there are no sample roles.
    expect((resource.sourceMetadata as { columns: { role?: string }[] }).columns.map((c) => c.role)).toEqual([
      undefined,
      'measure',
      undefined,
      undefined,
    ]);
    const footer = await analysis.readKvMetadata(storage.resolvePath(resource.storageKey as string));
    expect(JSON.parse(footer[SOURCE_METADATA_KEY])).toEqual(resource.sourceMetadata);
  });
});
