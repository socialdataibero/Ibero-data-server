import { BadRequestException, Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { OrgRole } from '@prisma/client';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { DownloadTokenGuard } from '../handoff/download-token.guard.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { AnalysesService } from './analyses.service.js';

@Controller('organizations/:organizationId/datasets/:datasetId/analyses')
@UseGuards(DownloadTokenGuard, OrgRolesGuard, DatasetAccessGuard)
export class AnalysesDownloadController {
  constructor(
    private readonly analysesService: AnalysesService,
    private readonly storage: LocalStorageService,
  ) {}

  @Get(':analysisId/download')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  async download(
    @Param('datasetId') datasetId: string,
    @Param('analysisId') analysisId: string,
    @Res() res: Response,
  ) {
    const analysis = await this.analysesService.findOne(datasetId, analysisId);
    if (analysis.status !== 'DONE' || !analysis.resultStorageKey) {
      throw new BadRequestException({
        code: 'analysis_result_not_ready',
        message: 'This analysis does not have a result ready yet.',
      });
    }
    const path = this.storage.resolvePath(analysis.resultStorageKey);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${analysis.title}.parquet"`);
    createReadStream(path).pipe(res);
  }
}
