import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { NEW_SURVEY } from '../dto/upload-dataset.dto.js';
import { UploadDatasetDto } from '../dto/upload-dataset.dto.js';
import { UpdateDatasetDto } from '../dto/update-dataset.dto.js';
import {
  missingSourceInfo,
  sourceInfoRequiredBody,
} from '../source-metadata.js';
import { EditionsService } from './editions.service.js';
import { SyncUploadService } from '../import/sync-upload.service.js';

const MAX_CSV_BYTES = 200 * 1024 * 1024;

/** Editions: the one-request upload, source design and unit, delete. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class EditionsController {
  constructor(
    private readonly access: SurveyAccessService,
    private readonly editions: EditionsService,
    private readonly syncUpload: SyncUploadService,
  ) {}

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
    const missing = missingSourceInfo(dto);
    if (missing.length > 0) {
      const { statusCode: _status, ...body } = sourceInfoRequiredBody(missing);
      throw new BadRequestException(body);
    }
    if (dto.surveyId === NEW_SURVEY) {
      if (!dto.organizationId) {
        throw new BadRequestException({
          code: 'survey_organization_required',
          message:
            'A new survey needs an organization (field "organizationId").',
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
    return this.syncUpload.uploadDataset(dto, file, user.id);
  }

  /** Changes the source design or unit of analysis of an edition. */
  @Patch('datasets/:datasetId')
  async updateDataset(
    @Param('datasetId') datasetId: string,
    @Body() dto: UpdateDatasetDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.editions.updateDataset(datasetId, dto);
  }

  @Delete('datasets/:datasetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDataset(
    @Param('datasetId') datasetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.editions.removeDataset(datasetId);
  }
}
