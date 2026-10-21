import { ConflictException } from '@nestjs/common';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { HarmonizerService } from './harmonizer.service.js';

// Borrado de ediciones y encuestas con su Parquet crudo, y limpieza al arrancar.
// El almacenamiento es real, sobre una carpeta temporal; Prisma es un doble en memoria.

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_GONE = '33333333-3333-4333-8333-333333333333';

let root: string;

function makeService(
  editions: { id: string; name: string; surveyId: string }[],
) {
  const rows = new Map(editions.map((e) => [e.id, e]));
  const prisma = {
    harmonizerDataset: {
      findUnique: vi.fn(async ({ where }: any) => {
        const e = rows.get(where.id);
        return e ? { ...e, survey: { name: 'Encuesta' } } : null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...rows.values()].filter((e) =>
          where.surveyId
            ? e.surveyId === where.surveyId
            : where.id.in.includes(e.id),
        ),
      ),
      delete: vi.fn(async ({ where }: any) => rows.delete(where.id)),
    },
    harmonizerSurvey: {
      findUnique: vi.fn(async ({ where }: any) => ({
        id: where.id,
        name: 'Encuesta',
      })),
      delete: vi.fn(async ({ where }: any) => {
        for (const e of rows.values())
          if (e.surveyId === where.id) rows.delete(e.id);
      }),
    },
  };
  const storage = new LocalStorageService();
  Object.defineProperty(storage, 'root', { value: root });
  const service = new HarmonizerService(prisma as any, {} as any, storage);
  return { service, prisma, storage, rows };
}

const files = async () => (await readdir(join(root, 'harmonizer'))).sort();
const touch = (name: string) =>
  writeFile(join(root, 'harmonizer', name), 'PAR1');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harmonizer-storage-'));
  await mkdir(join(root, 'harmonizer'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('removeDataset', () => {
  it('borra la edición y su archivo', async () => {
    const { service, rows } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
    ]);
    await touch(`${ID_A}.parquet`);
    await service.removeDataset(ID_A);
    expect(rows.has(ID_A)).toBe(false);
    expect(await files()).toEqual([]);
  });

  it('con el archivo bloqueado no borra nada y responde 409', async () => {
    const { service, storage, rows } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
    ]);
    await touch(`${ID_A}.parquet`);
    vi.spyOn(storage, 'setAside').mockRejectedValue(
      new Error('EBUSY: resource busy or locked'),
    );
    const err = await service.removeDataset(ID_A).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'harmonizer_file_in_use' });
    expect(err.getResponse().message).toMatch(/No se borró la edición «E1»/);
    expect(rows.has(ID_A)).toBe(true);
    expect(await files()).toEqual([`${ID_A}.parquet`]);
  });

  it('si falla el borrado en la base, el archivo vuelve a su lugar', async () => {
    const { service, prisma } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
    ]);
    await touch(`${ID_A}.parquet`);
    prisma.harmonizerDataset.delete.mockRejectedValueOnce(new Error('db down'));
    await expect(service.removeDataset(ID_A)).rejects.toThrow('db down');
    expect(await files()).toEqual([`${ID_A}.parquet`]);
  });

  it('una edición sin archivo (anterior a H-08) se borra igual', async () => {
    const { service, rows } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
    ]);
    await service.removeDataset(ID_A);
    expect(rows.has(ID_A)).toBe(false);
  });
});

describe('removeSurvey', () => {
  it('si una edición está bloqueada, devuelve las ya apartadas y no borra nada', async () => {
    const { service, storage, rows } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
      { id: ID_B, name: 'E2', surveyId: 's' },
    ]);
    await touch(`${ID_A}.parquet`);
    await touch(`${ID_B}.parquet`);
    const real = storage.setAside.bind(storage);
    vi.spyOn(storage, 'setAside').mockImplementation(async (key) => {
      if (key.includes(ID_B)) throw new Error('EBUSY');
      return real(key);
    });
    const err = await service.removeSurvey('s').catch((e) => e);
    expect(err.getResponse().message).toMatch(/su edición «E2»/);
    expect(rows.size).toBe(2);
    expect(await files()).toEqual(
      [`${ID_A}.parquet`, `${ID_B}.parquet`].sort(),
    );
  });
});

describe('limpieza al arrancar', () => {
  it('borra huérfanos y apartados sin edición, y devuelve los apartados con edición', async () => {
    const { service } = makeService([
      { id: ID_A, name: 'E1', surveyId: 's' },
      { id: ID_B, name: 'E2', surveyId: 's' },
    ]);
    await touch(`${ID_A}.parquet`);
    await touch(`${ID_B}.parquet.deleting`);
    await touch(`${ID_GONE}.parquet`);
    await touch(`${ID_GONE}.parquet.deleting`);
    await touch('notas.txt');
    await service.onApplicationBootstrap();
    expect(await files()).toEqual(
      [`${ID_A}.parquet`, `${ID_B}.parquet`, 'notas.txt'].sort(),
    );
  });

  it('si ningún archivo es de esta base, no toca la carpeta', async () => {
    const { service } = makeService([]);
    await touch(`${ID_GONE}.parquet`);
    await service.onApplicationBootstrap();
    expect(await files()).toEqual([`${ID_GONE}.parquet`]);
  });

  it('sin carpeta no falla', async () => {
    const { service } = makeService([]);
    await rm(join(root, 'harmonizer'), { recursive: true });
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
