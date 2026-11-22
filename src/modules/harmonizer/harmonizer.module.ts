import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AnalysisModule } from '../analysis/analysis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { HarmonizerLookupService } from './lookup.service.js';
import { CodebooksService } from './codebooks/codebooks.service.js';
import { EditionFilesService } from './editions/edition-files.service.js';
import { EditionFilesSweepService } from './editions/edition-files-sweep.service.js';
import { ColumnProfilesService } from './profiles/column-profiles.service.js';
import { SurveysService } from './surveys/surveys.service.js';
import { EditionsService } from './editions/editions.service.js';
import { SyncUploadService } from './import/sync-upload.service.js';
import { EditionReaderService } from './editions/edition-reader.service.js';
import { MappingTypesService } from './mapping/mapping-types.service.js';
import { VariablesService } from './variables/variables.service.js';
import { MappingService } from './mapping/mapping.service.js';
import { ViewsService } from './views/views.service.js';
import { ExportsService } from './views/exports.service.js';
import { SurveysController } from './surveys/surveys.controller.js';
import { VariablesController } from './variables/variables.controller.js';
import { CodebooksController } from './codebooks/codebooks.controller.js';
import { ViewsController } from './views/views.controller.js';
import { EditionsController } from './editions/editions.controller.js';
import { MappingController } from './mapping/mapping.controller.js';
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
    SurveysController,
    VariablesController,
    CodebooksController,
    ViewsController,
    EditionsController,
    MappingController,
    HarmonizerUploadsController,
    HarmonizerDownloadsController,
  ],
  providers: [
    HarmonizerLookupService,
    CodebooksService,
    EditionFilesService,
    EditionFilesSweepService,
    ColumnProfilesService,
    SurveysService,
    EditionsService,
    SyncUploadService,
    EditionReaderService,
    MappingTypesService,
    VariablesService,
    MappingService,
    ViewsService,
    ExportsService,
    SurveyAccessService,
    HarmonizerUploadsService,
    HarmonizerDownloadsService,
    { provide: UPLOAD_STORAGE, useFactory: () => createUploadStorage() },
  ],
  exports: [ExportsService],
})
export class HarmonizerModule {}
