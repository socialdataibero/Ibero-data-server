import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { CreateSurveyDto } from '../dto/create-survey.dto.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { UpdateSurveyDto } from '../dto/update-survey.dto.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { SurveysService } from './surveys.service.js';

/** Surveys: list, create, read, rename and describe, delete. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class SurveysController {
  constructor(
    private readonly access: SurveyAccessService,
    private readonly lookup: HarmonizerLookupService,
    private readonly surveys: SurveysService,
  ) {}

  @Get('surveys')
  listSurveys(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.surveys.listSurveys({
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Post('surveys')
  async createSurvey(
    @Body() dto: CreateSurveyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanCreateIn(user, dto.organizationId);
    return this.surveys.createSurvey(dto, user.id);
  }

  @Get('surveys/:surveyId')
  async survey(@Param('surveyId') surveyId: string) {
    return this.surveys.toSurveyDto(await this.lookup.getSurvey(surveyId));
  }

  @Patch('surveys/:surveyId')
  async updateSurvey(
    @Param('surveyId') surveyId: string,
    @Body() dto: UpdateSurveyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.surveys.updateSurvey(surveyId, dto);
  }

  @Delete('surveys/:surveyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSurvey(
    @Param('surveyId') surveyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.surveys.removeSurvey(surveyId);
  }
}
