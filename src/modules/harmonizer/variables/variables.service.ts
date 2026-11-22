import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { PrismaService } from '../../prisma/prisma.service.js';
import { neutralizeCsvFormula, type ValueType } from '../harmonized-view.js';
import type { RenameCanonicalVariableDto } from '../dto/rename-canonical-variable.dto.js';
import {
  CANONICAL_NAME_PROBLEM_TEXT,
  canonicalNameProblem,
} from '../canonical-name.js';
import {
  compareVariable,
  comparisonStatus,
  suggestRecoding,
  type CatalogCategory,
  type ComparisonEditionInput,
  type ComparisonStatus,
  type VariableComparison,
} from '../comparison.js';
import type { SaveRecodingDto } from '../dto/save-recoding.dto.js';
import { EXPORT_CONTENT_TYPE, type ExportFile } from '../export-file.js';
import { ColumnProfilesService } from '../profiles/column-profiles.service.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { CodebooksService } from '../codebooks/codebooks.service.js';
import {
  MappingTypesService,
  VALUE_TYPE_LABEL,
  quoteList,
} from '../mapping/mapping-types.service.js';
import { safeFileBase } from '../export-file.js';
import { toCatalog, toValueMap } from '../editions/edition-reader.service.js';

/**
 * Canonical variables of a survey: list, rename, delete, compare their codes between editions,
 * mark them reviewed, recode them to common codes and download their catalog.
 */
