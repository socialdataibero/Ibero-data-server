import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { HandoffService } from '../handoff/handoff.service.js';
import { ResourcesService } from './resources.service.js';
import { RunQueryDto } from './dto/run-query.dto.js';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

@Controller('organizations/:organizationId/datasets/:datasetId/resources')
@UseGuards(JwtAuthGuard, OrgRolesGuard, DatasetAccessGuard)
export class ResourcesController {
  constructor(
    private readonly resourcesService: ResourcesService,
    private readonly analysisService: AnalysisService,
    private readonly handoffService: HandoffService,
  ) {}

  @Get()
  findAll(@Param('datasetId') datasetId: string) {
    return this.resourcesService.findAll(datasetId);
  }

  @Post()
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  upload(@Param('datasetId') datasetId: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException({
        code: 'file_required',
        message: 'Missing file (field "file").',
      });
    }
    return this.resourcesService.upload(datasetId, file);
  }

  @Post(':resourceId/query')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  async query(
    @Param('datasetId') datasetId: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: RunQueryDto,
  ) {
    const filePath = await this.resourcesService.resolveFilePath(datasetId, resourceId);
    return this.analysisService.runQuery(filePath, dto.sql);
  }

  @Get(':resourceId/vizcanvas-handoff')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  async vizcanvasHandoff(
    @Param('organizationId') organizationId: string,
    @Param('datasetId') datasetId: string,
    @Param('resourceId') resourceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const resource = await this.resourcesService.findOne(datasetId, resourceId);
    const context = await this.resourcesService.handoffContext(organizationId, datasetId);
    const downloadUrl = this.downloadUrl(organizationId, datasetId, resourceId);
    return {
      url: this.handoffService.buildResourceHandoffUrl(user, downloadUrl, resource.filename, {
        ...context,
        resourceId: resource.id,
        resourceName: resource.filename,
      }),
    };
  }

  private downloadUrl(organizationId: string, datasetId: string, resourceId: string): string {
    return `${this.handoffService.apiBaseUrl()}/organizations/${organizationId}/datasets/${datasetId}/resources/${resourceId}/download`;
  }
}
