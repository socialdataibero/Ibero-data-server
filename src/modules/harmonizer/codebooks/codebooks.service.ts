import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CodebookError,
  parseCodebookCsv,
  parseCodebookWorkbook,
  type CodebookCategory,
  type CodebookVariableInfo,
  type ParsedCodebook,
} from '../codebook.js';
import type { SetDatasetCodebookDto } from '../dto/set-dataset-codebook.dto.js';
import type { ValueType } from '../harmonized-view.js';
import { codebookNotFound } from '../harmonizer-errors.js';
import { decodeUtf8 } from '../import/upload-parse.js';
import { HarmonizerLookupService } from '../lookup.service.js';

/** Diccionarios: tamaño máximo del archivo y extensiones aceptadas. */
export const MAX_CODEBOOK_BYTES = 20 * 1024 * 1024;
const CODEBOOK_EXCEL = /\.xlsx?$/i;
const CODEBOOK_CSV = /\.csv$/i;

export interface CodebookDatasetRef {
  id: string;
  columns: string[];
  codebookId: string | null;
  codebookTable: string | null;
}

function toCodebookInfo(v: {
  name: string;
  label: string | null;
  question: string | null;
  section: string | null;
  declaredType: string | null;
  categories: Prisma.JsonValue;
}): CodebookVariableInfo {
  return {
    name: v.name,
    label: v.label,
    question: v.question,
    section: v.section,
    declaredType: v.declaredType as ValueType | null,
    categories: (Array.isArray(v.categories)
      ? v.categories
      : []) as unknown as CodebookCategory[],
  };
}

