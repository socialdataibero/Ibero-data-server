import { NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportFile } from '../harmonizer.service.js';
import {
  DOWNLOAD_TTL_MS,
  HarmonizerDownloadsService,
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

  afterEach(() => {
    service.onModuleDestroy();
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

  it('discards every waiting file when the server stops', () => {
    const files = [streamFile(), streamFile()];
    for (const f of files) service.register(f);
    service.onModuleDestroy();
    expect(files.every((f) => f.body.destroyed)).toBe(true);
  });
});
