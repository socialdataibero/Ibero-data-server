import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { sendExportFile } from '../export-response.js';
import { HarmonizerDownloadsService } from '../downloads/harmonizer-downloads.service.js';
import { ViewsService } from './views.service.js';
import { ExportsService } from './exports.service.js';

function pageParams(limit?: string, offset?: string) {
  return {
    limit: limit !== undefined ? Number(limit) : undefined,
    offset: offset !== undefined ? Number(offset) : undefined,
  };
}

/** Harmonized views on screen, their downloads (also prepared as direct downloads) and the original file. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class ViewsController {
  constructor(
    private readonly downloads: HarmonizerDownloadsService,
    private readonly views: ViewsService,
    private readonly exports: ExportsService,
  ) {}

  @Get('surveys/:surveyId/harmonized')
  surveyHarmonized(
    @Param('surveyId') surveyId: string,
    @Query('variables') variables?: string | string[],
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.views.getSurveyHarmonized(
      surveyId,
      variables,
      pageParams(limit, offset),
    );
  }

  @Get('surveys/:surveyId/harmonized.:fmt')
  async surveyExport(
    @Param('surveyId') surveyId: string,
    @Param('fmt') fmt: string,
    @Query('variables') variables: string | string[] | undefined,
    @Res() res: Response,
  ) {
    sendExportFile(
      res,
      await this.exports.exportSurvey(surveyId, fmt, variables),
    );
  }

  /** Prepares the same file for a direct download (see HarmonizerDownloadsController). */
  @Post('surveys/:surveyId/harmonized.:fmt/download')
  async prepareSurveyExport(
    @Param('surveyId') surveyId: string,
    @Param('fmt') fmt: string,
    @Query('variables') variables: string | string[] | undefined,
  ) {
    return this.downloads.register(
      await this.exports.exportSurvey(surveyId, fmt, variables),
    );
  }

  @Get('datasets/:datasetId/harmonized')
  datasetHarmonized(
    @Param('datasetId') datasetId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.views.getDatasetHarmonized(
      datasetId,
      pageParams(limit, offset),
    );
  }

  @Get('datasets/:datasetId/harmonized.:fmt')
  async datasetExport(
    @Param('datasetId') datasetId: string,
    @Param('fmt') fmt: string,
    @Res() res: Response,
  ) {
    sendExportFile(res, await this.exports.exportDataset(datasetId, fmt));
  }

  @Post('datasets/:datasetId/harmonized.:fmt/download')
  async prepareDatasetExport(
    @Param('datasetId') datasetId: string,
    @Param('fmt') fmt: string,
  ) {
    return this.downloads.register(
      await this.exports.exportDataset(datasetId, fmt),
    );
  }

  @Get('datasets/:datasetId/original.csv')
  async datasetOriginal(
    @Param('datasetId') datasetId: string,
    @Res() res: Response,
  ) {
    sendExportFile(res, await this.exports.exportOriginal(datasetId));
  }

  @Post('datasets/:datasetId/original.csv/download')
  async prepareDatasetOriginal(@Param('datasetId') datasetId: string) {
    return this.downloads.register(
      await this.exports.exportOriginal(datasetId),
    );
  }
}
