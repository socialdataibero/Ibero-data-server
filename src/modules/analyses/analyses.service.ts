import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import type { Analysis, Resource } from '@prisma/client';
import { looksLikeParquet } from '../datasets/resources.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { AnalysisService, type NamedSource } from '../analysis/analysis.service.js';
import { stepsToInternal, roundRows, type Recipe, type Step } from '../analysis/recipe.js';
import type { ColumnInfo } from '../analysis/analysis.service.js';
import type { PreviewAnalysisDto } from './dto/preview-analysis.dto.js';
import type { CreateAnalysisDto } from './dto/create-analysis.dto.js';
import type { SaveVizcanvasAnalysisDto } from './dto/save-vizcanvas-analysis.dto.js';

export interface VizcanvasRecipe {
  version: number;
  resultNodeId: string;
  state: Record<string, unknown>;
  tables: { tableName: string; resourceId: string }[];
}

const TABLE_NAME_RE = /^[a-zA-Z0-9_]{1,60}$/;

interface RecipeInputDto {
  resourceId: string;
  steps: Step[];
  roundDecimals?: number;
}

const DEFAULT_SAMPLE = 100;
function referencedColumns(recipe: Recipe): { required: Set<string>; produced: Set<string> } {
  const required = new Set<string>();
  const produced = new Set<string>();

  for (const j of recipe.joins) {
    required.add(j.onLeft);
    required.add(j.onRight);
  }
  for (const c of recipe.computes) {
    for (const operand of [c.left, c.right]) {
      if (typeof operand === 'string' && Number.isNaN(Number(operand.trim()))) {
        required.add(operand);
      }
    }
    produced.add(c.as);
  }
  for (const a of recipe.aggregates) {
    if (a.column !== '*') required.add(a.column);
    produced.add(a.as);
  }
  for (const c of recipe.groupBy) required.add(c);
  for (const f of recipe.filters) required.add(f.column);
  for (const s of recipe.sort) required.add(s.column);

  return { required, produced };
}

