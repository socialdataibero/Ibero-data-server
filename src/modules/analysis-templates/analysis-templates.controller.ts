import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { AnalysisTemplatesService } from './analysis-templates.service.js';
import { PreviewTemplateDto } from './dto/preview-template.dto.js';

/** Analysis templates (demo): what can be computed with a resource, and computing it. */
@Controller('organizations/:organizationId/datasets/:datasetId')
@UseGuards(JwtAuthGuard, OrgRolesGuard, DatasetAccessGuard)
export class AnalysisTemplatesController {
  constructor(private readonly templates: AnalysisTemplatesService) {}

  @Get('resources/:resourceId/templates')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  list(@Param('datasetId') datasetId: string, @Param('resourceId') resourceId: string) {
    return this.templates.list(datasetId, resourceId);
  }

  @Post('analyses/templates/preview')
  @HttpCode(HttpStatus.OK)
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  preview(@Param('datasetId') datasetId: string, @Body() dto: PreviewTemplateDto) {
    const { resourceId, ...request } = dto;
    return this.templates.preview(datasetId, resourceId, request);
  }
}
