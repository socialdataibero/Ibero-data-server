import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { DatasetAccessGuard } from '../../shared/guards/dataset-access.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { DatasetsService, type DatasetSort } from './datasets.service.js';
import { CreateDatasetDto } from './dto/create-dataset.dto.js';

function parseTerms(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

@Controller('organizations/:organizationId/datasets')
@UseGuards(JwtAuthGuard, OrgRolesGuard, DatasetAccessGuard)
export class DatasetsController {
  constructor(private readonly datasetsService: DatasetsService) {}

  @Get()
  findAll(
    @Param('organizationId') organizationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('term') term?: string | string[],
    @Query('sort') sort?: DatasetSort,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.datasetsService.findAllByOrganization(organizationId, user, {
      q,
      terms: parseTerms(term),
      sort,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get(':datasetId')
  findOne(@Param('organizationId') organizationId: string, @Param('datasetId') datasetId: string) {
    return this.datasetsService.findOne(organizationId, datasetId);
  }

  @Post()
  @OrgRoles(OrgRole.ADMIN, OrgRole.EDITOR)
  create(
    @Param('organizationId') organizationId: string,
    @Body() dto: CreateDatasetDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.datasetsService.create(organizationId, dto, user.id);
  }

  @Delete(':datasetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgRoles(OrgRole.ADMIN)
  remove(@Param('organizationId') organizationId: string, @Param('datasetId') datasetId: string) {
    return this.datasetsService.remove(organizationId, datasetId);
  }
}
