import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard.js';
import { HarmonizerService, type ExportFile } from './harmonizer.service.js';
import { CreateSurveyDto } from './dto/create-survey.dto.js';
import { UpdateSurveyDto } from './dto/update-survey.dto.js';
import { UploadDatasetDto } from './dto/upload-dataset.dto.js';
import { SaveMappingDto } from './dto/save-mapping.dto.js';

const MAX_CSV_BYTES = 200 * 1024 * 1024;

@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class HarmonizerController {
  constructor(private readonly harmonizerService: HarmonizerService) {}

  @Get('surveys')
  listSurveys(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.harmonizerService.listSurveys({
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Post('surveys')
  createSurvey(@Body() dto: CreateSurveyDto) {
    return this.harmonizerService.createSurvey(dto);
  }

  @Get('surveys/:surveyId')
  async survey(@Param('surveyId') surveyId: string) {
    return this.harmonizerService.toSurveyDto(
      await this.harmonizerService.getSurvey(surveyId),
    );
  }

  @Patch('surveys/:surveyId')
  updateSurvey(
    @Param('surveyId') surveyId: string,
    @Body() dto: UpdateSurveyDto,
  ) {
    return this.harmonizerService.updateSurvey(surveyId, dto);
  }

  @Delete('surveys/:surveyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeSurvey(@Param('surveyId') surveyId: string) {
    return this.harmonizerService.removeSurvey(surveyId);
  }

  @Get('surveys/:surveyId/harmonized')
  surveyHarmonized(
    @Param('surveyId') surveyId: string,
    @Query('variables') variables?: string | string[],
  ) {
    return this.harmonizerService.getSurveyHarmonized(surveyId, variables);
  }

  @Get('surveys/:surveyId/harmonized.:fmt')
  async surveyExport(
    @Param('surveyId') surveyId: string,
    @Param('fmt') fmt: string,
    @Query('variables') variables: string | string[] | undefined,
    @Res() res: Response,
  ) {
    this.sendFile(
      res,
      await this.harmonizerService.exportSurvey(surveyId, fmt, variables),
    );
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_CSV_BYTES },
    }),
  )
  upload(
    @Body() dto: UploadDatasetDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException({
        code: 'file_required',
        message: 'Missing CSV file (field "file").',
      });
    }
    return this.harmonizerService.uploadDataset(dto, file);
  }

  @Get('datasets/:datasetId/mapping')
  mapping(@Param('datasetId') datasetId: string) {
    return this.harmonizerService.getMapping(datasetId);
  }

  @Put('datasets/:datasetId/mapping')
  saveMapping(
    @Param('datasetId') datasetId: string,
    @Body() dto: SaveMappingDto,
  ) {
    return this.harmonizerService.saveMapping(datasetId, dto);
  }

  @Get('datasets/:datasetId/harmonized')
  datasetHarmonized(@Param('datasetId') datasetId: string) {
    return this.harmonizerService.getDatasetHarmonized(datasetId);
  }

  @Get('datasets/:datasetId/harmonized.:fmt')
  async datasetExport(
    @Param('datasetId') datasetId: string,
    @Param('fmt') fmt: string,
    @Res() res: Response,
  ) {
    this.sendFile(
      res,
      await this.harmonizerService.exportDataset(datasetId, fmt),
    );
  }

  private sendFile(res: Response, file: ExportFile): void {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    res.send(file.body);
  }
}
