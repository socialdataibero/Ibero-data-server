import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { OP_CATALOG, stepsToInternal, toVizCanvasRecipe } from '../analysis/recipe.js';
import { ResourcesService } from '../datasets/resources.service.js';
import { HandoffService } from '../handoff/handoff.service.js';
import { AnalysesService, type VizcanvasRecipe } from './analyses.service.js';
import { PreviewAnalysisDto } from './dto/preview-analysis.dto.js';
import { CreateAnalysisDto } from './dto/create-analysis.dto.js';

@Controller('organizations/:organizationId/datasets/:datasetId/analyses')
@UseGuards(JwtAuthGuard, OrgRolesGuard, DatasetAccessGuard)
export class AnalysesController {
  constructor(
    private readonly analysesService: AnalysesService,
    private readonly resourcesService: ResourcesService,
    private readonly handoffService: HandoffService,
  ) {}

  @Get('operations')
  operations() {
    return OP_CATALOG;
  }

  @Get()
  findAll(@Param('datasetId') datasetId: string) {
    return this.analysesService.findAll(datasetId);
  }

  @Get(':analysisId')
  findOne(@Param('datasetId') datasetId: string, @Param('analysisId') analysisId: string) {
    return this.analysesService.findOne(datasetId, analysisId);
  }

  @Get(':analysisId/data')
  getData(@Param('datasetId') datasetId: string, @Param('analysisId') analysisId: string) {
    return this.analysesService.getData(datasetId, analysisId);
  }

  @Post('preview')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  preview(@Param('datasetId') datasetId: string, @Body() dto: PreviewAnalysisDto) {
    return this.analysesService.preview(datasetId, dto);
  }

  @Post()
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  create(
    @Param('datasetId') datasetId: string,
    @Body() dto: CreateAnalysisDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.analysesService.create(datasetId, dto, user.id);
  }

  @Patch(':analysisId')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  update(
    @Param('datasetId') datasetId: string,
    @Param('analysisId') analysisId: string,
    @Body() dto: CreateAnalysisDto,
  ) {
    return this.analysesService.update(datasetId, analysisId, dto);
  }

  @Delete(':analysisId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgRoles(OrgRole.ADMIN)
  remove(@Param('datasetId') datasetId: string, @Param('analysisId') analysisId: string) {
    return this.analysesService.remove(datasetId, analysisId);
  }

  @Get(':analysisId/vizcanvas-handoff')
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR, OrgRole.MEMBER)
  async vizcanvasHandoff(
    @Param('organizationId') organizationId: string,
    @Param('datasetId') datasetId: string,
    @Param('analysisId') analysisId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const analysis = await this.analysesService.findOne(datasetId, analysisId);
    const context = await this.resourcesService.handoffContext(organizationId, datasetId);
    const base = this.handoffService.apiBaseUrl();
    const resourceDownloadUrl = (resourceId: string) =>
      `${base}/organizations/${organizationId}/datasets/${datasetId}/resources/${resourceId}/download`;

    if (analysis.origin === 'VIZCANVAS') {
      const recipe = analysis.vizcanvasRecipe as unknown as VizcanvasRecipe | null;
      if (!recipe) {
        throw new BadRequestException({
          code: 'vizcanvas_recipe_missing',
          message: 'This analysis does not have a VizCanvas recipe.',
        });
      }
      const url = this.handoffService.buildCanvasHandoffUrl(
        user,
        {
          state: recipe.state,
          tables: recipe.tables.map((t) => ({ ...t, downloadUrl: resourceDownloadUrl(t.resourceId) })),
        },
        { ...context, resourceId: analysis.sourceResourceId, analysisId: analysis.id, analysisTitle: analysis.title },
      );
      return { url };
    }

    const sourceResource = await this.resourcesService.findOne(datasetId, analysis.sourceResourceId);
    const resultDownloadUrl = `${base}/organizations/${organizationId}/datasets/${datasetId}/analyses/${analysisId}/download`;

    const recipe = stepsToInternal(analysis.recipe as { op: string; params?: Record<string, unknown> }[]);
    const vizCanvasRecipe = toVizCanvasRecipe(recipe);

    const joinResources = await Promise.all(
      recipe.joins.map(async (join) => {
        const joinResource = await this.resourcesService.findOne(datasetId, join.resourceId);
        return {
          alias: join.alias,
          downloadUrl: resourceDownloadUrl(joinResource.id),
          filename: joinResource.filename,
        };
      }),
    );

    const url = this.handoffService.buildAnalysisHandoffUrl(
      user,
      { downloadUrl: resultDownloadUrl, filename: `${analysis.title}.parquet` },
      { downloadUrl: resourceDownloadUrl(sourceResource.id), filename: sourceResource.filename },
      vizCanvasRecipe,
      joinResources,
      { ...context, resourceId: sourceResource.id, resourceName: sourceResource.filename },
    );
    return { url };
  }
}
