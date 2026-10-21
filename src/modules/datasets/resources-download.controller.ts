import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { OrgRole } from '@prisma/client';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { DownloadTokenGuard } from '../handoff/download-token.guard.js';
import { ResourcesService } from './resources.service.js';

@Controller('organizations/:organizationId/datasets/:datasetId/resources')
@UseGuards(DownloadTokenGuard, OrgRolesGuard, DatasetAccessGuard)
export class ResourcesDownloadController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get(':resourceId/download')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  async download(
    @Param('datasetId') datasetId: string,
    @Param('resourceId') resourceId: string,
    @Res() res: Response,
  ) {
    const resource = await this.resourcesService.findOne(datasetId, resourceId);
    const path = await this.resourcesService.resolveFilePath(datasetId, resourceId);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${resource.filename}"`);
    createReadStream(path).pipe(res);
  }
}
