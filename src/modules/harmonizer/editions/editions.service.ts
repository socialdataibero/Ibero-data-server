import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import type { UpdateDatasetDto } from '../dto/update-dataset.dto.js';
import { toDatasetInfo, type DatasetInfo } from '../harmonizer-types.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { EditionFilesService } from './edition-files.service.js';

/** Editions: delete one with its files, change its source design or unit. */
@Injectable()
export class EditionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly lookup: HarmonizerLookupService,
    private readonly files: EditionFilesService,
  ) {}

  async removeDataset(datasetId: string): Promise<void> {
    const dataset = await this.lookup.getDataset(datasetId);
    // Los mapeos se borran en cascada. Las canónicas se conservan (con su tipo
    // confirmado) para reutilizarlas al volver a subir la edición; las que ya no
    // mapea ninguna edición dejan de salir en la vista por encuesta.
    const aside = await this.files.setAsideRawFiles(
      [dataset],
      (edition) =>
        `No se borró la edición «${edition}» porque su archivo de datos está en uso por otro programa (por ejemplo, abierto o copiándose en un respaldo). Ciérralo e inténtalo de nuevo.`,
    );
    try {
      await this.prisma.harmonizerDataset.delete({ where: { id: datasetId } });
    } catch (err) {
      await this.files.restoreRawFiles(aside);
      throw err;
    }
    // Si esto falla, el `.deleting` se borra en la limpieza al arrancar.
    await Promise.all(aside.map((key) => this.storage.remove(key)));
  }

  /**
   * Changes the source design, the unit or the covered place of an edition. Census editions do not take sample design
   * roles, so switching to census clears them; switching to sample leaves the weight to be
   * marked in the mapping, which cannot be saved without it.
   */
  async updateDataset(
    datasetId: string,
    dto: UpdateDatasetDto,
  ): Promise<DatasetInfo> {
    await this.lookup.getDataset(datasetId);
    let coverage: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (dto.coverage === null) coverage = Prisma.DbNull;
    else if (dto.coverage) {
      const code = dto.coverage.code.trim();
      const label = dto.coverage.label.trim();
      if (!code || !label) {
        throw new BadRequestException({
          code: 'coverage_invalid',
          message: 'The code and the name of the place an edition covers must not be blank.',
        });
      }
      coverage = { level: dto.coverage.level, code, label };
    }
    const dataset = await this.prisma.$transaction(async (tx) => {
      if (dto.design === 'census') {
        await tx.harmonizerMapping.updateMany({
          where: { datasetId, role: { not: null } },
          data: { role: null },
        });
      }
      return tx.harmonizerDataset.update({
        where: { id: datasetId },
        data: { design: dto.design, unit: dto.unit, coverage },
        include: { survey: true },
      });
    });
    return toDatasetInfo(dataset);
  }
}
