import { Body, Controller, Param, Post, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { OrgRole } from '@prisma/client';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { PublishTokenGuard } from '../handoff/publish-token.guard.js';
import { AnalysesService } from './analyses.service.js';
import { SaveVizcanvasAnalysisDto } from './dto/save-vizcanvas-analysis.dto.js';

const MAX_RESULT_BYTES = 500 * 1024 * 1024;

@Controller('organizations/:organizationId/datasets/:datasetId/analyses/vizcanvas')
@UseGuards(PublishTokenGuard, OrgRolesGuard, DatasetAccessGuard)
export class AnalysesVizcanvasController {
  constructor(private readonly analysesService: AnalysesService) {}

  @Post()
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_RESULT_BYTES } }))
  create(
    @Param('datasetId') datasetId: string,
    @Body() dto: SaveVizcanvasAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analysesService.createFromVizcanvas(datasetId, dto, file, user.id);
  }

  @Put(':analysisId')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_RESULT_BYTES } }))
  update(
    @Param('datasetId') datasetId: string,
    @Param('analysisId') analysisId: string,
    @Body() dto: SaveVizcanvasAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.analysesService.updateFromVizcanvas(datasetId, analysisId, dto, file);
  }
}
