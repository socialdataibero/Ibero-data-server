import { NotFoundException } from '@nestjs/common';
import { PublicService } from './public.service.js';

function makeDeps() {
  const datasets = new Map<string, any>();
  const analyses = new Map<string, any>();
  const orgsMap = new Map<string, any>();
  const resources = new Map<string, any>();

  function matchAnalyses(where: any) {
    return [...analyses.values()].filter((a) => {
      if (where.status && a.status !== where.status) return false;
      if (where.visibility && a.visibility !== where.visibility) return false;
      if (where.slug && a.slug !== where.slug) return false;
      const ds = datasets.get(a.datasetId);
      if (where.dataset?.visibility && ds?.visibility !== where.dataset.visibility) return false;
      return true;
    });
  }
  function publicOrgs() {
    const orgIdsConAnalisisPublico = new Set(
      [...analyses.values()]
        .filter((a) => a.status === 'DONE' && a.visibility === 'PUBLIC' && datasets.get(a.datasetId)?.visibility === 'PUBLIC')
        .map((a) => datasets.get(a.datasetId)!.organizationId),
    );
    return [...orgsMap.values()].filter((o) => orgIdsConAnalisisPublico.has(o.id));
  }
  function withAnalysisIncludes(a: any) {
    const ds = datasets.get(a.datasetId);
    return {
      ...a,
      dataset: { ...ds, organization: orgsMap.get(ds.organizationId) },
      sourceResource: a.sourceResourceId ? (resources.get(a.sourceResourceId) ?? null) : null,
    };
  }

  const prisma = {
    analysis: {
      count: vi.fn(async ({ where }: any) => matchAnalyses(where).length),
      findMany: vi.fn(async ({ where, take, skip, select }: any) => {
        let rows = matchAnalyses(where);
        if (skip) rows = rows.slice(skip);
        if (take) rows = rows.slice(0, take);
        return rows.map((a) => {
          const full = withAnalysisIncludes(a);
          if (!select) return full;
          // Selección simplificada: alcanza con lo que usa countByOrganization.
          return { datasetId: full.datasetId, dataset: { organization: { slug: full.dataset.organization.slug } } };
        });
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = matchAnalyses(where);
        return rows[0] ? withAnalysisIncludes(rows[0]) : null;
      }),
    },
    resource: {
      findMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where.id.in;
        return [...resources.values()].filter((r) => ids.includes(r.id) && r.datasetId === where.datasetId);
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const r = resources.get(where.id);
        return r && r.datasetId === where.datasetId ? r : null;
      }),
    },
    organization: {
      findMany: vi.fn(async () => publicOrgs()),
      count: vi.fn(async () => publicOrgs().length),
    },
  };

  const storage = { resolvePath: vi.fn((key: string) => `/storage/${key}`) };
  const analysisService = { runQuery: vi.fn(async () => ({ columns: ['a'], rows: [] })) };
  const handoffService = {
    apiBaseUrl: vi.fn(() => 'http://localhost:3000'),
    buildAnalysisHandoffUrl: vi.fn(() => 'http://localhost:4201?handoff=fake'),
  };

  return {
    prisma,
    storage,
    analysisService,
    handoffService,
    addOrg: (o: any) => orgsMap.set(o.id, o),
    addDataset: (d: any) => datasets.set(d.id, d),
    addAnalysis: (a: any) => analyses.set(a.id, { visibility: 'PUBLIC', ...a }),
    addResource: (r: any) => resources.set(r.id, r),
  };
}

const ORG = { id: 'org-1', slug: 'ibero', name: 'Ibero Data MX', description: null };

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new PublicService(deps.prisma as any, deps.storage as any, deps.analysisService as any, deps.handoffService as any);
}

