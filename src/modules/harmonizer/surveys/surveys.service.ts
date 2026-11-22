import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import type { CreateSurveyDto } from '../dto/create-survey.dto.js';
import type { UpdateSurveyDto } from '../dto/update-survey.dto.js';
import { EditionFilesService } from '../editions/edition-files.service.js';
import type { ListSurveysParams, SurveySummary } from '../harmonizer-types.js';
import { HarmonizerLookupService } from '../lookup.service.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** Surveys: list, create, rename and describe, delete with everything in them. */
@Injectable()
export class SurveysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly lookup: HarmonizerLookupService,
    private readonly files: EditionFilesService,
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
      organizationId: s.organizationId,
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

  async createSurvey(dto: CreateSurveyDto, createdById: string) {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException({
        code: 'survey_name_required',
        message: 'The survey name cannot be empty.',
      });
    }
    const existing = await this.prisma.harmonizerSurvey.findUnique({
      where: { name },
    });
    if (existing) {
      throw new ConflictException({
        code: 'survey_name_taken',
        message: `A survey named "${name}" already exists.`,
        params: { name },
      });
    }
    const created = await this.prisma.harmonizerSurvey.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        organizationId: dto.organizationId,
        createdById,
      },
    });
    return this.toSurveyDto(created);
  }

  async removeSurvey(surveyId: string): Promise<void> {
    const survey = await this.lookup.getSurvey(surveyId);
    const datasets = await this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      select: { id: true, name: true },
    });
    // Las ediciones, los mapeos y las canónicas se borran en cascada; los
    // Parquet crudos no, porque viven en disco.
    const aside = await this.files.setAsideRawFiles(
      datasets,
      (edition) =>
        `No se borró la encuesta «${survey.name}» porque el archivo de datos de su edición «${edition}» está en uso por otro programa (por ejemplo, abierto o copiándose en un respaldo). No se borró ninguna edición. Ciérralo e inténtalo de nuevo.`,
    );
    try {
      await this.prisma.harmonizerSurvey.delete({ where: { id: surveyId } });
    } catch (err) {
      await this.files.restoreRawFiles(aside);
      throw err;
    }
    await Promise.all(aside.map((key) => this.storage.remove(key)));
  }

  async updateSurvey(surveyId: string, dto: UpdateSurveyDto) {
    const survey = await this.lookup.getSurvey(surveyId);
    const data: Prisma.HarmonizerSurveyUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException({
          code: 'survey_name_required',
          message: 'The survey name cannot be empty.',
        });
      }
      if (name !== survey.name) {
        const existing = await this.prisma.harmonizerSurvey.findUnique({
          where: { name },
        });
        if (existing) {
          throw new ConflictException({
            code: 'survey_name_taken',
            message: `A survey named "${name}" already exists.`,
            params: { name },
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
    organizationId: string | null;
  }) {
    return {
      id: survey.id,
      name: survey.name,
      description: survey.description,
      organizationId: survey.organizationId,
    };
  }
}
