import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { PublicService } from './public.service.js';

@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('catalog')
  search(
    @Query('q') q?: string,
    @Query('org') org?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.publicService.search({
      q,
      org,
      sort,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get('catalog/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.publicService.getPackageBySlug(slug);
  }

  @Get('catalog/:slug/preview')
  preview(@Param('slug') slug: string, @Query('limit') limit?: string) {
    return this.publicService.previewBySlug(slug, limit !== undefined ? Number(limit) : undefined);
  }

  @Get('catalog/:slug/download')
  async download(@Param('slug') slug: string, @Res() res: Response) {
    const { path, filename } = await this.publicService.getResultFile(slug);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    createReadStream(path).pipe(res);
  }

  @Get('catalog/:slug/resources/:resourceId/download')
  async downloadResource(@Param('slug') slug: string, @Param('resourceId') resourceId: string, @Res() res: Response) {
    const { path, filename } = await this.publicService.getDatasetResourceFile(slug, resourceId);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    createReadStream(path).pipe(res);
  }

  @Get('catalog/:slug/vistrace-handoff')
  vistraceHandoff(@Param('slug') slug: string) {
    return this.publicService.buildVistraceHandoff(slug);
  }

  @Get('organizations')
  organizations(
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.publicService.listOrganizations({
      q,
      sort,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get('organizations/count')
  countByOrganization() {
    return this.publicService.countByOrganization();
  }
}
