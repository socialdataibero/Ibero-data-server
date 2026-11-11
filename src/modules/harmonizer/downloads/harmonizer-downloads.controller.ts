import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sendExportFile } from '../export-response.js';
import { HarmonizerDownloadsService } from './harmonizer-downloads.service.js';

/**
 * A prepared download (`POST .../download` in HarmonizerController). No session: the browser
 * opens this link directly, and the token in it is the permission (random, once, 15 minutes).
 */
@Controller('harmonizer/downloads')
export class HarmonizerDownloadsController {
  constructor(private readonly downloads: HarmonizerDownloadsService) {}

  @Get(':token')
  download(@Param('token') token: string, @Res() res: Response): void {
    const file = this.downloads.take(token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    sendExportFile(res, file);
  }
}
