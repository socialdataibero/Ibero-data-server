import { Injectable } from '@nestjs/common';
import { AnalysisService } from '../analysis/analysis.service.js';
import { readVariableMetadata } from '../analysis/variable-metadata.js';
import { ResourcesService } from '../datasets/resources.service.js';
import { listTemplates } from './template-catalog.js';
import { runTemplate, type TemplateRequest } from './template-run.js';

@Injectable()
export class AnalysisTemplatesService {
  constructor(
    private readonly resources: ResourcesService,
    private readonly analysis: AnalysisService,
  ) {}

  /** Every template, with the columns of the resource each input can take, or why it cannot be used. */
  async list(datasetId: string, resourceId: string) {
    const resource = await this.resources.findOne(datasetId, resourceId);
    const metadata = readVariableMetadata(resource.variableMetadata);
    return {
      resourceId: resource.id,
      source: metadata
        ? { title: metadata.title, design: metadata.design, unitPlural: metadata.unitPlural }
        : null,
      templates: listTemplates(metadata),
    };
  }

  /** Runs a template over a resource without saving anything. */
  async preview(datasetId: string, resourceId: string, request: TemplateRequest) {
    const resource = await this.resources.findOne(datasetId, resourceId);
    const metadata = readVariableMetadata(resource.variableMetadata);
    const path = await this.resources.resolveFilePath(datasetId, resourceId);
    return runTemplate(request, metadata, (queries) => this.analysis.runInternalQueries(path, queries));
  }
}