@Injectable()
export class AnalysesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly analysisService: AnalysisService,
  ) {}

  private async getResourceForDataset(datasetId: string, resourceId: string) {
    const resource = await this.prisma.resource.findFirst({ where: { id: resourceId, datasetId } });
    if (!resource) {
      throw new NotFoundException({
        code: 'resource_not_found',
        message: 'Resource not found in this dataset.',
      });
    }
    return resource;
  }

  private async resolveJoinSources(
    datasetId: string,
    recipe: Recipe,
  ): Promise<{ sources: NamedSource[]; schemas: (ColumnInfo[] | null)[] }> {
    const sources: NamedSource[] = [];
    const schemas: (ColumnInfo[] | null)[] = [];
    const seenAliases = new Set<string>(['data']);

    for (const join of recipe.joins) {
      if (seenAliases.has(join.alias)) {
        throw new BadRequestException({
          code: 'duplicate_join_alias',
          message: `Duplicate or reserved join alias: "${join.alias}".`,
        });
      }
      seenAliases.add(join.alias);

      const resource = await this.getResourceForDataset(datasetId, join.resourceId);
      sources.push({ alias: join.alias, path: this.storage.resolvePath(resource.storageKey) });
      schemas.push(resource.columns as unknown as ColumnInfo[] | null);
    }
    return { sources, schemas };
  }

  private validateColumns(recipe: Recipe, schemas: (ColumnInfo[] | null)[]) {
    const known = new Set<string>();
    let hasAnySchema = false;
    for (const schema of schemas) {
      if (!schema || schema.length === 0) continue;
      hasAnySchema = true;
      for (const c of schema) known.add(c.name);
    }
    if (!hasAnySchema) {
    return;
    }

    const { required, produced } = referencedColumns(recipe);
    for (const p of produced) known.add(p);

    const missing = [...required].filter((name) => !known.has(name));
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'unknown_columns',
        message: `Unknown column(s) in resources: ${missing.join(', ')}`,
        params: { columns: missing.join(', ') },
      });
    }
  }

  private async prepareRecipe(
    datasetId: string,
    dto: RecipeInputDto,
  ): Promise<{ resource: Resource; recipe: Recipe; joinSources: NamedSource[] }> {
    const resource = await this.getResourceForDataset(datasetId, dto.resourceId);
    const recipe = stepsToInternal(dto.steps);
    recipe.roundDecimals = dto.roundDecimals ?? null;

    const { sources: joinSources, schemas: joinSchemas } = await this.resolveJoinSources(datasetId, recipe);
    this.validateColumns(recipe, [resource.columns as unknown as ColumnInfo[] | null, ...joinSchemas]);

    return { resource, recipe, joinSources };
  }

  private invalidRecipe(message: string): never {
    throw new BadRequestException({ code: 'vizcanvas_recipe_invalid', message });
  }

  private async parseVizcanvasRecipe(datasetId: string, raw: string): Promise<VizcanvasRecipe> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.invalidRecipe('The VizCanvas recipe is not valid JSON.');
    }
    const recipe = parsed as Partial<VizcanvasRecipe>;
    const state = recipe?.state as { dag?: { nodes?: Record<string, Record<string, unknown>>; edges?: unknown } } | undefined;
    if (!state || typeof state !== 'object' || !state.dag?.nodes || typeof state.dag.nodes !== 'object' || !Array.isArray(state.dag.edges)) {
      this.invalidRecipe('The VizCanvas recipe does not contain a canvas.');
    }
    if (typeof recipe.resultNodeId !== 'string' || !(recipe.resultNodeId in state.dag.nodes)) {
      this.invalidRecipe('The VizCanvas recipe does not say which node is the result.');
    }
    const tables = Array.isArray(recipe.tables) ? recipe.tables : [];
    for (const t of tables) {
      if (!t || typeof t.tableName !== 'string' || !TABLE_NAME_RE.test(t.tableName) || typeof t.resourceId !== 'string') {
        this.invalidRecipe('The VizCanvas recipe has an invalid table.');
      }
    }
    const resourceIds = [...new Set(tables.map((t) => t.resourceId))];
    if (resourceIds.length > 0) {
      const found = await this.prisma.resource.count({ where: { id: { in: resourceIds }, datasetId } });
      if (found !== resourceIds.length) {
        this.invalidRecipe('The VizCanvas recipe uses resources that are not part of this dataset.');
      }
    }

    const nodes = Object.fromEntries(
      Object.entries(state.dag.nodes).map(([id, node]) => [
        id,
        { ...node, result: null, status: 'idle', error: undefined },
      ]),
    );
    return {
      version: typeof recipe.version === 'number' ? recipe.version : 1,
      resultNodeId: recipe.resultNodeId,
      state: { ...state, dag: { ...state.dag, nodes } },
      tables: tables.map((t) => ({ tableName: t.tableName, resourceId: t.resourceId })),
    };
  }

  private assertParquet(file: { buffer: Buffer } | undefined): Buffer {
    if (!file?.buffer || !looksLikeParquet(file.buffer)) {
      throw new BadRequestException({
        code: 'invalid_parquet',
        message: 'The VizCanvas result is not a valid Parquet file.',
      });
    }
    return file.buffer;
  }

  private async assertSlugAvailable(slug: string, analysisId?: string) {
    const existing = await this.prisma.analysis.findUnique({ where: { slug } });
    if (existing && existing.id !== analysisId) {
      throw new ConflictException({
        code: 'analysis_slug_taken',
        message: 'An analysis with that slug already exists.',
      });
    }
  }

  private async persistUploadedResult(analysisId: string, buffer: Buffer): Promise<Analysis> {
    try {
      const resultKey = `analyses/${analysisId}.parquet`;
      const resultPath = this.storage.resolvePath(resultKey);
      await this.storage.ensureDir(resultKey);
      await writeFile(resultPath, buffer);

      const resultSchema = await this.analysisService.describeSchema(resultPath);
      const countResult = await this.analysisService.runQuery(resultPath, 'SELECT COUNT(*) AS n FROM data');
      const rowCount = Number((countResult.rows[0] as any)?.n ?? 0);

      return await this.prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: 'DONE',
          resultStorageKey: resultKey,
          resultColumns: resultSchema as unknown as object,
          resultRowCount: rowCount,
          errorMessage: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error while saving the VizCanvas result.';
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: 'FAILED', errorMessage: message },
      });
      throw err;
    }
  }

  async createFromVizcanvas(
    datasetId: string,
    dto: SaveVizcanvasAnalysisDto,
    file: { buffer: Buffer } | undefined,
    userId: string,
  ) {
    const buffer = this.assertParquet(file);
    await this.assertSlugAvailable(dto.slug);
    await this.getResourceForDataset(datasetId, dto.sourceResourceId);
    const recipe = await this.parseVizcanvasRecipe(datasetId, dto.recipe);

    const analysis = await this.prisma.analysis.create({
      data: {
        datasetId,
        sourceResourceId: dto.sourceResourceId,
        title: dto.title,
        slug: dto.slug,
        folder: dto.folder,
        description: dto.description,
        visibility: dto.visibility,
        recipe: [],
        origin: 'VIZCANVAS',
        vizcanvasRecipe: recipe as unknown as object,
        status: 'RUNNING',
        createdById: userId,
      },
    });
    return this.persistUploadedResult(analysis.id, buffer);
  }

  async updateFromVizcanvas(
    datasetId: string,
    analysisId: string,
    dto: SaveVizcanvasAnalysisDto,
    file: { buffer: Buffer } | undefined,
  ) {
    const existing = await this.findOne(datasetId, analysisId);
    if (existing.origin !== 'VIZCANVAS') {
      throw new BadRequestException({
        code: 'analysis_not_from_vizcanvas',
        message: 'This analysis was built with the step builder; save it as a new analysis instead.',
      });
    }
    const buffer = this.assertParquet(file);
    await this.assertSlugAvailable(dto.slug, analysisId);
    await this.getResourceForDataset(datasetId, dto.sourceResourceId);
    const recipe = await this.parseVizcanvasRecipe(datasetId, dto.recipe);

    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: {
        sourceResourceId: dto.sourceResourceId,
        title: dto.title,
        slug: dto.slug,
        folder: dto.folder,
        description: dto.description,
        visibility: dto.visibility,
        vizcanvasRecipe: recipe as unknown as object,
        status: 'RUNNING',
      },
    });
    return this.persistUploadedResult(analysisId, buffer);
  }

  private async writeAndPersist(analysisId: string, resource: Resource, recipe: Recipe, joinSources: NamedSource[]) {
    try {
      const sourcePath = this.storage.resolvePath(resource.storageKey);
      const resultKey = `analyses/${analysisId}.parquet`;
      const resultPath = this.storage.resolvePath(resultKey);
      await this.storage.ensureDir(resultKey);
      await this.analysisService.writeRecipeResult(sourcePath, recipe, resultPath, joinSources);

      const resultSchema = await this.analysisService.describeSchema(resultPath);
      const countResult = await this.analysisService.runQuery(resultPath, 'SELECT COUNT(*) AS n FROM data');
      const rowCount = Number((countResult.rows[0] as any)?.n ?? 0);

      return this.prisma.analysis.update({
        where: { id: analysisId },
        data: {
          status: 'DONE',
          resultStorageKey: resultKey,
          resultColumns: resultSchema as unknown as object,
          resultRowCount: rowCount,
          errorMessage: null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error while generating the analysis.';
      await this.prisma.analysis.update({
        where: { id: analysisId },
        data: { status: 'FAILED', errorMessage: message },
      });
      throw err;
    }
  }

  async preview(datasetId: string, dto: PreviewAnalysisDto) {
    const { resource, recipe, joinSources } = await this.prepareRecipe(datasetId, dto);
    const path = this.storage.resolvePath(resource.storageKey);

    const sample = dto.sampleRows ?? DEFAULT_SAMPLE;
    const result = await this.analysisService.runRecipe(path, recipe, sample, joinSources);
    return {
      columns: result.columns,
      rows: roundRows(result.rows, recipe.roundDecimals),
      rowCount: result.rows.length,
    };
  }

  async create(datasetId: string, dto: CreateAnalysisDto, userId: string) {
    const existingSlug = await this.prisma.analysis.findUnique({ where: { slug: dto.slug } });
    if (existingSlug) {
      throw new ConflictException({
        code: 'analysis_slug_taken',
        message: 'An analysis with that slug already exists.',
      });
    }

    const { resource, recipe, joinSources } = await this.prepareRecipe(datasetId, dto);

    const analysis = await this.prisma.analysis.create({
      data: {
        datasetId,
        sourceResourceId: dto.resourceId,
        title: dto.title,
        slug: dto.slug,
        folder: dto.folder,
        description: dto.description,
        visibility: dto.visibility,
        recipe: dto.steps as unknown as object,
        status: 'RUNNING',
        createdById: userId,
      },
    });

    return this.writeAndPersist(analysis.id, resource, recipe, joinSources);
  }

  async update(datasetId: string, analysisId: string, dto: CreateAnalysisDto) {
    const existing = await this.findOne(datasetId, analysisId);
    if (existing.origin === 'VIZCANVAS') {
      throw new BadRequestException({
        code: 'analysis_from_vizcanvas',
        message: 'This analysis was built in VizCanvas; open it in VizCanvas to edit it.',
      });
    }

    await this.assertSlugAvailable(dto.slug, analysisId);

    const { resource, recipe, joinSources } = await this.prepareRecipe(datasetId, dto);

    await this.prisma.analysis.update({
      where: { id: analysisId },
      data: {
        sourceResourceId: dto.resourceId,
        title: dto.title,
        slug: dto.slug,
        folder: dto.folder,
        description: dto.description,
        visibility: dto.visibility,
        recipe: dto.steps as unknown as object,
        status: 'RUNNING',
      },
    });

    return this.writeAndPersist(analysisId, resource, recipe, joinSources);
  }

  findAll(datasetId: string) {
    return this.prisma.analysis.findMany({ where: { datasetId }, orderBy: { createdAt: 'desc' } });
  }

  async findOne(datasetId: string, analysisId: string) {
    const analysis = await this.prisma.analysis.findFirst({ where: { id: analysisId, datasetId } });
    if (!analysis) {
      throw new NotFoundException({ code: 'analysis_not_found', message: 'Analysis not found.' });
    }
    return analysis;
  }

  async getData(datasetId: string, analysisId: string) {
    const analysis = await this.findOne(datasetId, analysisId);
    if (analysis.status !== 'DONE' || !analysis.resultStorageKey) {
      throw new BadRequestException({
        code: 'analysis_result_not_ready',
        message: 'This analysis does not have a result ready yet.',
      });
    }
    const path = this.storage.resolvePath(analysis.resultStorageKey);
    return this.analysisService.runQuery(path, 'SELECT * FROM data LIMIT 1000');
  }

  async remove(datasetId: string, analysisId: string): Promise<void> {
    const analysis = await this.findOne(datasetId, analysisId);
    await this.prisma.analysis.delete({ where: { id: analysisId } });
    if (analysis.resultStorageKey) {
      await this.storage.remove(analysis.resultStorageKey);
    }
  }
}