describe('PublicService: solo análisis DONE de datasets PUBLIC', () => {
  it('un dataset PUBLIC sin ningún análisis no aparece en el catálogo', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });

    const service = makeService(deps);
    const { total, items } = await service.search({});

    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it('un análisis DONE de un dataset PUBLIC sí aparece', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso por estado', slug: 'ingreso-por-estado', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { total, items } = await service.search({});

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ name: 'ingreso-por-estado', type: 'analysis' });
  });

  it('un análisis RUNNING (todavía no terminado) no aparece aunque el dataset sea PUBLIC', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'En proceso', slug: 'en-proceso', description: null, status: 'RUNNING', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { total } = await service.search({});
    expect(total).toBe(0);
  });

  it('un análisis DONE de un dataset PRIVATE nunca aparece', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd2', organizationId: 'org-1', visibility: 'PRIVATE' });
    deps.addAnalysis({ id: 'a2', datasetId: 'd2', title: 'Interno', slug: 'interno', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { total } = await service.search({});
    expect(total).toBe(0);
    await expect(service.getPackageBySlug('interno')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPackageBySlug() de un análisis público arma un resource sintético con su propio slug como id', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso', slug: 'ingreso', description: null, status: 'DONE', resultColumns: [{ name: 'x', type: 'INT' }], createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { resources } = await service.getPackageBySlug('ingreso');

    expect(resources).toEqual([{ id: 'ingreso', name: 'Ingreso', datastore_active: false, parquet_schema: [{ name: 'x', type: 'INT' }] }]);
  });

  it('previewBySlug() corre SELECT * FROM data LIMIT n sobre el resultado materializado, nunca SQL de quien llama', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso', slug: 'ingreso', description: null, status: 'DONE', resultStorageKey: 'analyses/a1.parquet', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    await service.previewBySlug('ingreso', 10);

    expect(deps.analysisService.runQuery).toHaveBeenCalledWith('/storage/analyses/a1.parquet', 'SELECT * FROM data LIMIT 10');
  });

  describe('a PRIVATE analysis of a PUBLIC dataset stays hidden (SDI-98)', () => {
    function setup() {
      const deps = makeDeps();
      deps.addOrg(ORG);
      deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
      deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Borrador', slug: 'borrador', description: null, status: 'DONE', visibility: 'PRIVATE', resultStorageKey: 'analyses/a1.parquet', createdAt: new Date(), updatedAt: new Date() });
      return { deps, service: makeService(deps) };
    }

    it('is not listed in the catalog or counted for its organization', async () => {
      const { service } = setup();
      expect((await service.search({})).total).toBe(0);
      expect((await service.listOrganizations({})).total).toBe(0);
    });

    it('cannot be opened, previewed, downloaded or handed off by its public URL', async () => {
      const { deps, service } = setup();
      await expect(service.getPackageBySlug('borrador')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.previewBySlug('borrador')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.getResultFile('borrador')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.buildVizCanvasHandoff('borrador')).rejects.toBeInstanceOf(NotFoundException);
      expect(deps.analysisService.runQuery).not.toHaveBeenCalled();
    });
  });

  it('previewBySlug() rechaza un análisis de dataset PRIVATE', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd2', organizationId: 'org-1', visibility: 'PRIVATE' });
    deps.addAnalysis({ id: 'a2', datasetId: 'd2', title: 'Interno', slug: 'interno', description: null, status: 'DONE', resultStorageKey: 'analyses/a2.parquet', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    await expect(service.previewBySlug('interno')).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.analysisService.runQuery).not.toHaveBeenCalled();
  });
});

describe('PublicService: "cómo se hizo" (recipe público)', () => {
  it('getPackageBySlug() incluye los steps y el nombre del recurso base', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addResource({ id: 'res-base', datasetId: 'd1', filename: 'steam_games.parquet' });
    deps.addAnalysis({
      id: 'a1', datasetId: 'd1', sourceResourceId: 'res-base', title: 'Top publishers', slug: 'top-publishers',
      description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date(),
      recipe: [{ op: 'sort', params: { column: 'price', dir: 'desc' } }, { op: 'limit', params: { n: 10 } }],
    });

    const service = makeService(deps);
    const { recipe } = await service.getPackageBySlug('top-publishers');

    expect(recipe.sourceResourceName).toBe('steam_games.parquet');
    expect(recipe.steps).toHaveLength(2);
    expect(recipe.joinResourceNames).toEqual({});
  });

  it('resuelve el nombre del recurso cruzado en un paso "join" (no expone el uuid pelón)', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addResource({ id: 'res-base', datasetId: 'd1', filename: 'steam_games.parquet' });
    deps.addResource({ id: 'res-join', datasetId: 'd1', filename: 'steam_reviews.parquet' });
    deps.addAnalysis({
      id: 'a1', datasetId: 'd1', sourceResourceId: 'res-base', title: 'Con join', slug: 'con-join',
      description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date(),
      recipe: [{ op: 'join', params: { resourceId: 'res-join', alias: 'reviews', type: 'inner', onLeft: 'appid', onRight: 'appid' } }],
    });

    const service = makeService(deps);
    const { recipe } = await service.getPackageBySlug('con-join');

    expect(recipe.joinResourceNames).toEqual({ 'res-join': 'steam_reviews.parquet' });
  });

  it('un recipe vacío o inválido no revienta: da steps vacíos', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', sourceResourceId: null, title: 'Sin recipe', slug: 'sin-recipe', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date(), recipe: null });

    const service = makeService(deps);
    const { recipe } = await service.getPackageBySlug('sin-recipe');

    expect(recipe.steps).toEqual([]);
    expect(recipe.sourceResourceName).toBeNull();
  });
});

