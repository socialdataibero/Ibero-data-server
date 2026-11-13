import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service.js';
import { ResourceMetadataService } from './resource-metadata.js';

@Module({
  providers: [AnalysisService, ResourceMetadataService],
  exports: [AnalysisService, ResourceMetadataService],
})
export class AnalysisModule {}
