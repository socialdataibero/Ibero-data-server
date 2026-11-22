import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { MAX_CODEBOOK_BYTES } from './codebooks.service.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { CreateCodebookDto } from '../dto/create-codebook.dto.js';
import { SetDatasetCodebookDto } from '../dto/set-dataset-codebook.dto.js';
import { CodebooksService } from './codebooks.service.js';

/** Dictionaries of a survey and the dictionary of an edition. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class CodebooksController {
  constructor(
    private readonly access: SurveyAccessService,
    private readonly codebooksService: CodebooksService,
  ) {}

  @Get('surveys/:surveyId/codebooks')
  codebooks(@Param('surveyId') surveyId: string) {
    return this.codebooksService.listCodebooks(surveyId);
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
    return this.codebooksService.createCodebook(surveyId, dto.name, file);
  }

  @Get('codebooks/:codebookId')
  codebook(@Param('codebookId') codebookId: string) {
    return this.codebooksService.getCodebook(codebookId);
  }

  @Delete('codebooks/:codebookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCodebook(
    @Param('codebookId') codebookId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditCodebook(user, codebookId);
    return this.codebooksService.removeCodebook(codebookId);
  }

  @Put('datasets/:datasetId/codebook')
  async setDatasetCodebook(
    @Param('datasetId') datasetId: string,
    @Body() dto: SetDatasetCodebookDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.codebooksService.setDatasetCodebook(datasetId, dto);
  }
}
