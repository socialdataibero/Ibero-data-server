import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Sufijo de un archivo apartado para borrarse (ver `setAside`). */
export const ASIDE_SUFFIX = '.deleting';

function sanitizeFilename(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

@Injectable()
export class LocalStorageService {
  private readonly root = resolve(process.cwd(), 'storage');
  private readonly logger = new Logger(LocalStorageService.name);

  async save(datasetId: string, originalFilename: string, buffer: Buffer): Promise<string> {
    const dir = join(this.root, datasetId);
    await mkdir(dir, { recursive: true });

    const key = `${datasetId}/${randomUUID()}-${sanitizeFilename(originalFilename)}`;
    await writeFile(join(this.root, key), buffer);
    return key;
  }

  resolvePath(storageKey: string): string {
    return join(this.root, storageKey);
  }

  async ensureDir(storageKey: string): Promise<void> {
    await mkdir(dirname(this.resolvePath(storageKey)), { recursive: true });
  }

  /**
   * Renombra el archivo a `<clave>.deleting` antes de borrar su registro: en Windows un
   * archivo abierto por otro programa no se puede renombrar, así que esto falla (y lanza)
   * antes de borrar nada. Devuelve la clave nueva, o `null` si el archivo no existe.
   */
  async setAside(storageKey: string): Promise<string | null> {
    const asideKey = `${storageKey}${ASIDE_SUFFIX}`;
    try {
      await rename(this.resolvePath(storageKey), this.resolvePath(asideKey));
      return asideKey;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Deshace `setAside`. */
  async restore(asideKey: string): Promise<void> {
    const original = asideKey.slice(0, -ASIDE_SUFFIX.length);
    await rename(this.resolvePath(asideKey), this.resolvePath(original));
  }

  /** Nombres de los archivos de una carpeta; `[]` si la carpeta no existe. */
  async list(relativeDir: string): Promise<string[]> {
    try {
      return await readdir(this.resolvePath(relativeDir));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async remove(storageKey: string): Promise<void> {
    try {
      await rm(this.resolvePath(storageKey), { force: true });
    } catch (err) {
      this.logger.warn(`Could not delete "${storageKey}": ${(err as Error).message}`);
    }
  }

  async removeDir(relativeDir: string): Promise<void> {
    try {
      await rm(this.resolvePath(relativeDir), { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`Could not delete folder "${relativeDir}": ${(err as Error).message}`);
    }
  }
}
