import { NotFoundException } from '@nestjs/common';
import { DatasetsService } from './datasets.service.js';

function makeDeps() {
  const datasets = new Map<string, any>();
  const analyses = new Map<string, any>();

  const prisma = {
    dataset: {
      findFirst: vi.fn(async ({ where }: any) => {
        const d = datasets.get(where.id);
        return d && d.organizationId === where.organizationId ? { ...d, resources: [], revisionOf: null, revisions: [], supersededBy: null } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const d of datasets.values()) {
          if (where.revisionOfId !== undefined && d.revisionOfId === where.revisionOfId) {
            Object.assign(d, data);
            count++;
          }
          if (where.supersededById !== undefined && d.supersededById === where.supersededById) {
            Object.assign(d, data);
            count++;
          }
        }
        return { count };
      }),
      delete: vi.fn(async ({ where }: any) => {
        const d = datasets.get(where.id);
        datasets.delete(where.id);
        return d;
      }),
    },
    analysis: {
      findMany: vi.fn(async ({ where }: any) => [...analyses.values()].filter((a) => a.datasetId === where.datasetId)),
    },
  };

  const storage = { remove: vi.fn(async () => undefined), removeDir: vi.fn(async () => undefined) };

  return {
    prisma,
    storage,
    addDataset: (d: any) => datasets.set(d.id, d),
    addAnalysis: (a: any) => analyses.set(a.id, a),
    datasets,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new DatasetsService(deps.prisma as any, deps.storage as any);
}

describe('DatasetsService.remove', () => {
  it('borra el dataset, su carpeta completa de resources, y los archivos de sus análisis', async () => {
    const deps = makeDeps();
    deps.addDataset({ id: 'd1', organizationId: 'org-1' });
    deps.addAnalysis({ id: 'an1', datasetId: 'd1', resultStorageKey: 'analyses/an1.parquet' });
    deps.addAnalysis({ id: 'an2', datasetId: 'd1', resultStorageKey: null });

    const service = makeService(deps);
    await service.remove('org-1', 'd1');

    expect(deps.datasets.has('d1')).toBe(false);
    expect(deps.storage.removeDir).toHaveBeenCalledWith('d1');
    expect(deps.storage.remove).toHaveBeenCalledWith('analyses/an1.parquet');
    expect(deps.storage.remove).toHaveBeenCalledTimes(1); // an2 sin resultStorageKey no cuenta
  });

  it('desengancha revisionOfId de un dataset hijo que apuntaba al borrado', async () => {
    const deps = makeDeps();
    deps.addDataset({ id: 'padre', organizationId: 'org-1', supersededById: 'hijo' });
    deps.addDataset({ id: 'hijo', organizationId: 'org-1', revisionOfId: 'padre' });

    const service = makeService(deps);
    await service.remove('org-1', 'padre');

    expect(deps.datasets.get('hijo').revisionOfId).toBeNull();
  });

  it('desengancha supersededById de un dataset predecesor que apuntaba al borrado', async () => {
    const deps = makeDeps();
    deps.addDataset({ id: 'padre', organizationId: 'org-1', supersededById: 'hijo' });
    deps.addDataset({ id: 'hijo', organizationId: 'org-1', revisionOfId: 'padre' });

    const service = makeService(deps);
    await service.remove('org-1', 'hijo');

    expect(deps.datasets.get('padre').supersededById).toBeNull();
  });

  it('rechaza borrar un dataset de OTRA organización', async () => {
    const deps = makeDeps();
    deps.addDataset({ id: 'd1', organizationId: 'org-1' });

    const service = makeService(deps);
    await expect(service.remove('org-2', 'd1')).rejects.toBeInstanceOf(NotFoundException);
    expect(deps.datasets.has('d1')).toBe(true); // no se tocó
  });
});

describe('DatasetsService lists: who sees which datasets (SDI-87)', () => {
  function listWhere() {
    const prisma = {
      dataset: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async () => []),
      },
    };
    const service = new DatasetsService(prisma as any, {} as any);
    return { service, where: () => (prisma.dataset.findMany.mock.calls[0] as any)[0].where };
  }

  const visibleToUser = {
    OR: [{ visibility: 'PUBLIC' }, { organization: { members: { some: { userId: 'u1' } } } }],
  };

  it('a regular user sees PUBLIC datasets and those of their organizations, globally', async () => {
    const { service, where } = listWhere();
    await service.findAllGlobal({ id: 'u1', isSysadmin: false } as any);
    expect(where()).toEqual({ AND: [visibleToUser] });
  });

  it('a regular user browsing an organization gets the same rule', async () => {
    const { service, where } = listWhere();
    await service.findAllByOrganization('org-b', { id: 'u1', isSysadmin: false } as any, { q: 'enigh' });
    expect(where().AND).toEqual(expect.arrayContaining([{ organizationId: 'org-b' }, visibleToUser]));
  });

  it('the sysadmin sees every dataset', async () => {
    const { service, where } = listWhere();
    await service.findAllGlobal({ id: 'admin', isSysadmin: true } as any);
    expect(where()).toEqual({});
  });
});
