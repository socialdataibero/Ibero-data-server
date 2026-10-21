import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { OrgRolesGuard } from '../../shared/guards/org-roles.guard.js';
import { OrgRoles } from '../../shared/decorators/org-roles.decorator.js';
import { SysadminGuard } from '../../shared/guards/sysadmin.guard.js';
import { SysadminOnly } from '../../shared/decorators/sysadmin.decorator.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { OrganizationsService, type OrganizationSort } from './organizations.service.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { AddMemberDto } from './dto/add-member.dto.js';

function parseTerms(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrgRolesGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  findAll(
    @Query('q') q?: string,
    @Query('term') term?: string | string[],
    @Query('sort') sort?: OrganizationSort,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.organizationsService.findAll({
      q,
      terms: parseTerms(term),
      sort,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get('recent')
  findRecent() {
    return this.organizationsService.findRecent(5);
  }

  @Get(':organizationId')
  findOne(@Param('organizationId') organizationId: string) {
    return this.organizationsService.findOne(organizationId);
  }

  @Post()
  @UseGuards(SysadminGuard)
  @SysadminOnly()
  create(@Body() dto: CreateOrganizationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.create(dto, user.id);
  }

  @Post(':organizationId/members')
  @OrgRoles(OrgRole.ADMIN)
  addMember(@Param('organizationId') organizationId: string, @Body() dto: AddMemberDto) {
    return this.organizationsService.addMember(organizationId, dto);
  }

  @Delete(':organizationId/members/:userId')
  @OrgRoles(OrgRole.ADMIN)
  removeMember(@Param('organizationId') organizationId: string, @Param('userId') userId: string) {
    return this.organizationsService.removeMember(organizationId, userId);
  }

  @Delete(':organizationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @OrgRoles(OrgRole.ADMIN)
  remove(@Param('organizationId') organizationId: string) {
    return this.organizationsService.remove(organizationId);
  }
}