/** Dictionaries of a survey: upload, read, delete, attach to an edition, look up by column. */
@Injectable()
export class CodebooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: HarmonizerLookupService,
  ) {}

  async createCodebook(
    surveyId: string,
    name: string | undefined,
    file: { originalname: string; buffer: Buffer },
  ) {
    const survey = await this.lookup.getSurvey(surveyId);
    const trimmed = (name ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException({
        code: 'codebook_name_required',
        message: 'Enter a name for the dictionary (field "name").',
      });
    }
    const parsed = this.parseCodebookFile(file);
    const taken = () =>
      new ConflictException({
        code: 'codebook_name_taken',
        message: `Survey "${survey.name}" already has a dictionary named "${trimmed}".`,
        params: { survey: survey.name, name: trimmed },
      });
    const existing = await this.prisma.harmonizerCodebook.findUnique({
      where: { surveyId_name: { surveyId, name: trimmed } },
    });
    if (existing) throw taken();
    let created;
    try {
      created = await this.prisma.harmonizerCodebook.create({
        data: {
          surveyId,
          name: trimmed,
          fileName: file.originalname,
          format: parsed.format,
          variables: {
            createMany: {
              data: parsed.variables.map((v) => ({
                ...v,
                categories: v.categories as unknown as Prisma.InputJsonValue,
              })),
            },
          },
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw taken();
      throw err;
    }
    return this.getCodebookSummary(created.id);
  }

  private parseCodebookFile(file: {
    originalname: string;
    buffer: Buffer;
  }): ParsedCodebook {
    try {
      if (CODEBOOK_EXCEL.test(file.originalname)) {
        return parseCodebookWorkbook(file.buffer);
      }
      if (CODEBOOK_CSV.test(file.originalname)) {
        return parseCodebookCsv(decodeUtf8(file.buffer));
      }
    } catch (err) {
      if (err instanceof CodebookError) {
        throw new BadRequestException({
          code: 'codebook_invalid',
          message: err.message,
          params: { problem: err.problem, ...err.params },
        });
      }
      throw err;
    }
    throw new BadRequestException({
      code: 'codebook_format_unsupported',
      message:
        'The dictionary must be an Excel workbook (.xls, .xlsx) or a CSV file (.csv).',
      params: { fileName: file.originalname },
    });
  }

  async listCodebooks(surveyId: string) {
    const survey = await this.lookup.getSurvey(surveyId);
    const codebooks = await this.prisma.harmonizerCodebook.findMany({
      where: { surveyId },
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    return {
      survey: { id: survey.id, name: survey.name },
      items: await Promise.all(
        codebooks.map((c) => this.getCodebookSummary(c.id)),
      ),
    };
  }

  private async getCodebookSummary(codebookId: string) {
    const codebook = await this.prisma.harmonizerCodebook.findUnique({
      where: { id: codebookId },
      include: {
        datasets: {
          select: { id: true, name: true, year: true, codebookTable: true },
          orderBy: [{ year: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!codebook) throw codebookNotFound();
    const counts = await this.prisma.harmonizerCodebookVariable.groupBy({
      by: ['table'],
      where: { codebookId },
      _count: { _all: true },
      orderBy: { table: 'asc' },
    });
    return {
      id: codebook.id,
      surveyId: codebook.surveyId,
      name: codebook.name,
      fileName: codebook.fileName,
      format: codebook.format,
      createdAt: codebook.createdAt,
      tables: counts.map((c) => ({
        name: c.table,
        variableCount: c._count._all,
      })),
      datasets: codebook.datasets.map((d) => ({
        id: d.id,
        name: d.name,
        year: d.year,
        table: d.codebookTable,
      })),
    };
  }

  /** El diccionario con todas sus variables, agrupadas por tabla. */
  async getCodebook(codebookId: string) {
    const summary = await this.getCodebookSummary(codebookId);
    const variables = await this.prisma.harmonizerCodebookVariable.findMany({
      where: { codebookId },
      orderBy: [{ table: 'asc' }, { position: 'asc' }],
    });
    return {
      ...summary,
      tables: summary.tables.map((t) => ({
        ...t,
        variables: variables
          .filter((v) => v.table === t.name)
          .map((v) => ({
            ...toCodebookInfo(v),
            validRange: v.validRange,
            length: v.length,
          })),
      })),
    };
  }

  /** Borrar un diccionario deja sin diccionario a las ediciones que lo usan; sus mapeos no cambian. */
  async removeCodebook(codebookId: string): Promise<void> {
    const codebook = await this.prisma.harmonizerCodebook.findUnique({
      where: { id: codebookId },
      select: { id: true },
    });
    if (!codebook) throw codebookNotFound();
    await this.prisma.harmonizerCodebook.delete({ where: { id: codebookId } });
  }

  /**
   * Asocia un diccionario de la encuesta a una edición (o lo quita con `codebookId: null`). Sin
   * `table`, se elige la tabla con más columnas en común con el archivo.
   */
  async setDatasetCodebook(datasetId: string, dto: SetDatasetCodebookDto) {
    const dataset = await this.lookup.getDataset(datasetId);
    if (dto.codebookId === null || dto.codebookId === undefined) {
      await this.prisma.harmonizerDataset.update({
        where: { id: datasetId },
        data: { codebookId: null, codebookTable: null },
      });
      return { codebook: null };
    }
    const codebook = await this.prisma.harmonizerCodebook.findFirst({
      where: { id: dto.codebookId, surveyId: dataset.surveyId },
      select: { id: true, name: true },
    });
    if (!codebook) throw codebookNotFound();
    const variables = await this.prisma.harmonizerCodebookVariable.findMany({
      where: { codebookId: codebook.id },
      select: { table: true, name: true },
    });
    const namesByTable = new Map<string, Set<string>>();
    for (const v of variables) {
      const names = namesByTable.get(v.table) ?? new Set<string>();
      names.add(v.name.toLowerCase());
      namesByTable.set(v.table, names);
    }
    const matched = (table: string) =>
      dataset.columns.filter((c) =>
        namesByTable.get(table)?.has(c.toLowerCase()),
      );

    let table = dto.table?.trim();
    if (table !== undefined && table !== '') {
      if (!namesByTable.has(table)) {
        throw new BadRequestException({
          code: 'codebook_table_not_found',
          message: `Dictionary "${codebook.name}" has no table "${table}".`,
          params: { table, tables: [...namesByTable.keys()] },
        });
      }
    } else {
      table = [...namesByTable.keys()].sort(
        (a, b) => matched(b).length - matched(a).length || a.localeCompare(b),
      )[0];
    }
    const matchedColumns = table === undefined ? [] : matched(table);
    if (table === undefined || matchedColumns.length === 0) {
      throw new BadRequestException({
        code: 'codebook_no_match',
        message: `No column of edition "${dataset.name}" is described in dictionary "${codebook.name}"${dto.table ? ` (table "${table}")` : ''}.`,
        params: {
          edition: dataset.name,
          codebook: codebook.name,
          table: dto.table ? table : null,
        },
      });
    }
    await this.prisma.harmonizerDataset.update({
      where: { id: datasetId },
      data: { codebookId: codebook.id, codebookTable: table },
    });
    return {
      codebook: {
        id: codebook.id,
        name: codebook.name,
        table,
        matchedColumns: matchedColumns.length,
        unmatchedColumns: dataset.columns.filter(
          (c) => !matchedColumns.includes(c),
        ),
      },
    };
  }

  /**
   * Variables del diccionario de cada edición, por columna. Una columna se busca en la tabla de
   * la edición por su nombre exacto o, si no está, sin distinguir mayúsculas.
   */
  async codebookByColumn(
    datasets: CodebookDatasetRef[],
  ): Promise<Map<string, Map<string, CodebookVariableInfo>>> {
    const out = new Map<string, Map<string, CodebookVariableInfo>>();
    const refs = datasets.filter(
      (d): d is CodebookDatasetRef & { codebookId: string } =>
        d.codebookId !== null,
    );
    if (refs.length === 0) return out;
    const pairs = [
      ...new Map(
        refs.map((d) => [
          `${d.codebookId}\u0000${d.codebookTable ?? ''}`,
          { codebookId: d.codebookId, table: d.codebookTable ?? '' },
        ]),
      ).values(),
    ];
    const variables = await this.prisma.harmonizerCodebookVariable.findMany({
      where: { OR: pairs },
    });
    const byPair = new Map<
      string,
      {
        exact: Map<string, CodebookVariableInfo>;
        lower: Map<string, CodebookVariableInfo>;
      }
    >();
    for (const v of variables) {
      const key = `${v.codebookId}\u0000${v.table}`;
      const entry = byPair.get(key) ?? { exact: new Map(), lower: new Map() };
      const info = toCodebookInfo(v);
      entry.exact.set(v.name, info);
      if (!entry.lower.has(v.name.toLowerCase()))
        entry.lower.set(v.name.toLowerCase(), info);
      byPair.set(key, entry);
    }
    for (const d of refs) {
      const entry = byPair.get(`${d.codebookId}\u0000${d.codebookTable ?? ''}`);
      const byColumn = new Map<string, CodebookVariableInfo>();
      for (const column of d.columns) {
        const info =
          entry?.exact.get(column) ?? entry?.lower.get(column.toLowerCase());
        if (info) byColumn.set(column, info);
      }
      out.set(d.id, byColumn);
    }
    return out;
  }
}
