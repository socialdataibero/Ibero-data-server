import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { DatasetsService, type DatasetSort } from './datasets.service.js';

function parseTerms(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

@Controller('datasets')
@UseGuards(JwtAuthGuard)
export class DatasetsGlobalController {
  constructor(private readonly datasetsService: DatasetsService) {}

  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q?: string,
    @Query('term') term?: string | string[],
    @Query('sort') sort?: DatasetSort,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.datasetsService.findAllGlobal(user, {
      q,
      terms: parseTerms(term),
      sort,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }
}
