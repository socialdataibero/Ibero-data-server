import { Injectable, NotFoundException } from '@nestjs/common';
import { DatasetVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { AnalysisService, type QueryResult } from '../analysis/analysis.service.js';
import { stepsToInternal, toVizCanvasRecipe, type Step } from '../analysis/recipe.js';
import { HandoffService } from '../handoff/handoff.service.js';
import type { VizcanvasRecipe } from '../analyses/analyses.service.js';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const DEFAULT_PREVIEW = 500;
const MAX_PREVIEW = 500;

export interface PublicPackage {
  id: string;
  title: string;
  name: string;
  type: 'analysis';
  organization: { id: string; name: string; title: string };
  notes: string | null;
  metadata_created: string;
  metadata_modified: string;
}

export interface PublicResource {
  id: string;
  name: string;
  datastore_active: boolean;
  parquet_schema: unknown;
}

export interface PublicRecipe {
  sourceResourceName: string | null;
  steps: { op: string; params?: Record<string, unknown> }[];
  joinResourceNames: Record<string, string>;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(Math.max(n, min), max);
}

// A finished analysis is public only if both it and its dataset are public (SDI-98).
const PUBLIC_DONE_ANALYSIS = {
  status: 'DONE' as const,
  visibility: DatasetVisibility.PUBLIC,
  dataset: { visibility: DatasetVisibility.PUBLIC },
};

const PUBLIC_VISITOR: AuthenticatedUser = {
  id: 'public',
  email: 'visitor@public.ibero-data',
  fullName: 'Public visitor',
  isSysadmin: false,
};

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly analysisService: AnalysisService,
    private readonly handoffService: HandoffService,
  ) {}

  private toPackage(analysis: {
    id: string;
    title: string;
    slug: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    dataset: { organization: { id: string; slug: string; name: string } };
  }): PublicPackage {
    return {
      id: analysis.id,
      title: analysis.title,
      name: analysis.slug,
      type: 'analysis',
      organization: {
        id: analysis.dataset.organization.id,
        name: analysis.dataset.organization.slug,
        title: analysis.dataset.organization.name,
      },
      notes: analysis.description,
      metadata_created: analysis.createdAt.toISOString(),
      metadata_modified: analysis.updatedAt.toISOString(),
    };
  }

  private catalogOrderBy(sort?: string) {
    switch (sort) {
      case 'title-asc':
        return { title: 'asc' as const };
      case 'title-desc':
        return { title: 'desc' as const };
      case 'recent':
      default:
        return { updatedAt: 'desc' as const };
    }
  }

  async search(params: { q?: string; org?: string; sort?: string; limit?: number; offset?: number }): Promise<{ total: number; items: PublicPackage[] }> {
    const q = (params.q ?? '').trim();
    const org = (params.org ?? '').trim();
    const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const where = {
      status: PUBLIC_DONE_ANALYSIS.status,
      visibility: PUBLIC_DONE_ANALYSIS.visibility,
      dataset: {
        visibility: PUBLIC_DONE_ANALYSIS.dataset.visibility,
        ...(org ? { organization: { slug: org } } : {}),
      },
      ...(q
        ? { OR: [{ title: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] }
        : {}),
    };

    const [total, analyses] = await Promise.all([
      this.prisma.analysis.count({ where }),
      this.prisma.analysis.findMany({
        where,
        include: { dataset: { include: { organization: true } } },
        orderBy: this.catalogOrderBy(params.sort),
        take: limit,
        skip: offset,
      }),
    ]);

    return { total, items: analyses.map((a) => this.toPackage(a)) };
  }

  async getPackageBySlug(slug: string): Promise<{ pkg: PublicPackage; resources: PublicResource[]; recipe: PublicRecipe }> {
    const analysis = await this.prisma.analysis.findFirst({
      where: { slug, ...PUBLIC_DONE_ANALYSIS },
      include: { dataset: { include: { organization: true } }, sourceResource: true },
    });
    if (!analysis) {
      throw new NotFoundException({
        code: 'public_analysis_not_found',
        message: 'That analysis was not found in the public catalog.',
      });
    }

    const resources: PublicResource[] = [
      { id: analysis.slug, name: analysis.title, datastore_active: false, parquet_schema: analysis.resultColumns ?? [] },
    ];
    const recipe = await this.describeRecipe(analysis);
    return { pkg: this.toPackage(analysis), resources, recipe };
  }

  private async describeRecipe(analysis: {
    datasetId: string;
    recipe: unknown;
    sourceResource: { filename: string } | null;
  }): Promise<PublicRecipe> {
    const steps = Array.isArray(analysis.recipe) ? (analysis.recipe as { op: string; params?: Record<string, unknown> }[]) : [];
    const joinResourceIds = steps
      .filter((s) => s.op === 'join' && typeof s.params?.resourceId === 'string')
      .map((s) => s.params!.resourceId as string);

    let joinResourceNames: Record<string, string> = {};
    if (joinResourceIds.length > 0) {
      const joined = await this.prisma.resource.findMany({
        where: { id: { in: joinResourceIds }, datasetId: analysis.datasetId },
        select: { id: true, filename: true },
      });
      joinResourceNames = Object.fromEntries(joined.map((r) => [r.id, r.filename]));
    }

    return { sourceResourceName: analysis.sourceResource?.filename ?? null, steps, joinResourceNames };
  }

  async previewBySlug(slug: string, limit?: number): Promise<QueryResult> {
    const safeLimit = clampInt(limit, DEFAULT_PREVIEW, 1, MAX_PREVIEW);
    const analysis = await this.prisma.analysis.findFirst({ where: { slug, ...PUBLIC_DONE_ANALYSIS } });
    if (!analysis?.resultStorageKey) {
      throw new NotFoundException({
        code: 'public_analysis_not_found',
        message: 'Analysis not found or not public.',
      });
    }
    const path = this.storage.resolvePath(analysis.resultStorageKey);
    return this.analysisService.runQuery(path, `SELECT * FROM data LIMIT ${safeLimit}`);
  }

  async getResultFile(slug: string): Promise<{ path: string; filename: string }> {
    const analysis = await this.prisma.analysis.findFirst({ where: { slug, ...PUBLIC_DONE_ANALYSIS } });
    if (!analysis?.resultStorageKey) {
      throw new NotFoundException({
        code: 'public_analysis_not_found',
        message: 'Analysis not found or not public.',
      });
    }
    return { path: this.storage.resolvePath(analysis.resultStorageKey), filename: `${analysis.title}.parquet` };
  }

  async getDatasetResourceFile(slug: string, resourceId: string): Promise<{ path: string; filename: string }> {
    const analysis = await this.prisma.analysis.findFirst({ where: { slug, ...PUBLIC_DONE_ANALYSIS } });
    if (!analysis) {
      throw new NotFoundException({
        code: 'public_analysis_not_found',
        message: 'Analysis not found or not public.',
      });
    }
    const resource = await this.prisma.resource.findFirst({ where: { id: resourceId, datasetId: analysis.datasetId } });
    if (!resource) {
      throw new NotFoundException({
        code: 'resource_not_found',
        message: 'Resource not found in this dataset.',
      });
    }
    return { path: this.storage.resolvePath(resource.storageKey), filename: resource.filename };
  }

  async buildVizCanvasHandoff(slug: string): Promise<{ url: string }> {
    const analysis = await this.prisma.analysis.findFirst({
      where: { slug, ...PUBLIC_DONE_ANALYSIS },
      include: { sourceResource: true },
    });
    if (!analysis?.sourceResource) {
      throw new NotFoundException({
        code: 'public_analysis_not_found',
        message: 'Analysis not found or not public.',
      });
    }

    const base = this.handoffService.apiBaseUrl();

    if (analysis.origin === 'VIZCANVAS' && analysis.vizcanvasRecipe) {
      const canvas = analysis.vizcanvasRecipe as unknown as VizcanvasRecipe;
      const url = this.handoffService.buildCanvasHandoffUrl(PUBLIC_VISITOR, {
        state: canvas.state,
        tables: canvas.tables.map((t) => ({
          ...t,
          downloadUrl: `${base}/public/catalog/${analysis.slug}/resources/${t.resourceId}/download`,
        })),
      });
      return { url };
    }

    const steps = Array.isArray(analysis.recipe) ? (analysis.recipe as unknown as Step[]) : [];
    const recipe = stepsToInternal(steps);
    const vizCanvasRecipe = toVizCanvasRecipe(recipe);

    const resultDownloadUrl = `${base}/public/catalog/${analysis.slug}/download`;
    const sourceDownloadUrl = `${base}/public/catalog/${analysis.slug}/resources/${analysis.sourceResource.id}/download`;

    const joinResourceIds = recipe.joins.map((j) => j.resourceId);
    const joinResources: { alias: string; downloadUrl: string; filename: string }[] = [];
    if (joinResourceIds.length > 0) {
      const joined = await this.prisma.resource.findMany({
        where: { id: { in: joinResourceIds }, datasetId: analysis.datasetId },
      });
      const filenameById = new Map(joined.map((r) => [r.id, r.filename]));
      for (const j of recipe.joins) {
        const filename = filenameById.get(j.resourceId);
        if (!filename) continue;
        joinResources.push({
          alias: j.alias,
          downloadUrl: `${base}/public/catalog/${analysis.slug}/resources/${j.resourceId}/download`,
          filename,
        });
      }
    }

    const url = this.handoffService.buildAnalysisHandoffUrl(
      PUBLIC_VISITOR,
      { downloadUrl: resultDownloadUrl, filename: `${analysis.title}.parquet` },
      { downloadUrl: sourceDownloadUrl, filename: analysis.sourceResource.filename },
      vizCanvasRecipe,
      joinResources,
    );
    return { url };
  }

  async listOrganizations(params: { q?: string; sort?: string; limit?: number; offset?: number } = {}): Promise<{
    total: number;
    items: { id: string; name: string; title: string; description: string | null }[];
  }> {
    const q = (params.q ?? '').trim();
    const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const where = {
      datasets: { some: { visibility: DatasetVisibility.PUBLIC, analyses: { some: { status: 'DONE' as const, visibility: DatasetVisibility.PUBLIC } } } },
      ...(q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] }
        : {}),
    };
    const orderBy = params.sort === 'name-desc' ? ({ name: 'desc' } as const) : ({ name: 'asc' } as const);

    const [total, orgs] = await Promise.all([
      this.prisma.organization.count({ where }),
      this.prisma.organization.findMany({ where, orderBy, take: limit, skip: offset }),
    ]);

    return {
      total,
      items: orgs.map((o) => ({ id: o.id, name: o.slug, title: o.name, description: o.description })),
    };
  }

  async countByOrganization(): Promise<Record<string, { sources: number; charts: number }>> {
    const rows = await this.prisma.analysis.findMany({
      where: PUBLIC_DONE_ANALYSIS,
      select: { datasetId: true, dataset: { select: { organization: { select: { slug: true } } } } },
    });

    const charts = new Map<string, number>();
    const datasetsByOrg = new Map<string, Set<string>>();
    for (const r of rows) {
      const slug = r.dataset.organization.slug;
      charts.set(slug, (charts.get(slug) ?? 0) + 1);
      if (!datasetsByOrg.has(slug)) datasetsByOrg.set(slug, new Set());
      datasetsByOrg.get(slug)!.add(r.datasetId);
    }

    const out: Record<string, { sources: number; charts: number }> = {};
    for (const slug of charts.keys()) {
      out[slug] = { sources: datasetsByOrg.get(slug)?.size ?? 0, charts: charts.get(slug) ?? 0 };
    }
    return out;
  }
}
