import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import { ORIGINAL_FILE, RAW_FILE, SWEEP_MIN_AGE_MS } from '../edition-files.js';
import { EditionFilesService } from './edition-files.service.js';

/**
 * The cleanup of harmonizer storage when the API starts. Only HarmonizerModule (the API)
 * provides it: in the worker it could remove the files of an import in progress.
 */
@Injectable()
export class EditionFilesSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EditionFilesSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly files: EditionFilesService,
  ) {}

  /**
   * Limpieza al arrancar: borra los Parquet crudos que ya no tienen edición
   * (apartados cuyo borrado falló, o huérfanos de antes de esta corrección o de una
   * subida interrumpida) y devuelve a su lugar los apartados cuya edición sigue viva.
   * Nunca impide que el servidor arranque.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sweepRawFiles();
    } catch (err) {
      this.logger.warn(
        `Harmonizer storage cleanup failed: ${(err as Error).message}`,
      );
    }
  }

  private async sweepRawFiles(): Promise<void> {
    const listed = async (dir: string, pattern: RegExp) =>
      (await this.storage.list(dir))
        .map((name) => ({ name, match: pattern.exec(name) }))
        .filter((f) => f.match !== null)
        .map((f) => ({
          key: `${dir}/${f.name}`,
          id: f.match![1],
          aside: f.match![2] !== undefined,
        }));
    const found = [
      ...(await listed('harmonizer', RAW_FILE)),
      ...(await listed('harmonizer/originals', ORIGINAL_FILE)),
    ];
    if (found.length === 0) return;
    const live = new Set(
      (
        await this.prisma.harmonizerDataset.findMany({
          where: { id: { in: found.map((f) => f.id) } },
          select: { id: true },
        })
      ).map((d) => d.id),
    );
    // `start:dev` y `start:local` comparten `storage/` con bases distintas. Si ningún
    // archivo es de esta base, la carpeta es de la otra y no se toca.
    if (live.size === 0) {
      this.logger.warn(
        `No file in storage/harmonizer belongs to an edition in this database; ${found.length} file(s) kept.`,
      );
      return;
    }
    let removed = 0;
    for (const f of found) {
      if (!live.has(f.id)) {
        if (await this.isRecent(f.key)) continue;
        await this.storage.remove(f.key);
        removed++;
      } else if (f.aside) {
        await this.files.restoreRawFiles([f.key]);
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} harmonizer file(s) with no edition.`);
    }
  }

  private async isRecent(key: string): Promise<boolean> {
    try {
      const { mtimeMs } = await stat(this.storage.resolvePath(key));
      return Date.now() - mtimeMs < SWEEP_MIN_AGE_MS;
    } catch {
      return false;
    }
  }
}
