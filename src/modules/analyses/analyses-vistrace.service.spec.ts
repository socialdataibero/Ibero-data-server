import { BadRequestException } from '@nestjs/common';
import { AnalysesService } from './analyses.service.js';
import type { SaveVistraceAnalysisDto } from './dto/save-vistrace-analysis.dto.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  writeFile: vi.fn(async () => undefined),
}));

const PARQUET = Buffer.concat([Buffer.from('PAR1'), Buffer.alloc(16), Buffer.from('PAR1')]);

function makeService() {
  const resources = new Map<string, any>([
    ['res-a', { id: 'res-a', datasetId: 'd1' }],
    ['res-other', { id: 'res-other', datasetId: 'd2' }],
  ]);
  const analyses = new Map<string, any>();

  const prisma = {
    resource: {
      findFirst: vi.fn(async ({ where }: any) => {
        const r = resources.get(where.id);
        return r && r.datasetId === where.datasetId ? r : null;
      }),
      count: vi.fn(async ({ where }: any) =>
        (where.id.in as string[]).filter((id) => resources.get(id)?.datasetId === where.datasetId).length,
      ),
    },
    analysis: {
      findUnique: vi.fn(async ({ where }: any) => [...analyses.values()].find((a) => a.slug === where.slug) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        const a = analyses.get(where.id);
        return a && a.datasetId === where.datasetId ? a : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const created = { id: 'an-1', ...data };
        analyses.set(created.id, created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const updated = { ...analyses.get(where.id), ...data };
        analyses.set(where.id, updated);
        return updated;
      }),
    },
  };
  const storage = {
    resolvePath: vi.fn((key: string) => `/storage/${key}`),
    ensureDir: vi.fn(async () => undefined),
  };
  const analysisService = {
    describeSchema: vi.fn(async () => [{ name: 'total', type: 'DOUBLE' }]),
    runQuery: vi.fn(async () => ({ columns: ['n'], rows: [{ n: 42 }] })),
  };

  const service = new AnalysesService(prisma as any, storage as any, analysisService as any);
  return { service, prisma, analyses };
}

function recipe(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    resultNodeId: 't1',
    state: {
      canvas: { pages: [{ id: 'p1', name: 'Análisis', order: 0 }] },
      dag: {
        nodes: {
          f1: { id: 'f1', type: 'from', pageId: 'p1', config: { tableName: 'hogares' }, result: { rows: [1, 2] }, status: 'success' },
          t1: { id: 't1', type: 'table', pageId: 'p1', config: {}, result: { rows: [1] }, status: 'success' },
        },
        edges: [{ id: 'e1', fromNodeId: 'f1', toNodeId: 't1', toInputIndex: 0 }],
      },
    },
    tables: [{ tableName: 'hogares', resourceId: 'res-a' }],
    ...overrides,
  });
}

function dto(overrides: Partial<SaveVistraceAnalysisDto> = {}): SaveVistraceAnalysisDto {
  return {
    sourceResourceId: 'res-a',
    title: 'Ingreso',
    slug: 'ingreso',
    folder: 'vistrace',
    recipe: recipe(),
    ...overrides,
  };
}

describe('AnalysesService: analyses saved from vistrace', () => {
  it('creates the analysis with origin VISTRACE, the recipe without results and the received parquet', async () => {
    const { service } = makeService();

    const result = await service.createFromVistrace('d1', dto(), { buffer: PARQUET }, 'user-1');

    expect(result).toMatchObject({
      origin: 'VISTRACE',
      status: 'DONE',
      recipe: [],
      resultStorageKey: 'analyses/an-1.parquet',
      resultRowCount: 42,
    });
    const nodes = (result as any).vistraceRecipe.state.dag.nodes;
    expect(nodes.f1).toMatchObject({ result: null, status: 'idle', config: { tableName: 'hogares' } });
    expect((result as any).vistraceRecipe.tables).toEqual([{ tableName: 'hogares', resourceId: 'res-a' }]);
  });

  it('rechaza un archivo que no es parquet', async () => {
    const { service } = makeService();
    await expect(
      service.createFromVistrace('d1', dto(), { buffer: Buffer.from('a,b\n1,2') }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza tablas que apuntan a resources de otro dataset', async () => {
    const { service } = makeService();
    const bad = recipe({ tables: [{ tableName: 'hogares', resourceId: 'res-other' }] });
    await expect(
      service.createFromVistrace('d1', dto({ recipe: bad }), { buffer: PARQUET }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'vistrace_recipe_invalid' } });
  });

  it('rechaza una receta cuyo nodo resultado no existe', async () => {
    const { service } = makeService();
    await expect(
      service.createFromVistrace('d1', dto({ recipe: recipe({ resultNodeId: 'nope' }) }), { buffer: PARQUET }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'vistrace_recipe_invalid' } });
  });

  it('updates only analyses that came from vistrace', async () => {
    const { service, analyses } = makeService();
    analyses.set('an-ibero', { id: 'an-ibero', datasetId: 'd1', slug: 'x', origin: 'IBERO' });
    analyses.set('an-viz', { id: 'an-viz', datasetId: 'd1', slug: 'ingreso', origin: 'VISTRACE' });

    await expect(service.updateFromVistrace('d1', 'an-ibero', dto({ slug: 'y' }), { buffer: PARQUET })).rejects.toMatchObject({
      response: { code: 'analysis_not_from_vistrace' },
    });

    const updated = await service.updateFromVistrace('d1', 'an-viz', dto({ title: 'Ingreso 2' }), { buffer: PARQUET });
    expect(updated).toMatchObject({ id: 'an-viz', title: 'Ingreso 2', status: 'DONE' });
  });

  it('the step builder cannot overwrite a vistrace analysis', async () => {
    const { service, analyses } = makeService();
    analyses.set('an-viz', { id: 'an-viz', datasetId: 'd1', slug: 'ingreso', origin: 'VISTRACE' });
    await expect(
      service.update('d1', 'an-viz', { resourceId: 'res-a', title: 'X', slug: 'ingreso', folder: 'f', steps: [] } as any),
    ).rejects.toMatchObject({ response: { code: 'analysis_from_vistrace' } });
  });
});
