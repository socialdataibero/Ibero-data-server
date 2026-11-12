import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportFile } from '../harmonizer.service.js';
import {
  DOWNLOAD_TTL_MS,
  HarmonizerDownloadsService,
  ORPHAN_MIN_AGE_MS,
  SWEEP_EVERY_MS,
} from './harmonizer-downloads.service.js';

function streamFile(size?: number): ExportFile & { body: Readable } {
  return {
    filename: 'harmonized_x.parquet',
    contentType: 'application/vnd.apache.parquet',
    body: Readable.from([Buffer.from('PAR1')]),
    size,
  };
}

describe('HarmonizerDownloadsService', () => {
  let service: HarmonizerDownloadsService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new HarmonizerDownloadsService();
  });

  afterEach(async () => {
    await service.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('gives a URL with a random token, the name, the size and when it expires', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const a = service.register(streamFile(4), now);
    const b = service.register(streamFile(), now);
    expect(a.url).toMatch(/^\/harmonizer\/downloads\/[A-Za-z0-9_-]{43}$/);
    expect(b.url).not.toBe(a.url);
    expect(a).toMatchObject({
      filename: 'harmonized_x.parquet',
      size: 4,
      expiresAt: new Date(now + DOWNLOAD_TTL_MS).toISOString(),
    });
    expect(b.size).toBeNull();
  });

  it('hands the file over once; a used or unknown token is 404 download_not_found', () => {
    const file = streamFile(4);
    const token = service.register(file).url.split('/').pop()!;
    expect(service.take(token)).toBe(file);
    for (const t of [token, 'unknown']) {
      try {
        service.take(t);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          code: 'download_not_found',
        });
      }
    }
    expect(file.body.destroyed).toBe(false);
  });

  it('discards a file nobody fetched when it expires (its temporary file is deleted)', () => {
    const file = streamFile(4);
    const token = service.register(file).url.split('/').pop()!;
    vi.advanceTimersByTime(DOWNLOAD_TTL_MS - 1);
    expect(file.body.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(file.body.destroyed).toBe(true);
    expect(() => service.take(token)).toThrow(NotFoundException);
  });

  it('discards every waiting file when the server stops', async () => {
    const files = [streamFile(), streamFile()];
    for (const f of files) service.register(f);
    await service.onApplicationShutdown();
    expect(files.every((f) => f.body.destroyed)).toBe(true);
  });

  describe('temporary files', () => {
    const originalTmp = process.env.TMPDIR;
    let dir: string;

    beforeEach(async () => {
      vi.useRealTimers();
      // A folder of its own, so the tests never touch the system's temporary files.
      dir = await mkdtemp(join(tmpdir(), 'downloads-spec-'));
      process.env.TMPDIR = dir;
    });

    afterEach(async () => {
      await service.onApplicationShutdown();
      process.env.TMPDIR = originalTmp;
      await rm(dir, { recursive: true, force: true });
    });

    /** A temporary download file as `exportTempFile` makes it, `ageMs` old. */
    async function tempFile(ageMs = 0, ext = 'csv'): Promise<string> {
      const path = join(dir, `ibero-harmonized-${randomUUID()}.${ext}`);
      await writeFile(path, 'a,b\n1,2\n');
      const when = new Date(Date.now() - ageMs);
      await utimes(path, when, when);
      return path;
    }

    function tempDownload(path: string): ExportFile & { body: Readable } {
      const body = createReadStream(path);
      body.once('close', () => void rm(path, { force: true }));
      return {
        filename: 'harmonized_x.csv',
        contentType: 'text/csv',
        body,
        size: 8,
      };
    }

    it('when the server stops, waits until the waiting and the half-sent files are deleted', async () => {
      const waiting = await tempFile();
      const sent = await tempFile();
      service.register(tempDownload(waiting));
      const token = service.register(tempDownload(sent)).url.split('/').pop()!;
      (service.take(token).body as Readable).resume(); // being sent when the server stops
      await service.onApplicationShutdown();
      expect(existsSync(waiting)).toBe(false);
      expect(existsSync(sent)).toBe(false);
    });

    it('at start, deletes only the download files older than ORPHAN_MIN_AGE_MS', async () => {
      const old = await tempFile(ORPHAN_MIN_AGE_MS + 60_000, 'parquet');
      const recent = await tempFile(ORPHAN_MIN_AGE_MS - 60_000);
      const other = join(dir, 'not-a-download.csv');
      await writeFile(other, 'x');
      await utimes(other, new Date(0), new Date(0));
      await service.onModuleInit();
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(other)).toBe(true);
    });

    it('looks again every SWEEP_EVERY_MS, skipping the files it is still holding', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await service.onModuleInit();
      const orphan = await tempFile(ORPHAN_MIN_AGE_MS + 60_000);
      const held = await tempFile(ORPHAN_MIN_AGE_MS + 60_000);
      const token = service.register(tempDownload(held)).url.split('/').pop()!;
      const sending = await tempFile(ORPHAN_MIN_AGE_MS + 60_000);
      const sendingToken = service
        .register(tempDownload(sending))
        .url.split('/')
        .pop()!;
      service.take(sendingToken);
      vi.advanceTimersByTime(SWEEP_EVERY_MS);
      await vi.waitFor(() => expect(existsSync(orphan)).toBe(false), {
        interval: 10,
      });
      expect(existsSync(held)).toBe(true);
      expect(existsSync(sending)).toBe(true);
      service.take(token);
    });
  });
});
