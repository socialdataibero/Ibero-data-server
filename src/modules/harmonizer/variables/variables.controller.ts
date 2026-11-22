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
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { sendExportFile } from '../export-response.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { RenameCanonicalVariableDto } from '../dto/rename-canonical-variable.dto.js';
import { SaveRecodingDto } from '../dto/save-recoding.dto.js';
import { SaveVariableAnalysisDto } from '../dto/save-variable-analysis.dto.js';
import { VariablesService } from './variables.service.js';

/** Canonical variables of a survey: list, rename, delete, codes between editions, review, recoding, catalog. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class VariablesController {
  constructor(
    private readonly access: SurveyAccessService,
    private readonly variables: VariablesService,
  ) {}

  @Get('surveys/:surveyId/variables')
  canonicalVariables(@Param('surveyId') surveyId: string) {
    return this.variables.listCanonicalVariables(surveyId);
  }

  @Patch('surveys/:surveyId/variables/:variableId')
  async renameCanonicalVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @Body() dto: RenameCanonicalVariableDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.renameCanonicalVariable(surveyId, variableId, dto);
  }

  @Delete('surveys/:surveyId/variables/:variableId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCanonicalVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.removeCanonicalVariable(surveyId, variableId);
  }

  @Get('surveys/:surveyId/variables/:variableId/comparison')
  variableComparison(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
  ) {
    return this.variables.getVariableComparison(surveyId, variableId);
  }

  @Post('surveys/:surveyId/variables/:variableId/review')
  async reviewVariable(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.reviewVariable(surveyId, variableId, user.email);
  }

  @Delete('surveys/:surveyId/variables/:variableId/review')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearVariableReview(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.clearVariableReview(surveyId, variableId);
  }

  @Put('surveys/:surveyId/variables/:variableId/recoding')
  async saveRecoding(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @Body() dto: SaveRecodingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.saveRecoding(surveyId, variableId, dto);
  }

  /** How the variable is used in analysis: role, universe, "yes" code, level, unit, groups. */
  @Put('surveys/:surveyId/variables/:variableId/analysis')
  async saveAnalysis(
    @Param('surveyId') surveyId: string,
    @Param('variableId') variableId: string,
    @Body() dto: SaveVariableAnalysisDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditSurvey(user, surveyId);
    return this.variables.saveAnalysis(surveyId, variableId, dto);
  }

  @Get('surveys/:surveyId/catalog.csv')
  async catalog(@Param('surveyId') surveyId: string, @Res() res: Response) {
    sendExportFile(res, await this.variables.exportCatalog(surveyId));
  }
}