@Injectable()
export class VariablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: HarmonizerLookupService,
    private readonly codebooks: CodebooksService,
    private readonly profiles: ColumnProfilesService,
    private readonly types: MappingTypesService,
  ) {}

  async listCanonicalVariables(surveyId: string) {
    const survey = await this.lookup.getSurvey(surveyId);
    const variables = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId },
      orderBy: { name: 'asc' },
      include: {
        mappings: {
          select: {
            sourceColumn: true,
            dataset: { select: { id: true, name: true, year: true } },
          },
        },
      },
    });
    const comparisons = await this.variableComparisons(surveyId);
    return {
      survey: { id: survey.id, name: survey.name },
      items: variables.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description,
        dataType: v.dataType,
        categories: toCatalog(v.categories),
        comparison: this.comparisonSummary(
          comparisons.get(v.id)?.comparison,
          v.reviewedSignature,
        ),
        // Nombres creados antes de las reglas: se pueden seguir usando, pero conviene renombrarlos.
        nameValid: canonicalNameProblem(v.name) === null,
        usages: v.mappings
          .map((m) => ({
            datasetId: m.dataset.id,
            datasetName: m.dataset.name,
            year: m.dataset.year,
            column: m.sourceColumn,
          }))
          .sort(
            (a, b) =>
              a.year - b.year || a.datasetName.localeCompare(b.datasetName),
          ),
      })),
    };
  }

  comparisonSummary(
    comparison: VariableComparison | undefined,
    reviewedSignature: string | null,
  ): { status: ComparisonStatus; issueCount: number } {
    if (!comparison) return { status: 'single', issueCount: 0 };
    return {
      status: comparisonStatus(comparison, reviewedSignature),
      issueCount: comparison.issues.length,
    };
  }

  /**
   * Compara los códigos de cada variable (o solo de `variableIds`) entre las ediciones que la
   * mapean. Usa los perfiles de valores guardados, el diccionario de cada edición y la
   * recodificación; no lee los datos salvo para perfilar columnas que aún no tienen perfil.
   */
  async variableComparisons(
    surveyId: string,
    variableIds?: string[],
  ): Promise<
    Map<
      string,
      { inputs: ComparisonEditionInput[]; comparison: VariableComparison }
    >
  > {
    const variables = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, ...(variableIds ? { id: { in: variableIds } } : {}) },
      select: { id: true, dataType: true, categories: true },
    });
    const mappings = await this.prisma.harmonizerMapping.findMany({
      where: { canonicalVariableId: { in: variables.map((v) => v.id) } },
      include: {
        dataset: {
          select: {
            id: true,
            name: true,
            year: true,
            columns: true,
            codebookId: true,
            codebookTable: true,
            createdAt: true,
          },
        },
      },
    });
    mappings.sort(
      (a, b) =>
        a.dataset.year - b.dataset.year ||
        a.dataset.createdAt.getTime() - b.dataset.createdAt.getTime() ||
        a.dataset.id.localeCompare(b.dataset.id),
    );
    const datasets = [
      ...new Map(mappings.map((m) => [m.dataset.id, m.dataset])).values(),
    ];
    const [profiles, codebooks] = await Promise.all([
      this.profiles.columnProfiles(
        mappings.map((m) => ({ dataset: m.dataset, column: m.sourceColumn })),
      ),
      this.codebooks.codebookByColumn(datasets),
    ]);

    const out = new Map<
      string,
      { inputs: ComparisonEditionInput[]; comparison: VariableComparison }
    >();
    for (const v of variables) {
      const inputs: ComparisonEditionInput[] = mappings
        .filter((m) => m.canonicalVariableId === v.id)
        .map((m) => {
          const info = codebooks.get(m.datasetId)?.get(m.sourceColumn);
          return {
            datasetId: m.datasetId,
            datasetName: m.dataset.name,
            year: m.dataset.year,
            column: m.sourceColumn,
            missingCodes: m.missingCodes,
            valueMap: Object.fromEntries(toValueMap(m.valueMap)),
            profile: profiles.get(m.datasetId)?.get(m.sourceColumn) ?? {
              values: [],
              distinctCapped: false,
              empty: 0,
            },
            codebook: info
              ? { label: info.label, categories: info.categories }
              : null,
          };
        });
      out.set(v.id, {
        inputs,
        comparison: compareVariable(
          inputs,
          toCatalog(v.categories),
          v.dataType as ValueType | null,
        ),
      });
    }
    return out;
  }

  /** Comparación de una variable entre ediciones, con una propuesta de recodificación. */
  async getVariableComparison(surveyId: string, variableId: string) {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    const { inputs, comparison } = (
      await this.variableComparisons(surveyId, [variableId])
    ).get(variableId)!;
    const catalog = toCatalog(variable.categories);
    return {
      variable: {
        id: variable.id,
        name: variable.name,
        description: variable.description,
        dataType: variable.dataType as ValueType | null,
        categories: catalog,
        reviewedAt: variable.reviewedSignature ? variable.reviewedAt : null,
        reviewedBy: variable.reviewedSignature ? variable.reviewedBy : null,
      },
      status: comparisonStatus(comparison, variable.reviewedSignature),
      categorical: comparison.categorical,
      editions: comparison.editions,
      issues: comparison.issues,
      suggestion: suggestRecoding(inputs, catalog),
    };
  }

  /**
   * «Revisada, es correcto»: guarda la firma de las diferencias actuales. Si cambian (otro
   * mapeo, otros códigos, otra recodificación), el aviso vuelve.
   */
  async reviewVariable(surveyId: string, variableId: string, reviewer: string) {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    const { comparison } = (
      await this.variableComparisons(surveyId, [variableId])
    ).get(variableId)!;
    if (comparison.issues.length === 0) {
      throw new ConflictException({
        code: 'variable_has_no_differences',
        message: `Variable "${variable.name}" has no code differences between editions to review.`,
        params: { name: variable.name },
      });
    }
    await this.prisma.harmonizerCanonicalVariable.update({
      where: { id: variable.id },
      data: {
        reviewedSignature: comparison.signature,
        reviewedAt: new Date(),
        reviewedBy: reviewer,
      },
    });
    return this.getVariableComparison(surveyId, variableId);
  }

  async clearVariableReview(
    surveyId: string,
    variableId: string,
  ): Promise<void> {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    await this.prisma.harmonizerCanonicalVariable.update({
      where: { id: variable.id },
      data: { reviewedSignature: null, reviewedAt: null, reviewedBy: null },
    });
  }

  /**
   * Guarda el catálogo de una variable y la recodificación de sus ediciones. La recodificación
   * se aplica en las vistas y descargas después de los códigos de no especificado y antes del
   * tipo, así que con un tipo numérico confirmado los códigos resultantes deben ser números.
   */
  async saveRecoding(
    surveyId: string,
    variableId: string,
    dto: SaveRecodingDto,
  ) {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    const invalid = (
      problem: string,
      message: string,
      params: Record<string, unknown> = {},
    ) =>
      new BadRequestException({
        code: 'recoding_invalid',
        message,
        params: { problem, variable: variable.name, ...params },
      });

    const categories: CatalogCategory[] = [];
    for (const c of dto.categories) {
      const code = c.code.trim();
      if (!code)
        throw invalid(
          'empty_code',
          'Every category of the catalog needs a code.',
        );
      if (categories.some((other) => other.code === code)) {
        throw invalid(
          'duplicate_code',
          `Code "${code}" appears twice in the catalog.`,
          { code },
        );
      }
      categories.push({ code, label: (c.label ?? '').trim() });
    }
    const catalogCodes = new Set(categories.map((c) => c.code));

    const mappings = await this.prisma.harmonizerMapping.findMany({
      where: { canonicalVariableId: variable.id },
      include: {
        dataset: {
          select: { id: true, name: true, columns: true, rowCount: true },
        },
      },
    });
    const byDataset = new Map(mappings.map((m) => [m.datasetId, m]));
    const valueMaps = new Map<string, Map<string, string>>();
    for (const edition of dto.editions) {
      const mapping = byDataset.get(edition.datasetId);
      if (!mapping) {
        throw invalid(
          'edition_not_mapped',
          `Edition "${edition.datasetId}" does not map variable "${variable.name}".`,
          { datasetId: edition.datasetId },
        );
      }
      const map = new Map<string, string>();
      for (const { from, to } of edition.values) {
        const source = from.trim();
        const target = to.trim();
        if (!source || !target) continue;
        if (map.has(source)) {
          throw invalid(
            'duplicate_value',
            `Value "${source}" of edition "${mapping.dataset.name}" is recoded twice.`,
            { edition: mapping.dataset.name, value: source },
          );
        }
        if (catalogCodes.size > 0 && !catalogCodes.has(target)) {
          throw invalid(
            'target_not_in_catalog',
            `Edition "${mapping.dataset.name}": value "${source}" is recoded to "${target}", which is not a code of the catalog.`,
            { edition: mapping.dataset.name, value: source, target },
          );
        }
        // `05` → `05` también se guarda: dice que el valor ya se revisó contra el catálogo.
        map.set(source, target);
      }
      valueMaps.set(mapping.datasetId, map);
    }

    const dataType = variable.dataType as ValueType | null;
    if (dataType === 'integer' || dataType === 'decimal') {
      for (const [datasetId, map] of valueMaps) {
        const mapping = byDataset.get(datasetId)!;
        const [bad] = await this.types.valuesNotFittingIn(mapping.dataset, [
          {
            column: mapping.sourceColumn,
            type: dataType,
            missingCodes: mapping.missingCodes,
            valueMap: map,
          },
        ]);
        if (bad.length > 0) {
          throw new BadRequestException({
            code: 'value_type_mismatch',
            message: `Variable "${variable.name}" is confirmed as ${VALUE_TYPE_LABEL[dataType]}, but after recoding edition "${mapping.dataset.name}" (column "${mapping.sourceColumn}") it has values that are not: ${quoteList(bad)}.`,
            params: {
              source: 'recoding',
              variable: variable.name,
              edition: mapping.dataset.name,
              column: mapping.sourceColumn,
              expectedType: dataType,
              values: bad,
            },
          });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.harmonizerCanonicalVariable.update({
        where: { id: variable.id },
        data: {
          categories:
            categories.length > 0
              ? (categories as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
      for (const [datasetId, map] of valueMaps) {
        await tx.harmonizerMapping.update({
          where: { id: byDataset.get(datasetId)!.id },
          data: { valueMap: Object.fromEntries(map) },
        });
      }
    });
    return this.getVariableComparison(surveyId, variableId);
  }

  /** Catálogo de categorías de todas las variables de la encuesta que tienen uno, como CSV. */
  async exportCatalog(surveyId: string): Promise<ExportFile> {
    const survey = await this.lookup.getSurvey(surveyId);
    const variables = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId },
      orderBy: { name: 'asc' },
      select: { name: true, description: true, categories: true },
    });
    const rows = variables.flatMap((v) =>
      toCatalog(v.categories).map((c) => [
        v.name,
        v.description ?? '',
        c.code,
        c.label,
      ]),
    );
    const csv = stringify(
      [['variable', 'descripcion', 'codigo', 'etiqueta'], ...rows],
      {
        cast: { string: neutralizeCsvFormula },
      },
    );
    return {
      filename: `${safeFileBase(`catalogo_${survey.name}`, 'catalogo')}.csv`,
      contentType: EXPORT_CONTENT_TYPE.csv,
      body: Buffer.from(`\ufeff${csv}`, 'utf8'),
    };
  }

  private async getCanonicalVariable(surveyId: string, variableId: string) {
    await this.lookup.getSurvey(surveyId);
    const variable = await this.prisma.harmonizerCanonicalVariable.findFirst({
      where: { id: variableId, surveyId },
      include: {
        mappings: {
          select: { sourceColumn: true, dataset: { select: { name: true } } },
        },
      },
    });
    if (!variable) {
      throw new NotFoundException({
        code: 'canonical_variable_not_found',
        message: 'Variable not found in this survey.',
      });
    }
    return variable;
  }

  /** Renombrar no toca los mapeos: apuntan al id, así que todas las ediciones ven el nombre nuevo. */
  async renameCanonicalVariable(
    surveyId: string,
    variableId: string,
    dto: RenameCanonicalVariableDto,
  ) {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    const name = dto.name.trim();
    const problem = canonicalNameProblem(name);
    if (problem) {
      throw new BadRequestException({
        code: 'canonical_variable_name_invalid',
        message: `The name "${name}" is not valid: ${CANONICAL_NAME_PROBLEM_TEXT[problem]}.`,
        params: { name, problem },
      });
    }
    const clash = await this.prisma.harmonizerCanonicalVariable.findFirst({
      where: {
        surveyId,
        id: { not: variableId },
        name: { equals: name, mode: 'insensitive' },
      },
      select: { name: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'canonical_variable_name_taken',
        message: `A variable named "${clash.name}" already exists in this survey (names are case-insensitive).`,
        params: { existing: clash.name },
      });
    }
    const updated = await this.prisma.harmonizerCanonicalVariable.update({
      where: { id: variable.id },
      data: { name },
    });
    return { id: updated.id, name: updated.name, dataType: updated.dataType };
  }

  /** Solo se borran canónicas que ninguna edición mapea, para no deshacer mapeos sin querer. */
  async removeCanonicalVariable(
    surveyId: string,
    variableId: string,
  ): Promise<void> {
    const variable = await this.getCanonicalVariable(surveyId, variableId);
    if (variable.mappings.length > 0) {
      const usages = variable.mappings.map((m) => ({
        edition: m.dataset.name,
        column: m.sourceColumn,
      }));
      throw new ConflictException({
        code: 'canonical_variable_in_use',
        message: `Variable "${variable.name}" is mapped in ${usages
          .map((u) => `"${u.edition}" (column "${u.column}")`)
          .join(', ')}. Remove those mappings before deleting it.`,
        params: { name: variable.name, usages },
      });
    }
    await this.prisma.harmonizerCanonicalVariable.delete({
      where: { id: variable.id },
    });
  }
}
