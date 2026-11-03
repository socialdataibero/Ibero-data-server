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
import { CurrentUser } from '../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import {
  HarmonizerService,
  MAX_CODEBOOK_BYTES,
  type ExportFile,
} from './harmonizer.service.js';
import { CreateSurveyDto } from './dto/create-survey.dto.js';
import { SurveyAccessService } from './survey-access.service.js';
import { NEW_SURVEY } from './dto/upload-dataset.dto.js';
import { UpdateSurveyDto } from './dto/update-survey.dto.js';
import { UploadDatasetDto } from './dto/upload-dataset.dto.js';
import { SaveMappingDto } from './dto/save-mapping.dto.js';
import { RenameCanonicalVariableDto } from './dto/rename-canonical-variable.dto.js';
import { CreateCodebookDto } from './dto/create-codebook.dto.js';
import { SetDatasetCodebookDto } from './dto/set-dataset-codebook.dto.js';
import { SaveRecodingDto } from './dto/save-recoding.dto.js';

const MAX_CSV_BYTES = 200 * 1024 * 1024;

function pageParams(limit?: string, offset?: string) {
  return {
    limit: limit !== undefined ? Number(limit) : undefined,
    offset: offset !== undefined ? Number(offset) : undefined,
  };
}

@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class HarmonizerController {
  constructor(
    private readonly harmonizerService: HarmonizerService,
    private readonly access: SurveyAccessService,
  ) {}

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
  async createSurvey(@Body() dto: CreateSurveyDto, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanCreateIn(user, dto.organizationId);
    return this.harmonizerService.createSurvey(dto, user.id);
  }

  @Get('surveys/:surveyId')
  async survey(@Param('surveyId') surveyId: string) {
    return this.harmonizerService.toSurveyDto(
      await this.harmonizerService.getSurvey(surveyId),
    );
  }

  @Patch('surveys/:surveyId')
  async updateSurvey(
    @Param('surveyId') surveyId: string,
    @Body() dto: UpdateSurveyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.updateSurvey(surveyId, dto);
  }

  @Delete('surveys/:surveyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSurvey(@Param('surveyId') surveyId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.removeSurvey(surveyId);
  }

  @Get('surveys/:surveyId/variables')
  canonicalVariables(@Param('surveyId') surveyId: string) {
    return this.harmonizerService.listCanonicalVariables(surveyId);
  }

  @Patch('surveys/:surveyId/variables/:variableId')
  async renameCanonicalVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @Body() dto: RenameCanonicalVariableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.renameCanonicalVariable(
      surveyId,
      variableId,
      dto,
    );
  }

  @Delete('surveys/:surveyId/variables/:variableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCanonicalVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.removeCanonicalVariable(surveyId, variableId);
  }

  @Get('surveys/:surveyId/variables/:variableId/comparison')
  variableComparison(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
  ) {
    return this.harmonizerService.getVariableComparison(surveyId, variableId);
  }

  @Post('surveys/:surveyId/variables/:variableId/review')
  async reviewVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.reviewVariable(surveyId, variableId, user.email);
  }

  @Delete('surveys/:surveyId/variables/:variableId/review')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearVariableReview(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.clearVariableReview(surveyId, variableId);
  }

  @Put('surveys/:surveyId/variables/:variableId/recoding')
  async saveRecoding(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @Body() dto: SaveRecodingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.harmonizerService.saveRecoding(surveyId, variableId, dto);
  }

  @Get('surveys/:surveyId/catalog.csv')
  async catalog(@Param('surveyId') surveyId: string, @Res() res: Response) {
    this.sendFile(res, await this.harmonizerService.exportCatalog(surveyId));
  }

  @Get('surveys/:surveyId/codebooks')
  codebooks(@Param('surveyId') surveyId: string) {
    return this.harmonizerService.listCodebooks(surveyId);
  }

  @Post('surveys/:surveyId/codebooks')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_CODEBOOK_BYTES },
    }),
  )
  async createCodebook(
    @Param('surveyId') surveyId: string,
    @Body() dto: CreateCodebookDto,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    if (!file) {
      throw new BadRequestException({
        code: 'file_required',
        message: 'Missing the dictionary file (field "file").',
      });
    }
    return this.harmonizerService.createCodebook(surveyId, dto.name, file);
  }

  @Get('codebooks/:codebookId')
  codebook(@Param('codebookId') codebookId: string) {
    return this.harmonizerService.getCodebook(codebookId);
  }

  @Delete('codebooks/:codebookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCodebook(@Param('codebookId') codebookId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanEditCodebook(user, codebookId);
    return this.harmonizerService.removeCodebook(codebookId);
  }

  @Get('surveys/:surveyId/harmonized')
  surveyHarmonized(
    @Param('surveyId') surveyId: string,
    @Query('variables') variables?: string | string[],
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.harmonizerService.getSurveyHarmonized(
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
  async upload(
    @Body() dto: UploadDatasetDto,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (dto.surveyId === NEW_SURVEY) {
      if (!dto.organizationId) {
        throw new BadRequestException({
          code: 'survey_organization_required',
          message: 'A new survey needs an organization (field "organizationId").',
        });
      }
      await this.access.assertCanCreateIn(user, dto.organizationId);
    } else {
      await this.access.assertCanEditSurvey(user, dto.surveyId);
    }
    if (!file) {
      throw new BadRequestException({
        code: 'file_required',
        message: 'Missing the CSV or DBF file (field "file").',
      });
    }
    return this.harmonizerService.uploadDataset(dto, file, user.id);
  }

  @Get('datasets/:datasetId/mapping')
  mapping(@Param('datasetId') datasetId: string) {
    return this.harmonizerService.getMapping(datasetId);
  }

  @Get('datasets/:datasetId/mapping/saved')
  savedMapping(@Param('datasetId') datasetId: string) {
    return this.harmonizerService.getSavedMapping(datasetId);
  }

  @Put('datasets/:datasetId/codebook')
  async setDatasetCodebook(
    @Param('datasetId') datasetId: string,
    @Body() dto: SetDatasetCodebookDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.harmonizerService.setDatasetCodebook(datasetId, dto);
  }

  @Put('datasets/:datasetId/mapping')
  async saveMapping(
    @Param('datasetId') datasetId: string,
    @Body() dto: SaveMappingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.harmonizerService.saveMapping(datasetId, dto);
  }

  @Delete('datasets/:datasetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDataset(@Param('datasetId') datasetId: string, @CurrentUser() user: AuthenticatedUser) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.harmonizerService.removeDataset(datasetId);
  }

  @Get('datasets/:datasetId/harmonized')
  datasetHarmonized(
    @Param('datasetId') datasetId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.harmonizerService.getDatasetHarmonized(
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
    this.sendFile(
      res,
      await this.harmonizerService.exportDataset(datasetId, fmt),
    );
  }

  @Get('datasets/:datasetId/original.csv')
  async datasetOriginal(
    @Param('datasetId') datasetId: string,
    @Res() res: Response,
  ) {
    this.sendFile(res, await this.harmonizerService.exportOriginal(datasetId));
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
