import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../../shared/guards/jwt-auth.guard.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { SaveMappingDto } from '../dto/save-mapping.dto.js';
import { MappingService } from './mapping.service.js';

/** The mapping of an edition: suggested, saved, and saving it. */
@Controller('harmonizer')
@UseGuards(JwtAuthGuard)
export class MappingController {
  constructor(
    private readonly access: SurveyAccessService,
    private readonly mappingService: MappingService,
  ) {}

  @Get('datasets/:datasetId/mapping')
  mapping(@Param('datasetId') datasetId: string) {
    return this.mappingService.getMapping(datasetId);
  }

  @Get('datasets/:datasetId/mapping/saved')
  savedMapping(@Param('datasetId') datasetId: string) {
    return this.mappingService.getSavedMapping(datasetId);
  }

  @Put('datasets/:datasetId/mapping')
  async saveMapping(
    @Param('datasetId') datasetId: string,
    @Body() dto: SaveMappingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.access.assertCanEditDataset(user, datasetId);
    return this.mappingService.saveMapping(datasetId, dto);
  }
}
