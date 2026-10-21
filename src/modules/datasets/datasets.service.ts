import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatasetVisibility, type Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import type { CreateDatasetDto } from './dto/create-dataset.dto.js';

export type DatasetSort = 'recent' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';

export interface ListDatasetsParams {
  /** Main free-text search (title, description, tags, sourceOrg, year, organization name). */
  q?: string;
  /**
   * Extra free-text terms, each ANDed with the rest (used by the filter panel: every
   * selected option becomes one more term that must match somewhere on the dataset).
   */
  terms?: string[];
  sort?: DatasetSort;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

@Injectable()
export class DatasetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
  ) {}

  private orderBy(sort?: DatasetSort): Prisma.DatasetOrderByWithRelationInput {
    switch (sort) {
      case 'title-asc':
        return { title: 'asc' };
      case 'title-desc':
        return { title: 'desc' };
      case 'year-desc':
        return { year: 'desc' };
      case 'year-asc':
        return { year: 'asc' };
      case 'recent':
      default:
        return { updatedAt: 'desc' };
    }
  }

  private termWhere(term: string): Prisma.DatasetWhereInput {
    const t = term.trim();
    const yearNum = Number(t);
    return {
      OR: [
        { title: { contains: t, mode: 'insensitive' } },
        { description: { contains: t, mode: 'insensitive' } },
        { sourceOrg: { contains: t, mode: 'insensitive' } },
        { tags: { has: t } },
        ...(Number.isFinite(yearNum) ? [{ year: yearNum }] : []),
        { organization: { name: { contains: t, mode: 'insensitive' as const } } },
      ],
    };
  }

  /** Who may see a dataset in a list (SDI-87): PUBLIC ones, plus PRIVATE ones of the viewer's organizations. */
  private visibleTo(viewer: AuthenticatedUser): Prisma.DatasetWhereInput[] {
    if (viewer.isSysadmin) return [];
    return [
      {
        OR: [
          { visibility: DatasetVisibility.PUBLIC },
          { organization: { members: { some: { userId: viewer.id } } } },
        ],
      },
    ];
  }

  private buildWhere(
    organizationId: string | undefined,
    viewer: AuthenticatedUser,
    params: ListDatasetsParams,
  ): Prisma.DatasetWhereInput {
    const q = (params.q ?? '').trim();
    const terms = (params.terms ?? []).map((t) => t.trim()).filter(Boolean);
    const and: Prisma.DatasetWhereInput[] = [
      ...(organizationId ? [{ organizationId }] : []),
      ...this.visibleTo(viewer),
      ...(q ? [this.termWhere(q)] : []),
      ...terms.map((t) => this.termWhere(t)),
    ];
    return and.length ? { AND: and } : {};
  }

  private async listDatasets(organizationId: string | undefined, viewer: AuthenticatedUser, params: ListDatasetsParams) {
    const where = this.buildWhere(organizationId, viewer, params);
    const limit = clampLimit(params.limit);
    const offset = Math.max(params.offset ?? 0, 0);

    const [total, items] = await Promise.all([
      this.prisma.dataset.count({ where }),
      this.prisma.dataset.findMany({
        where,
        orderBy: this.orderBy(params.sort),
        take: limit,
        skip: offset,
        include: { organization: { select: { id: true, name: true, slug: true } } },
      }),
    ]);

    return { total, items };
  }

  findAllByOrganization(organizationId: string, viewer: AuthenticatedUser, params: ListDatasetsParams = {}) {
    return this.listDatasets(organizationId, viewer, params);
  }

  findAllGlobal(viewer: AuthenticatedUser, params: ListDatasetsParams = {}) {
    return this.listDatasets(undefined, viewer, params);
  }

  async findOne(organizationId: string, datasetId: string) {
    const dataset = await this.prisma.dataset.findFirst({
      where: { id: datasetId, organizationId },
      include: {
        resources: true,
        revisionOf: { select: { id: true, title: true, slug: true, revision: true } },
        revisions: { select: { id: true, title: true, slug: true, revision: true } },
        supersededBy: { select: { id: true, title: true, slug: true, revision: true } },
      },
    });
    if (!dataset) {
      throw new NotFoundException({ code: 'dataset_not_found', message: 'Dataset not found.' });
    }
    return dataset;
  }

  async create(organizationId: string, dto: CreateDatasetDto, ownerId: string) {
    const { revisionOfId, changelog, ...rest } = dto;

    let revision = 1;
    if (revisionOfId) {
      const original = await this.prisma.dataset.findFirst({
        where: { id: revisionOfId, organizationId },
      });
      if (!original) {
        throw new BadRequestException({
          code: 'revision_source_not_found',
          message: 'The original dataset for this revision does not exist in this organization.',
        });
      }
      if (original.supersededById) {
        throw new BadRequestException({
          code: 'dataset_already_superseded',
          message: 'That dataset already has a more recent revision.',
        });
      }
      revision = original.revision + 1;
    }

    const created = await this.prisma.dataset.create({
      data: { ...rest, organizationId, ownerId, revision, revisionOfId, changelog },
    });

    if (revisionOfId) {
      await this.prisma.dataset.update({
        where: { id: revisionOfId },
        data: { supersededById: created.id },
      });
    }

    return created;
  }

  async remove(organizationId: string, datasetId: string): Promise<void> {
    const dataset = await this.findOne(organizationId, datasetId);

    await this.prisma.dataset.updateMany({ where: { revisionOfId: datasetId }, data: { revisionOfId: null } });
    await this.prisma.dataset.updateMany({ where: { supersededById: datasetId }, data: { supersededById: null } });

    const analyses = await this.prisma.analysis.findMany({ where: { datasetId }, select: { resultStorageKey: true } });

    await this.prisma.dataset.delete({ where: { id: dataset.id } });

    await Promise.all([
      this.storage.removeDir(datasetId),
      ...analyses.filter((a) => a.resultStorageKey).map((a) => this.storage.remove(a.resultStorageKey!)),
    ]);
  }
}
