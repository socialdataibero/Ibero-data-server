import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { HarmonizerService } from './harmonizer.service.js';
import { HarmonizerController } from './harmonizer.controller.js';
import { SurveyAccessService } from './survey-access.service.js';
import { HarmonizerUploadsController } from './import/harmonizer-uploads.controller.js';
import { HarmonizerUploadsService } from './import/harmonizer-uploads.service.js';
import { HarmonizerDownloadsController } from './downloads/harmonizer-downloads.controller.js';
import { HarmonizerDownloadsService } from './downloads/harmonizer-downloads.service.js';
import {
  UPLOAD_STORAGE,
  createUploadStorage,
} from './import/upload-storage.js';

@Module({
  imports: [AuthModule, AnalysisModule, JobsModule],
  controllers: [
    HarmonizerController,
    HarmonizerUploadsController,
    HarmonizerDownloadsController,
  ],
  providers: [
    HarmonizerService,
    SurveyAccessService,
    HarmonizerUploadsService,
    HarmonizerDownloadsService,
    { provide: UPLOAD_STORAGE, useFactory: () => createUploadStorage() },
  ],
  exports: [HarmonizerService],
})
export class HarmonizerModule {}
