import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { HarmonizerService } from './harmonizer.service.js';
import { HarmonizerController } from './harmonizer.controller.js';
import { SurveyAccessService } from './survey-access.service.js';

@Module({
  imports: [AuthModule, AnalysisModule],
  controllers: [HarmonizerController],
  providers: [HarmonizerService, SurveyAccessService],
  exports: [HarmonizerService],
})
export class HarmonizerModule {}
