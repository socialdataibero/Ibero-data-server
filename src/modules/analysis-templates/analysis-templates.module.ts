import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { DatasetsModule } from '../datasets/datasets.module.js';
import { AnalysesModule } from '../analyses/analyses.module.js';
import { AnalysisTemplatesController } from './analysis-templates.controller.js';
import { AnalysisTemplatesService } from './analysis-templates.service.js';

@Module({
  imports: [AuthModule, AnalysisModule, DatasetsModule, AnalysesModule],
  controllers: [AnalysisTemplatesController],
  providers: [AnalysisTemplatesService],
})
export class AnalysisTemplatesModule {}
