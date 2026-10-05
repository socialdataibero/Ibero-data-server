import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { asciiFold, matchByName, parseVariables } from './matching.js';
import {
  buildDatasetView,
  buildSurveyView,
  type DatasetEdition,
  type HarmonizedView,
  type RawData,
} from './harmonized-view.js';
import { NEW_SURVEY, type UploadDatasetDto } from './dto/upload-dataset.dto.js';
import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from './dto/mapping-choice.dto.js';
import type { CreateSurveyDto } from './dto/create-survey.dto.js';
import type { UpdateSurveyDto } from './dto/update-survey.dto.js';
import type { SaveMappingDto } from './dto/save-mapping.dto.js';

export interface SurveyDatasetSummary {
  id: string;
  name: string;
  year: number;
  rowCount: number;
  mappedColumns: number;
  totalColumns: number;
}

export interface SurveySummary {
  id: string;
  name: string;
  description: string | null;
  datasets: SurveyDatasetSummary[];
}

export interface ListSurveysParams {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

export interface DatasetInfo {
  id: string;
  name: string;
  year: number;
  surveyId: string;
  surveyName: string;
}

export type SuggestionSource = 'history' | 'name';

export interface MappingColumn {
  name: string;
  selectedCanonicalId: string | null;
  suggested: string | null;
  suggestionSource: SuggestionSource | null;
}

export type ExportFormat = 'csv' | 'parquet';

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

const RAW_ROW_BATCH = 1_000;
const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
};

