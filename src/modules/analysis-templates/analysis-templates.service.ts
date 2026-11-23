import { Injectable } from '@nestjs/common';
import { AnalysisService } from '../analysis/analysis.service.js';
import { parseSourceMetadata } from '../harmonizer/source-metadata.js';
import { ResourcesService } from '../datasets/resources.service.js';
import { templateMetadata } from './template-metadata.js';
import { listTemplates } from './template-catalog.js';
import { runTemplate, type TemplateRequest } from './template-run.js';

@Injectable()
export class AnalysisTemplatesService {
  constructor(
    private readonly resources: ResourcesService,
    private readonly analysis: AnalysisService,
  ) {}

  /**
   * Every template, with the columns of the resource each input can take, or why it cannot be
   * used, read from its source metadata (`templateMetadata`). `editions` lists the editions of the
   * file; with several, the analysis must choose one (`edition` in the preview), and the listing
   * is that of `editionId` or, without it, of the first one.
   */
  async list(datasetId: string, resourceId: string, editionId?: string) {
    const resource = await this.resources.findOne(datasetId, resourceId);
    const metadata = templateMetadata(parseSourceMetadata(resource.sourceMetadata), editionId, {
      pickFirst: true,
    });
    return {
      resourceId: resource.id,
      source: metadata
        ? { title: metadata.title, design: metadata.design, unitPlural: metadata.unitPlural }
        : null,
      editions: metadata?.editions ?? [],
      templates: listTemplates(metadata),
    };
  }

  /** Runs a template over a resource without saving anything. */
  async preview(datasetId: string, resourceId: string, request: TemplateRequest) {
    const resource = await this.resources.findOne(datasetId, resourceId);
    const metadata = templateMetadata(parseSourceMetadata(resource.sourceMetadata), request.edition);
    const path = await this.resources.resolveFilePath(datasetId, resourceId);
    return runTemplate(request, metadata, (queries, filter) =>
      this.analysis.runInternalQueries(path, queries, filter),
    );
  }
}
