import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnalysisService } from '../../analysis/analysis.service.js';
import { editionPageSql, type ExportColumn } from '../harmonized-export.js';
import { EditionFilesService } from '../editions/edition-files.service.js';
import {
  EditionReaderService,
  type EditionMapping,
  type EditionRecord,
} from '../editions/edition-reader.service.js';
import { editionColumns } from '../editions/edition-reader.service.js';
import {
  editionView,
  pageRows,
  surveyView,
  type SurveyViewPage,
  type ViewRow,
} from './view-rows.js';
import { VariablesService } from '../variables/variables.service.js';
import { toDatasetInfo } from '../harmonizer-types.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import type { ViewPage, ViewPageParams } from '../harmonizer-types.js';

// Filas por página de las vistas en pantalla. La web ofrece 50, 100 y 500.
const DEFAULT_VIEW_LIMIT = 100;
const MAX_VIEW_LIMIT = 500;

function viewPage(params: ViewPageParams): ViewPage {
  const limit =
    params.limit === undefined || !Number.isFinite(params.limit)
      ? DEFAULT_VIEW_LIMIT
      : Math.min(Math.max(Math.trunc(params.limit), 1), MAX_VIEW_LIMIT);
  const offset =
    params.offset === undefined || !Number.isFinite(params.offset)
      ? 0
      : Math.max(Math.trunc(params.offset), 0);
  return { limit, offset };
}

/** The harmonized views on screen, one page at a time: by edition and by survey. */
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly lookup: HarmonizerLookupService,
    private readonly files: EditionFilesService,
    private readonly reader: EditionReaderService,
    private readonly variables: VariablesService,
  ) {}

  /**
   * One page of an edition with only the columns of `mappings`, harmonized by DuckDB with the
   * SQL of the downloads (`editionPageSql`). Only that stretch of the Parquet is read.
   */
  private async loadEditionPage(
    dataset: EditionRecord,
    mappings: EditionMapping[],
    page: ViewPage,
  ): Promise<{ columns: ExportColumn[]; rows: ViewRow[] }> {
    const columns = editionColumns(dataset, mappings);
    if (columns.length === 0 || page.limit <= 0) return { columns, rows: [] };
    const [rows] = await this.analysisService.runInternalQueries(
      await this.files.rawPath(dataset),
      [editionPageSql('data', columns, page.offset, page.limit)],
    );
    return { columns, rows: pageRows(columns, rows) };
  }

  async getDatasetHarmonized(datasetId: string, params: ViewPageParams = {}) {
    const dataset = await this.lookup.getDataset(datasetId);
    const page = viewPage(params);
    const mappings = await this.reader.editionMappings(dataset.id);
    const { columns, rows } = await this.loadEditionPage(
      dataset,
      mappings,
      page,
    );
    const view = editionView(columns, rows);
    return {
      dataset: toDatasetInfo(dataset),
      headers: view.headers,
      rows: view.rows,
      // Una edición sin mapeos no tiene columnas ni filas.
      total: view.headers.length > 0 ? dataset.rowCount : 0,
      limit: page.limit,
      offset: page.offset,
      availableVariables: view.headers,
      selectedCount: view.headers.length,
    };
  }

  /**
   * Una página de la vista por encuesta. Las ediciones van apiladas en el
   * mismo orden que la descarga y se conoce el `rowCount` de cada una, así que solo
   * se leen las filas de las ediciones que caen en la página.
   */
  async getSurveyHarmonized(
    surveyId: string,
    variables: string | string[] | undefined,
    params: ViewPageParams = {},
  ) {
    const survey = await this.lookup.getSurvey(surveyId);
    const page = viewPage(params);
    const { available, selected, wanted } = await this.reader.surveySelection(
      surveyId,
      variables,
    );
    const wantedSet = new Set(wanted);

    const datasets = await this.reader.surveyEditions(surveyId);

    let total = 0;
    const pages: SurveyViewPage[] = [];
    for (const { mappings, ...dataset } of datasets) {
      const used = mappings.filter((m) =>
        wantedSet.has(m.canonicalVariable.name),
      );
      // Una edición sin ninguna de las variables elegidas no aporta filas (igual que
      // en la descarga).
      if (used.length === 0) continue;
      const start = Math.max(page.offset - total, 0);
      const end = Math.min(page.offset + page.limit - total, dataset.rowCount);
      if (start < end) {
        pages.push({
          name: dataset.name,
          year: dataset.year,
          rowOffset: start,
          ...(await this.loadEditionPage(dataset, used, {
            offset: start,
            limit: end - start,
          })),
        });
      }
      total += dataset.rowCount;
    }
    const view = surveyView(pages, wanted);

    // Variables de la vista cuyos códigos difieren entre ediciones y nadie ha revisado (SDI-50).
    const wantedVariables =
      await this.prisma.harmonizerCanonicalVariable.findMany({
        where: { surveyId, name: { in: wanted } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, reviewedSignature: true },
      });
    const comparisons = await this.variables.variableComparisons(
      surveyId,
      wantedVariables.map((v) => v.id),
    );
    const codeWarnings = wantedVariables.flatMap((v) => {
      const summary = this.variables.comparisonSummary(
        comparisons.get(v.id)?.comparison,
        v.reviewedSignature,
      );
      return summary.status === 'warning'
        ? [{ id: v.id, name: v.name, issueCount: summary.issueCount }]
        : [];
    });

    return {
      survey: { id: survey.id, name: survey.name },
      headers: view.headers,
      rows: view.rows,
      codeWarnings,
      total: view.headers.length > 0 ? total : 0,
      limit: page.limit,
      offset: page.offset,
      availableVariables: available,
      selected,
      selectedCount: view.headers.length,
    };
  }
}
