import {
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { ReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EXPORT_TEMP_FILE, type ExportFile } from '../harmonizer.service.js';
import { discardExportFile } from '../export-response.js';

/** How long a prepared download waits to be fetched. */
export const DOWNLOAD_TTL_MS = 15 * 60_000;

/**
 * Temporary download files older than this belong to nobody: a server that stopped or crashed
 * before deleting them (a waiting file never lives longer than `DOWNLOAD_TTL_MS`).
 */
export const ORPHAN_MIN_AGE_MS = DOWNLOAD_TTL_MS + 3600_000;

/** How often the leftover temporary files are looked for, besides at start. */
export const SWEEP_EVERY_MS = DOWNLOAD_TTL_MS;

export interface PreparedDownload {
  /** Path of the download, relative to the API: `GET` it without a session. */
  url: string;
  filename: string;
  /** Bytes, or `null` when it is not known in advance (a kept original, sent as it unzips). */
  size: number | null;
  expiresAt: string;
}

interface Entry {
  file: ExportFile;
  timer: NodeJS.Timeout;
}

/**
 * Prepared downloads: a file the server already generated (see `ExportFile`) waits here under a
 * random token until the browser fetches it, so the browser can download it directly (a link,
 * not `fetch`) without sending the session. A token works once and for `DOWNLOAD_TTL_MS`;
 * after that, or once fetched, the file is deleted. Kept in memory: the API is one process.
 */
@Injectable()
export class HarmonizerDownloadsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HarmonizerDownloadsService.name);
  private readonly entries = new Map<string, Entry>();
  /** Files handed over by `take` whose stream has not closed yet: they are being sent. */
  private readonly sending = new Set<ExportFile>();
  private sweepTimer?: NodeJS.Timeout;

  register(file: ExportFile, now = Date.now()): PreparedDownload {
    const token = randomBytes(32).toString('base64url');
    const timer = setTimeout(() => this.expire(token), DOWNLOAD_TTL_MS);
    timer.unref();
    this.entries.set(token, { file, timer });
    return {
      url: `/harmonizer/downloads/${token}`,
      filename: file.filename,
      size: file.size ?? null,
      expiresAt: new Date(now + DOWNLOAD_TTL_MS).toISOString(),
    };
  }

  /** The file of a token, which stops working. */
  take(token: string): ExportFile {
    const entry = this.entries.get(token);
    if (!entry) {
      throw new NotFoundException({
        code: 'download_not_found',
        message: 'This download link is not valid: it expired or was already used. Download the file again.',
      });
    }
    clearTimeout(entry.timer);
    this.entries.delete(token);
    const { file } = entry;
    if (!Buffer.isBuffer(file.body)) {
      this.sending.add(file);
      file.body.once('close', () => this.sending.delete(file));
    }
    return file;
  }

  private expire(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    discardExportFile(entry.file);
  }

  /** Deletes the leftover temporary files now, and again every `SWEEP_EVERY_MS`. */
  async onModuleInit(): Promise<void> {
    await this.removeLeftoverFiles();
    this.sweepTimer = setInterval(() => {
      this.removeLeftoverFiles().catch((err: Error) =>
        this.logger.warn(
          `Removing leftover download files failed: ${err.message}`,
        ),
      );
    }, SWEEP_EVERY_MS);
    this.sweepTimer.unref();
  }

  /**
   * Deletes temporary download files older than `ORPHAN_MIN_AGE_MS` that this process is not
   * holding: left by a server that stopped or crashed before deleting them.
   */
  private async removeLeftoverFiles(): Promise<void> {
    const dir = tmpdir();
    const inUse = new Set(
      [...[...this.entries.values()].map((e) => e.file), ...this.sending]
        .map(tempFilePath)
        .filter((path) => path !== null),
    );
    let removed = 0;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!EXPORT_TEMP_FILE.test(name)) continue;
      const path = join(dir, name);
      if (inUse.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || Date.now() - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      await rm(path, { force: true });
      removed++;
    }
    if (removed > 0) this.logger.log(`Deleted ${removed} leftover download files.`);
  }

  /**
   * The server is stopping (`enableShutdownHooks` in main.ts). By now the HTTP server is closed
   * and its open connections cut (`forceCloseConnections`), so every file still waiting or being
   * sent is deleted, and the process waits until they are gone.
   */
  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    const files = [...this.sending];
    for (const { file, timer } of this.entries.values()) {
      clearTimeout(timer);
      files.push(file);
    }
    this.entries.clear();
    this.sending.clear();
    await Promise.all(files.map(deleteTempFile));
    if (files.length > 0)
      this.logger.log(
        `Discarded ${files.length} prepared downloads on shutdown.`,
      );
  }
}

/** The temporary file a download streams from (see `exportTempFile`), if it has one. */
function tempFilePath(file: ExportFile): string | null {
  const { body } = file;
  if (!(body instanceof ReadStream)) return null;
  const path = String(body.path);
  return EXPORT_TEMP_FILE.test(basename(path)) ? path : null;
}

/**
 * Discards a download and waits until its temporary file is deleted. Its stream deletes the file
 * when it closes, but without waiting, and a stopping process could exit first.
 */
async function deleteTempFile(file: ExportFile): Promise<void> {
  const { body } = file;
  if (Buffer.isBuffer(body)) return;
  if (!body.closed) {
    const closed = once(body, 'close').catch(() => undefined);
    body.destroy();
    await closed;
  }
  const path = tempFilePath(file);
  if (path) await rm(path, { force: true });
}
