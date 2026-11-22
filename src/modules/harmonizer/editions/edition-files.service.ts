import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { access } from 'node:fs/promises';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import { originalStorageKey, rawStorageKey } from '../edition-files.js';

/**
 * The stored files of an edition: its path, and setting them aside while it is deleted. It has
 * no lifecycle hooks, so the worker can load it (the cleanup at start is
 * EditionFilesSweepService, API only).
 */
@Injectable()
export class EditionFilesService {
  private readonly logger = new Logger(EditionFilesService.name);

  constructor(private readonly storage: LocalStorageService) {}

  /**
   * Aparta los Parquet crudos antes de borrar sus registros. Si alguno no se
   * puede apartar (en Windows, abierto por otro programa), devuelve a su lugar los ya
   * apartados y responde 409: no se borra nada y el usuario lo ve, en vez de quedar el
   * archivo en disco sin ninguna edición que lo referencie.
   */
  async setAsideRawFiles(
    datasets: { id: string; name: string }[],
    lockedMessage: (edition: string) => string,
  ): Promise<string[]> {
    const aside: string[] = [];
    for (const dataset of datasets) {
      // El original comprimido solo existe en ediciones importadas por el worker.
      for (const storageKey of [
        rawStorageKey(dataset.id),
        originalStorageKey(dataset.id),
      ]) {
        try {
          const key = await this.storage.setAside(storageKey);
          if (key) aside.push(key);
        } catch (err) {
          this.logger.warn(
            `Could not set aside "${storageKey}": ${(err as Error).message}`,
          );
          await this.restoreRawFiles(aside);
          throw new ConflictException({
            code: 'harmonizer_file_in_use',
            message: lockedMessage(dataset.name),
          });
        }
      }
    }
    return aside;
  }

  // Si falla, el archivo queda como `.deleting` con su edición viva; la limpieza al
  // arrancar lo devuelve a su lugar.
  async restoreRawFiles(aside: string[]): Promise<void> {
    for (const key of aside) {
      try {
        await this.storage.restore(key);
      } catch (err) {
        this.logger.error(
          `Could not restore "${key}": ${(err as Error).message}`,
        );
      }
    }
  }

  async rawPath(dataset: { id: string }): Promise<string> {
    const path = this.storage.resolvePath(rawStorageKey(dataset.id));
    try {
      await access(path);
    } catch {
      throw new NotFoundException({
        code: 'harmonizer_dataset_file_missing',
        message:
          'The stored data for this edition was not found. Upload the file again.',
      });
    }
    return path;
  }
}