function isExportFormat(fmt: string): fmt is ExportFormat {
  return fmt === 'csv' || fmt === 'parquet';
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h}.${count}`;
  });
}

// Un archivo que no es UTF-8 (p. ej. Latin-1) se decodificaría con U+FFFD en
// lugar de cada carácter acentuado, y el byte original se perdería para siempre.
function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const lossy = new TextDecoder('utf-8').decode(buffer);
    const line = lossy.slice(0, lossy.indexOf('\uFFFD')).split('\n').length;
    throw new BadRequestException({
      code: 'csv_not_utf8',
      message: `El archivo no está codificado en UTF-8 (primer byte inválido en la línea ${line}). Vuelve a guardarlo como UTF-8 y súbelo de nuevo.`,
    });
  }
}

@Injectable()
export class HarmonizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
  ) {}

  async listSurveys(
    params: ListSurveysParams = {},
  ): Promise<{ total: number; items: SurveySummary[] }> {
    const limit = clampLimit(params.limit);
    const offset = Math.max(params.offset ?? 0, 0);
    const [total, surveys] = await Promise.all([
      this.prisma.harmonizerSurvey.count(),
      this.prisma.harmonizerSurvey.findMany({
        orderBy: { name: 'asc' },
        take: limit,
        skip: offset,
        include: {
          datasets: {
            orderBy: [{ year: 'asc' }, { createdAt: 'asc' }],
            include: { _count: { select: { mappings: true } } },
          },
        },
      }),
    ]);
    const items = surveys.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      datasets: s.datasets.map((d) => ({
        id: d.id,
        name: d.name,
        year: d.year,
        rowCount: d.rowCount,
        mappedColumns: d._count.mappings,
        totalColumns: d.columns.length,
      })),
    }));
    return { total, items };
  }

  async createSurvey(dto: CreateSurveyDto) {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException({
        code: 'survey_name_required',
        message: 'Survey name cannot be empty.',
      });
    }
    const existing = await this.prisma.harmonizerSurvey.findUnique({
      where: { name },
    });
    if (existing) {
      throw new ConflictException({
        code: 'survey_name_taken',
        message: 'A survey with that name already exists.',
      });
    }
    const created = await this.prisma.harmonizerSurvey.create({
      data: { name, description: dto.description?.trim() || null },
    });
    return this.toSurveyDto(created);
  }

  async getSurvey(surveyId: string) {
    const survey = await this.prisma.harmonizerSurvey.findUnique({
      where: { id: surveyId },
    });
    if (!survey) {
      throw new NotFoundException({
        code: 'survey_not_found',
        message: 'Survey not found.',
      });
    }
    return survey;
  }

  async removeSurvey(surveyId: string): Promise<void> {
    await this.getSurvey(surveyId);
    // Las ediciones, sus filas, los mapeos y las canónicas se borran en cascada.
    await this.prisma.harmonizerSurvey.delete({ where: { id: surveyId } });
  }

  async updateSurvey(surveyId: string, dto: UpdateSurveyDto) {
    const survey = await this.getSurvey(surveyId);
    const data: Prisma.HarmonizerSurveyUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException({
          code: 'survey_name_required',
          message: 'Survey name cannot be empty.',
        });
      }
      if (name !== survey.name) {
        const existing = await this.prisma.harmonizerSurvey.findUnique({
          where: { name },
        });
        if (existing) {
          throw new ConflictException({
            code: 'survey_name_taken',
            message: 'A survey with that name already exists.',
          });
        }
        data.name = name;
      }
    }

    if (dto.description !== undefined) {
      data.description = dto.description.trim() || null;
    }

    const updated = await this.prisma.harmonizerSurvey.update({
      where: { id: surveyId },
      data,
    });
    return this.toSurveyDto(updated);
  }

  toSurveyDto(survey: {
    id: string;
    name: string;
    description: string | null;
  }) {
    return {
      id: survey.id,
      name: survey.name,
      description: survey.description,
    };
  }

  async uploadDataset(
    dto: UploadDatasetDto,
    file: { originalname: string; buffer: Buffer },
  ): Promise<{ datasetId: string; dataset: DatasetInfo }> {
    // Se valida el archivo antes de crear la encuesta nueva (`__new__`), para
    // que un archivo rechazado no deje una encuesta vacía.
    const { columns, rows } = this.parseCsv(file.buffer);
    const survey = await this.resolveSurveyForUpload(dto);

    const dataset = await this.prisma.$transaction(async (tx) => {
      const created = await tx.harmonizerDataset.create({
        data: {
          surveyId: survey.id,
          name: dto.name.trim(),
          year: dto.year,
          columns,
          rowCount: rows.length,
        },
      });
      for (let offset = 0; offset < rows.length; offset += RAW_ROW_BATCH) {
        const batch = rows
          .slice(offset, offset + RAW_ROW_BATCH)
          .map((data, i) => ({
            datasetId: created.id,
            rowIndex: offset + i,
            data: data as Prisma.InputJsonObject,
          }));
        await tx.harmonizerRawRow.createMany({ data: batch });
      }
      return created;
    });

    return {
      datasetId: dataset.id,
      dataset: {
        id: dataset.id,
        name: dataset.name,
        year: dataset.year,
        surveyId: survey.id,
        surveyName: survey.name,
      },
    };
  }

  private async resolveSurveyForUpload(dto: UploadDatasetDto) {
    if (dto.surveyId !== NEW_SURVEY) {
      return this.getSurvey(dto.surveyId);
    }
    const name = dto.newSurvey?.trim() ?? '';
    if (!name) {
      throw new BadRequestException({
        code: 'new_survey_name_required',
        message: 'Provide the name of the new survey in "newSurvey".',
      });
    }
    return this.createSurvey({ name });
  }

  private parseCsv(buffer: Buffer): { columns: string[]; rows: RawData[] } {
    const text = decodeUtf8(buffer);
    let columns: string[] = [];
    let rows: RawData[];
    try {
      rows = parse(text, {
        bom: true,
        columns: (header: string[]) => {
          columns = dedupeHeaders(header);
          return columns;
        },
        skip_empty_lines: true,
        trim: false,
        cast: false,
      }) as RawData[];
    } catch (err) {
      throw new BadRequestException({
        code: 'csv_invalid',
        message: `Invalid CSV: ${err instanceof Error ? err.message : 'could not parse the file.'}`,
      });
    }
    return { columns, rows };
  }

  async getDataset(datasetId: string) {
    const dataset = await this.prisma.harmonizerDataset.findUnique({
      where: { id: datasetId },
      include: { survey: true },
    });
    if (!dataset) {
      throw new NotFoundException({
        code: 'harmonizer_dataset_not_found',
        message: 'Dataset not found.',
      });
    }
    return dataset;
  }

  private toDatasetInfo(dataset: {
    id: string;
    name: string;
    year: number;
    surveyId: string;
    survey: { name: string };
  }): DatasetInfo {
    return {
      id: dataset.id,
      name: dataset.name,
      year: dataset.year,
      surveyId: dataset.surveyId,
      surveyName: dataset.survey.name,
    };
  }

  async getMapping(datasetId: string): Promise<{
    dataset: DatasetInfo;
    columns: MappingColumn[];
    canonicalVariables: { id: string; name: string }[];
  }> {
    const dataset = await this.getDataset(datasetId);

    const [canonicals, saved, historical] = await Promise.all([
      this.prisma.harmonizerCanonicalVariable.findMany({
        where: { surveyId: dataset.surveyId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.harmonizerMapping.findMany({ where: { datasetId } }),
      this.prisma.harmonizerMapping.findMany({
        where: {
          datasetId: { not: datasetId },
          sourceColumn: { in: dataset.columns },
          dataset: { surveyId: dataset.surveyId },
        },
      }),
    ]);

    const nameById = new Map(canonicals.map((c) => [c.id, c.name]));
    const savedByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.canonicalVariableId]),
    );
    const historicalByColumn = new Map<string, string>();
    for (const m of historical) {
      if (!historicalByColumn.has(m.sourceColumn))
        historicalByColumn.set(m.sourceColumn, m.canonicalVariableId);
    }

    // Una canónica ya asignada (o ya sugerida) a otra columna de este archivo
    // no se vuelve a sugerir: dos columnas a la misma canónica colisionan.
    const usedIds = new Set(savedByColumn.values());

    const columns = dataset.columns.map((name): MappingColumn => {
      const savedId = savedByColumn.get(name);
      if (savedId) {
        return {
          name,
          selectedCanonicalId: savedId,
          suggested: null,
          suggestionSource: null,
        };
      }
      const historicalId = historicalByColumn.get(name);
      if (historicalId && !usedIds.has(historicalId)) {
        usedIds.add(historicalId);
        return {
          name,
          selectedCanonicalId: historicalId,
          suggested: nameById.get(historicalId) ?? null,
          suggestionSource: 'history',
        };
      }
      const matchedId = matchByName(
        name,
        canonicals.filter((c) => !usedIds.has(c.id)),
      );
      if (matchedId) {
        usedIds.add(matchedId);
        return {
          name,
          selectedCanonicalId: matchedId,
          suggested: nameById.get(matchedId) ?? null,
          suggestionSource: 'name',
        };
      }
      return {
        name,
        selectedCanonicalId: null,
        suggested: null,
        suggestionSource: null,
      };
    });

    return {
      dataset: this.toDatasetInfo(dataset),
      columns,
      canonicalVariables: canonicals,
    };
  }

  async saveMapping(
    datasetId: string,
    dto: SaveMappingDto,
  ): Promise<{ ok: true; datasetId: string }> {
    const dataset = await this.getDataset(datasetId);
    const choiceByColumn = new Map(dto.columns.map((c) => [c.column, c]));

    await this.prisma.$transaction(async (tx) => {
      const resolved: { column: string; canonicalId: string | null }[] = [];
      const columnsByCanonical = new Map<string, string[]>();
      for (const column of dataset.columns) {
        const canonicalId = await this.resolveCanonicalChoice(
          tx,
          dataset.surveyId,
          choiceByColumn.get(column),
        );
        resolved.push({ column, canonicalId });
        if (canonicalId !== null) {
          const columns = columnsByCanonical.get(canonicalId) ?? [];
          columns.push(column);
          columnsByCanonical.set(canonicalId, columns);
        }
      }

      // La vista armonizada tiene una sola columna por canónica: si dos
      // columnas del archivo apuntan a la misma, una sobrescribiría a la otra.
      const collisions = [...columnsByCanonical.values()].filter(
        (columns) => columns.length > 1,
      );
      if (collisions.length > 0) {
        throw new ConflictException({
          code: 'canonical_variable_collision',
          message: `Each canonical variable can be mapped from only one column per dataset. Columns sharing a canonical variable: ${collisions
            .map((columns) => columns.join(', '))
            .join('; ')}.`,
        });
      }

      for (const { column, canonicalId } of resolved) {
        const existing = await tx.harmonizerMapping.findUnique({
          where: {
            datasetId_sourceColumn: { datasetId, sourceColumn: column },
          },
        });

        if (canonicalId === null) {
          if (existing)
            await tx.harmonizerMapping.delete({ where: { id: existing.id } });
        } else if (existing) {
          if (existing.canonicalVariableId !== canonicalId) {
            await tx.harmonizerMapping.update({
              where: { id: existing.id },
              data: { canonicalVariableId: canonicalId },
            });
          }
        } else {
          await tx.harmonizerMapping.create({
            data: {
              datasetId,
              sourceColumn: column,
              canonicalVariableId: canonicalId,
            },
          });
        }
      }
    });

    return { ok: true, datasetId };
  }

  private async resolveCanonicalChoice(
    tx: Prisma.TransactionClient,
    surveyId: string,
    choice: MappingChoiceDto | undefined,
  ): Promise<string | null> {
    if (!choice) return null;

    if (choice.choice === NEW_CANONICAL) {
      const name = choice.newName?.trim() ?? '';
      if (!name) return null;
      const existing = await tx.harmonizerCanonicalVariable.findUnique({
        where: { surveyId_name: { surveyId, name } },
      });
      if (existing) return existing.id;
      const created = await tx.harmonizerCanonicalVariable.create({
        data: {
          surveyId,
          name,
          dataType: choice.newDataType?.trim() || 'text',
        },
      });
      return created.id;
    }

    if (choice.choice.startsWith(CANONICAL_PREFIX)) {
      const id = choice.choice.slice(CANONICAL_PREFIX.length);
      const canonical = await tx.harmonizerCanonicalVariable.findFirst({
        where: { id, surveyId },
      });
      if (!canonical) {
        throw new BadRequestException({
          code: 'canonical_variable_not_found',
          message: `Canonical variable "${id}" does not belong to this survey.`,
        });
      }
      return canonical.id;
    }

    return null;
  }

  private async loadEdition(dataset: {
    id: string;
    name: string;
    year: number;
    columns: string[];
  }): Promise<DatasetEdition> {
    const [mappings, rawRows] = await Promise.all([
      this.prisma.harmonizerMapping.findMany({
        where: { datasetId: dataset.id },
        include: { canonicalVariable: { select: { name: true } } },
      }),
      this.prisma.harmonizerRawRow.findMany({
        where: { datasetId: dataset.id },
        orderBy: { rowIndex: 'asc' },
        select: { data: true },
      }),
    ]);
    return {
      name: dataset.name,
      year: dataset.year,
      columns: dataset.columns,
      columnToCanonical: new Map(
        mappings.map((m) => [m.sourceColumn, m.canonicalVariable.name]),
      ),
      rows: rawRows.map((r) => r.data as RawData),
    };
  }

  async getDatasetHarmonized(datasetId: string) {
    const dataset = await this.getDataset(datasetId);
    const view = buildDatasetView(await this.loadEdition(dataset));
    return {
      dataset: this.toDatasetInfo(dataset),
      headers: view.headers,
      rows: view.rows,
      availableVariables: view.headers,
      selectedCount: view.headers.length,
    };
  }

  private async availableVariables(surveyId: string): Promise<string[]> {
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, mappings: { some: {} } },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return canonicals.map((c) => c.name);
  }

  private async surveyView(
    surveyId: string,
    variables: string | string[] | undefined,
  ) {
    const survey = await this.getSurvey(surveyId);
    const available = await this.availableVariables(surveyId);
    const selected = parseVariables(variables);
    const wanted = selected.length > 0 ? selected : available;

    const datasets = await this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const editions: DatasetEdition[] = [];
    for (const dataset of datasets) {
      editions.push(await this.loadEdition(dataset));
    }

    return {
      survey,
      available,
      selected,
      view: buildSurveyView(editions, wanted),
    };
  }

  async getSurveyHarmonized(
    surveyId: string,
    variables: string | string[] | undefined,
  ) {
    const { survey, available, selected, view } = await this.surveyView(
      surveyId,
      variables,
    );
    return {
      survey: { id: survey.id, name: survey.name },
      headers: view.headers,
      rows: view.rows,
      availableVariables: available,
      selected,
      selectedCount: view.headers.length,
    };
  }

  async exportDataset(datasetId: string, fmt: string): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const dataset = await this.getDataset(datasetId);
    const view = buildDatasetView(await this.loadEdition(dataset));
    return this.exportView(
      `harmonized_${dataset.name}_${dataset.year}`,
      view.headers,
      view,
      format,
    );
  }

  async exportSurvey(
    surveyId: string,
    fmt: string,
    variables: string | string[] | undefined,
  ): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const { survey, view } = await this.surveyView(surveyId, variables);
    return this.exportView(
      `harmonized_${survey.name}`,
      ['_dataset', '_year', ...view.headers],
      view,
      format,
    );
  }

  private assertExportFormat(fmt: string): ExportFormat {
    const format = fmt.toLowerCase();
    if (!isExportFormat(format)) {
      throw new NotFoundException({
        code: 'export_format_not_supported',
        message: `Export format not supported: ${fmt}. Use "csv" or "parquet".`,
      });
    }
    return format;
  }

  private async exportView(
    baseName: string,
    columns: string[],
    view: HarmonizedView,
    format: ExportFormat,
  ): Promise<ExportFile> {
    const safeBase =
      asciiFold(baseName)
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_.-]/g, '') || 'harmonized';
    const filename = `${safeBase}.${format}`;
    const contentType = EXPORT_CONTENT_TYPE[format];

    if (format === 'csv') {
      const csv = stringify(view.rows, {
        header: true,
        columns,
        cast: { number: (n) => String(n) },
      });
      return {
        filename,
        contentType,
        body: Buffer.from(`\ufeff${csv}`, 'utf8'),
      };
    }

    if (columns.length === 0) {
      throw new BadRequestException({
        code: 'harmonized_view_empty',
        message: 'There are no mapped variables to export as Parquet.',
      });
    }
    const tmpPath = join(tmpdir(), `ibero-harmonized-${randomUUID()}.parquet`);
    try {
      await this.analysisService.writeRowsToParquet(
        columns,
        view.rows,
        tmpPath,
      );
      return { filename, contentType, body: await readFile(tmpPath) };
    } finally {
      await rm(tmpPath, { force: true });
    }
  }
}
