import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { HandoffModule } from '../handoff/handoff.module.js';
import { HarmonizerModule } from '../harmonizer/harmonizer.module.js';
import { DatasetsService } from './datasets.service.js';
import { DatasetsController } from './datasets.controller.js';
import { DatasetsGlobalController } from './datasets-global.controller.js';
import { ResourcesService } from './resources.service.js';
import { ResourcesController } from './resources.controller.js';
import { ResourcesDownloadController } from './resources-download.controller.js';

@Module({
  imports: [AuthModule, AnalysisModule, HandoffModule, HarmonizerModule],
  controllers: [
    DatasetsController,
    DatasetsGlobalController,
    ResourcesController,
    ResourcesDownloadController,
  ],
  providers: [DatasetsService, ResourcesService],
  exports: [DatasetsService, ResourcesService],
})
export class DatasetsModule {}
