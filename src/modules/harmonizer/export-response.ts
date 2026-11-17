import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import type { ExportFile } from './harmonizer.service.js';

/** Sends a download as an attachment, with its size when it is known. */
export function sendExportFile(res: Response, file: ExportFile): void {
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  if (file.size !== undefined) res.setHeader('Content-Length', String(file.size));
  if (Buffer.isBuffer(file.body)) {
    res.send(file.body);
    return;
  }
  // A stream that fails half way can only cut the response: the headers are already sent.
  pipeline(file.body, res).catch((err: Error) => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
  });
}

/** Frees a download that will not be sent (its temporary file is deleted). */
export function discardExportFile(file: ExportFile): void {
  if (!Buffer.isBuffer(file.body)) file.body.destroy();
}
