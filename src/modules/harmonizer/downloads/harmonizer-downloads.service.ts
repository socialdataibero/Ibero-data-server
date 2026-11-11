import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPORT_TEMP_FILE, type ExportFile } from '../harmonizer.service.js';
import { discardExportFile } from '../export-response.js';

/** How long a prepared download waits to be fetched. */
export const DOWNLOAD_TTL_MS = 15 * 60_000;

/** Temporary download files older than this are left over from a stopped server. */
const ORPHAN_MIN_AGE_MS = DOWNLOAD_TTL_MS + 3600_000;

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
export class HarmonizerDownloadsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HarmonizerDownloadsService.name);
  private readonly entries = new Map<string, Entry>();

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
    return entry.file;
  }

  private expire(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    discardExportFile(entry.file);
  }

  /** Deletes temporary download files left by a server that stopped before sending them. */
  async onModuleInit(): Promise<void> {
    const dir = tmpdir();
    let removed = 0;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!EXPORT_TEMP_FILE.test(name)) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || Date.now() - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
      await rm(path, { force: true });
      removed++;
    }
    if (removed > 0) this.logger.log(`Deleted ${removed} leftover download files.`);
  }

  onModuleDestroy(): void {
    for (const token of this.entries.keys()) this.expire(token);
  }
}