describe('PublicService: descargas y handoff a VizCanvas sin cuenta', () => {
  it('getResultFile() resuelve el parquet del análisis, no de ningún resource', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso', slug: 'ingreso', description: null, status: 'DONE', resultStorageKey: 'analyses/a1.parquet', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { path, filename } = await service.getResultFile('ingreso');

    expect(path).toBe('/storage/analyses/a1.parquet');
    expect(filename).toBe('Ingreso.parquet');
  });

  it('getResultFile() rechaza un análisis de dataset PRIVATE', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd2', organizationId: 'org-1', visibility: 'PRIVATE' });
    deps.addAnalysis({ id: 'a2', datasetId: 'd2', title: 'Interno', slug: 'interno', description: null, status: 'DONE', resultStorageKey: 'analyses/a2.parquet', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    await expect(service.getResultFile('interno')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getDatasetResourceFile() sirve un resource del MISMO dataset del análisis público', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addResource({ id: 'res-1', datasetId: 'd1', filename: 'steam_games.parquet', storageKey: 'd1/steam_games.parquet' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso', slug: 'ingreso', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    const { path, filename } = await service.getDatasetResourceFile('ingreso', 'res-1');

    expect(path).toBe('/storage/d1/steam_games.parquet');
    expect(filename).toBe('steam_games.parquet');
  });

  it('getDatasetResourceFile() rechaza un resource de OTRO dataset, aunque el análisis sea público', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addDataset({ id: 'd2', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addResource({ id: 'res-ajeno', datasetId: 'd2', filename: 'otro.parquet', storageKey: 'd2/otro.parquet' });
    deps.addAnalysis({ id: 'a1', datasetId: 'd1', title: 'Ingreso', slug: 'ingreso', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date() });

    const service = makeService(deps);
    await expect(service.getDatasetResourceFile('ingreso', 'res-ajeno')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('buildVizCanvasHandoff() arma las URLs públicas (sin token) para el resultado, el recurso base y los joins', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd1', organizationId: 'org-1', visibility: 'PUBLIC' });
    deps.addResource({ id: 'res-base', datasetId: 'd1', filename: 'steam_games.parquet', storageKey: 'd1/steam_games.parquet' });
    deps.addResource({ id: 'res-join', datasetId: 'd1', filename: 'steam_reviews.parquet', storageKey: 'd1/steam_reviews.parquet' });
    deps.addAnalysis({
      id: 'a1', datasetId: 'd1', sourceResourceId: 'res-base', title: 'Con join', slug: 'con-join',
      description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date(),
      recipe: [{ op: 'join', params: { resourceId: 'res-join', alias: 'reviews', type: 'inner', onLeft: 'appid', onRight: 'appid' } }],
    });

    const service = makeService(deps);
    const { url } = await service.buildVizCanvasHandoff('con-join');

    expect(url).toBe('http://localhost:4201?handoff=fake');
    expect(deps.handoffService.buildAnalysisHandoffUrl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'public' }),
      expect.objectContaining({ downloadUrl: 'http://localhost:3000/public/catalog/con-join/download' }),
      expect.objectContaining({ downloadUrl: 'http://localhost:3000/public/catalog/con-join/resources/res-base/download' }),
      expect.any(Object),
      [expect.objectContaining({ downloadUrl: 'http://localhost:3000/public/catalog/con-join/resources/res-join/download', filename: 'steam_reviews.parquet' })],
    );
  });

  it('buildVizCanvasHandoff() rechaza un análisis de dataset PRIVATE', async () => {
    const deps = makeDeps();
    deps.addOrg(ORG);
    deps.addDataset({ id: 'd2', organizationId: 'org-1', visibility: 'PRIVATE' });
    deps.addResource({ id: 'res-base', datasetId: 'd2', filename: 'x.parquet', storageKey: 'd2/x.parquet' });
    deps.addAnalysis({ id: 'a2', datasetId: 'd2', sourceResourceId: 'res-base', title: 'Interno', slug: 'interno', description: null, status: 'DONE', createdAt: new Date(), updatedAt: new Date(), recipe: [] });

    const service = makeService(deps);
    await expect(service.buildVizCanvasHandoff('interno')).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.handoffService.buildAnalysisHandoffUrl).not.toHaveBeenCalled();
  });
});
