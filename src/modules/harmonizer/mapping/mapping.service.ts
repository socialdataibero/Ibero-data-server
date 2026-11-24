import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { matchByName } from '../matching.js';
import {
  allFit,
  inferredType as inferredTypeOf,
  type ColumnTypeCheck,
  type TypeFacts,
} from '../column-checks.js';
import { type ColumnValues, type ValueType } from '../harmonized-view.js';
import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from '../dto/mapping-choice.dto.js';
import type { SaveMappingDto } from '../dto/save-mapping.dto.js';
import {
  CANONICAL_NAME_PROBLEM_TEXT,
  canonicalNameProblem,
  sameCanonicalName,
} from '../canonical-name.js';
import {
  codebookMissingCodes,
  normalizeLabel,
  type CodebookVariableInfo,
} from '../codebook.js';
import { type ColumnProfile } from '../comparison.js';
import { assertSourceRoles, type SourceRole } from '../source-metadata.js';
import { ColumnProfilesService } from '../profiles/column-profiles.service.js';
import { isMappedChoice } from './mapping-choices.js';
import {
  canonicalUpdates,
  mappingChanges,
  mappingCollisions,
  newCanonicalsToCreate,
  resolveChoices,
} from './mapping-save-steps.js';
import {
  isRole,
  roleAllowsType,
  roleTypeMismatch,
} from '../variables/variable-role.js';
import { MappingTypesService } from './mapping-types.service.js';
import { toDatasetInfo } from '../harmonizer-types.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { CodebooksService } from '../codebooks/codebooks.service.js';
import type {
  CanonicalVariableInfo,
  ColumnCodebook,
  DatasetInfo,
  MappingColumn,
  SuggestionSource,
} from '../harmonizer-types.js';

/**
 * Tipo sugerido para una columna con diccionario, a partir de sus valores ya sin sus códigos de
 * no especificado (`facts`, ver column-checks.ts).
 */
function codebookSuggestedType(
  info: CodebookVariableInfo,
  facts: TypeFacts,
): ValueType {
  if (info.declaredType === 'text') return 'text';
  if (info.declaredType === null) {
    // Una variable con categorías es un código: se guarda como texto para no perder ceros.
    if (info.categories.filter((c) => c.kind === 'value').length >= 2)
      return 'text';
    return inferredTypeOf(facts);
  }
  if (allFit(facts, 'integer')) return 'integer';
  if (allFit(facts, 'decimal')) return 'decimal';
  return 'text';
}

/** Valores más frecuentes que muestra la pantalla de mapeo por columna. */
const MAPPING_TOP_VALUES = 5;

/**
 * Resumen de los valores de una columna para el mapeo, desde su perfil guardado: los más
 * frecuentes (en un empate, en orden alfabético) y cuántos distintos hay, contando hasta
 * `PROFILE_MAX_VALUES`.
 */
function profileColumnValues(profile: ColumnProfile | undefined): ColumnValues {
  if (!profile)
    return { top: [], distinct: 0, distinctCapped: false, empty: 0 };
  return {
    top: profile.values.slice(0, MAPPING_TOP_VALUES),
    distinct: profile.values.length,
    distinctCapped: profile.distinctCapped,
    empty: profile.empty,
  };
}

/**
 * The mapping of an edition: its columns with saved or suggested canonical variables, values and
 * dictionary data, and saving it (new canonicals, "not specified" codes, confirmed types, roles).
 */
@Injectable()
export class MappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lookup: HarmonizerLookupService,
    private readonly codebooks: CodebooksService,
    private readonly profiles: ColumnProfilesService,
    private readonly types: MappingTypesService,
  ) {}

  /** El mapeo guardado de una edición, sin leer sus datos (para copiarlo a otra edición). */
  async getSavedMapping(datasetId: string) {
    const dataset = await this.lookup.getDataset(datasetId);
    const mappings = await this.prisma.harmonizerMapping.findMany({
      where: { datasetId },
      include: { canonicalVariable: { select: { name: true } } },
    });
    const order = new Map(dataset.columns.map((c, i) => [c, i]));
    return {
      dataset: toDatasetInfo(dataset),
      columns: mappings
        .sort(
          (a, b) =>
            (order.get(a.sourceColumn) ?? 0) - (order.get(b.sourceColumn) ?? 0),
        )
        .map((m) => ({
          column: m.sourceColumn,
          canonicalId: m.canonicalVariableId,
          canonicalName: m.canonicalVariable.name,
          missingCodes: m.missingCodes,
          role: m.role,
        })),
    };
  }

  async getMapping(datasetId: string): Promise<{
    dataset: DatasetInfo;
    columns: MappingColumn[];
    canonicalVariables: CanonicalVariableInfo[];
    codebook: {
      id: string;
      name: string;
      table: string | null;
      matchedColumns: number;
    } | null;
    codebooks: { id: string; name: string; tables: string[] }[];
    otherEditions: {
      id: string;
      name: string;
      year: number;
      mappedColumns: number;
    }[];
  }> {
    const dataset = await this.lookup.getDataset(datasetId);

    const [canonicals, saved, historical, codebookVars, codebooks, others] =
      await Promise.all([
        this.prisma.harmonizerCanonicalVariable.findMany({
          where: { surveyId: dataset.surveyId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, description: true, dataType: true },
        }),
        this.prisma.harmonizerMapping.findMany({ where: { datasetId } }),
        this.prisma.harmonizerMapping.findMany({
          where: {
            datasetId: { not: datasetId },
            sourceColumn: { in: dataset.columns },
            dataset: { surveyId: dataset.surveyId },
          },
        }),
        this.codebooks.codebookByColumn([dataset]),
        this.prisma.harmonizerCodebook.findMany({
          where: { surveyId: dataset.surveyId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        this.prisma.harmonizerDataset.findMany({
          where: { surveyId: dataset.surveyId, id: { not: datasetId } },
          orderBy: [{ year: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            name: true,
            year: true,
            _count: { select: { mappings: true } },
          },
        }),
      ]);
    const codebookTables = await this.prisma.harmonizerCodebookVariable.groupBy(
      {
        by: ['codebookId', 'table'],
        where: { codebookId: { in: codebooks.map((c) => c.id) } },
        orderBy: [{ codebookId: 'asc' }, { table: 'asc' }],
      },
    );
    const columnCodebook =
      codebookVars.get(dataset.id) ?? new Map<string, CodebookVariableInfo>();

    const nameById = new Map(canonicals.map((c) => [c.id, c.name]));
    const savedByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.canonicalVariableId]),
    );
    const savedCodesByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.missingCodes]),
    );
    const savedRoleByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.role as SourceRole | null]),
    );
    const historicalByColumn = new Map<string, string>();
    for (const m of historical) {
      if (!historicalByColumn.has(m.sourceColumn))
        historicalByColumn.set(m.sourceColumn, m.canonicalVariableId);
    }

    // Las filas no se cargan: los valores frecuentes salen de los perfiles guardados y los
    // tipos, de una consulta de DuckDB por columna sobre el Parquet.
    const [profiles, typeResults] = await Promise.all([
      this.profiles.columnProfiles([{ dataset, column: null }]),
      this.types.columnTypeResults(
        dataset,
        dataset.columns.map((name, i): ColumnTypeCheck => {
          const info = columnCodebook.get(name);
          return {
            rawColumn: `c${i}`,
            missingCodes: savedCodesByColumn.get(name) ?? [],
            codebookMissing: info
              ? info.categories
                  .filter((c) => c.kind === 'missing')
                  .map((c) => c.code)
              : null,
          };
        }),
      ),
    ]);
    const profileByColumn = profiles.get(dataset.id);

    // Una canónica ya asignada (o ya sugerida) a otra columna de este archivo
    // no se vuelve a sugerir: dos columnas a la misma canónica colisionan.
    const usedIds = new Set(savedByColumn.values());

    const suggestion = (
      name: string,
      info: CodebookVariableInfo | undefined,
    ): { id: string; source: SuggestionSource } | null => {
      const historicalId = historicalByColumn.get(name);
      if (historicalId && !usedIds.has(historicalId)) {
        return { id: historicalId, source: 'history' };
      }
      const available = canonicals.filter((c) => !usedIds.has(c.id));
      const matchedId = matchByName(name, available);
      if (matchedId) return { id: matchedId, source: 'name' };
      // Con diccionario, una columna que cambió de nombre entre ediciones (PARENT → PARENTESCO)
      // se reconoce por su descripción, que es la de la canónica.
      const label = info?.label ? normalizeLabel(info.label) : '';
      if (label) {
        const byLabel = available.filter(
          (c) => c.description && normalizeLabel(c.description) === label,
        );
        if (byLabel.length === 1)
          return { id: byLabel[0].id, source: 'description' };
      }
      return null;
    };

    const columns = dataset.columns.map((name, i): MappingColumn => {
      const types = typeResults[i];
      const inferredType = inferredTypeOf(types.saved);
      const values = profileColumnValues(profileByColumn?.get(name));
      const info = columnCodebook.get(name);
      let codebook: ColumnCodebook | null = null;
      if (info && types.codebook) {
        codebook = {
          ...info,
          missingCodes: codebookMissingCodes(
            info.categories,
            types.codebook.codeValues,
          ),
          suggestedType: codebookSuggestedType(info, types.codebook.facts),
        };
      }
      const base = {
        name,
        missingCodes: [] as string[],
        role: null as SourceRole | null,
        inferredType,
        values,
        codebook,
      };
      const savedId = savedByColumn.get(name);
      if (savedId) {
        return {
          ...base,
          selectedCanonicalId: savedId,
          suggested: null,
          suggestionSource: null,
          missingCodes: savedCodesByColumn.get(name) ?? [],
          role: savedRoleByColumn.get(name) ?? null,
        };
      }
      const suggested = suggestion(name, info);
      if (suggested) {
        usedIds.add(suggested.id);
        return {
          ...base,
          selectedCanonicalId: suggested.id,
          suggested: nameById.get(suggested.id) ?? null,
          suggestionSource: suggested.source,
        };
      }
      return {
        ...base,
        selectedCanonicalId: null,
        suggested: null,
        suggestionSource: null,
      };
    });

    const attached = dataset.codebookId
      ? codebooks.find((c) => c.id === dataset.codebookId)
      : undefined;
    return {
      dataset: toDatasetInfo(dataset),
      columns,
      canonicalVariables: canonicals.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        dataType: c.dataType as ValueType | null,
      })),
      codebook: attached
        ? {
            id: attached.id,
            name: attached.name,
            table: dataset.codebookTable,
            matchedColumns: columnCodebook.size,
          }
        : null,
      codebooks: codebooks.map((c) => ({
        id: c.id,
        name: c.name,
        tables: codebookTables
          .filter((t) => t.codebookId === c.id)
          .map((t) => t.table),
      })),
      otherEditions: others.map((d) => ({
        id: d.id,
        name: d.name,
        year: d.year,
        mappedColumns: d._count.mappings,
      })),
    };
  }

  async saveMapping(
    datasetId: string,
    dto: SaveMappingDto,
  ): Promise<{ ok: true; datasetId: string }> {
    const dataset = await this.lookup.getDataset(datasetId);
    const choiceByColumn = new Map(dto.columns.map((c) => [c.column, c]));

    assertSourceRoles(
      dataset.design,
      dataset.columns.map((column) => {
        const choice = choiceByColumn.get(column);
        return {
          column,
          mapped: !!choice && isMappedChoice(choice),
          role: choice?.role,
        };
      }),
    );
    await this.assertNewCanonicalNames(dataset, choiceByColumn);
    const saved = await this.prisma.harmonizerMapping.findMany({
      where: { datasetId },
    });
    const savedByColumn = new Map(saved.map((m) => [m.sourceColumn, m]));
    await this.assertRoleTypes(dataset, choiceByColumn);
    // Fuera de la transacción: leer los Parquet puede tardar más que su timeout.
    await this.types.assertValueTypes(dataset, choiceByColumn, savedByColumn);
    const columnCodebook =
      (await this.codebooks.codebookByColumn([dataset])).get(dataset.id) ??
      new Map<string, CodebookVariableInfo>();

    // Todo se lee y se escribe en lotes: con una consulta por columna, guardar 500 columnas
    // tardaba lo mismo aunque solo cambiaran 4.
    await this.prisma.$transaction(
      async (tx) => {
        const canonicals = await tx.harmonizerCanonicalVariable.findMany({
          where: { surveyId: dataset.surveyId },
          select: { id: true, name: true, description: true, dataType: true },
        });
        const byId = new Map(canonicals.map((c) => [c.id, c]));
        const byName = new Map(canonicals.map((c) => [c.name, c]));

        // Las canónicas nuevas se crean de una vez. Su descripción es la del envío o, si no
        // viene, la del diccionario de la edición.
        const toCreate = newCanonicalsToCreate(
          dataset.columns,
          choiceByColumn,
          byName,
          columnCodebook,
        );
        if (toCreate.size > 0) {
          const created =
            await tx.harmonizerCanonicalVariable.createManyAndReturn({
              data: [...toCreate].map(([name, description]) => ({
                surveyId: dataset.surveyId,
                name,
                description,
              })),
              select: {
                id: true,
                name: true,
                description: true,
                dataType: true,
              },
            });
          for (const c of created) {
            byId.set(c.id, c);
            byName.set(c.name, c);
          }
        }

        const resolved = resolveChoices(
          dataset.columns,
          choiceByColumn,
          byId,
          byName,
        );
        const collisions = mappingCollisions(resolved);
        if (collisions.length > 0) {
          throw new ConflictException({
            code: 'canonical_variable_collision',
            message: `Each canonical variable can come from only one column per edition. These columns share a variable: ${collisions
              .map((columns) => columns.join(', '))
              .join('; ')}.`,
            params: { groups: collisions },
          });
        }

        const { toUpdate, toDelete, toInsert } = mappingChanges(
          datasetId,
          resolved,
          savedByColumn,
        );
        for (const { id, data } of toUpdate) {
          await tx.harmonizerMapping.update({ where: { id }, data });
        }
        if (toDelete.length > 0) {
          await tx.harmonizerMapping.deleteMany({
            where: { id: { in: toDelete } },
          });
        }
        if (toInsert.length > 0) {
          await tx.harmonizerMapping.createMany({ data: toInsert });
        }

        for (const [id, data] of canonicalUpdates(
          resolved,
          byId,
          columnCodebook,
        )) {
          await tx.harmonizerCanonicalVariable.update({ where: { id }, data });
        }
      },
      { timeout: 60_000 },
    );

    return { ok: true, datasetId };
  }

  /**
   * A confirmed type must fit the analysis role of its canonical (variables/variable-role.ts): a
   * measure is a number and a variable of codes stays text. Otherwise
   * `409 variable_role_type_mismatch`, and nothing is saved.
   */
  private async assertRoleTypes(
    dataset: { surveyId: string; columns: string[] },
    choiceByColumn: Map<string, MappingChoiceDto>,
  ): Promise<void> {
    const typed = dataset.columns
      .map((column) => choiceByColumn.get(column))
      .filter(
        (c): c is MappingChoiceDto & { dataType: ValueType } =>
          c !== undefined && c.dataType !== undefined && isMappedChoice(c),
      );
    if (typed.length === 0) return;
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: {
        surveyId: dataset.surveyId,
        role: { not: null },
        OR: [
          { id: { in: typed.map((c) => c.choice.slice(CANONICAL_PREFIX.length)) } },
          { name: { in: typed.map((c) => c.newName?.trim() ?? '') } },
        ],
      },
      select: { id: true, name: true, role: true },
    });
    for (const choice of typed) {
      const canonical =
        choice.choice === NEW_CANONICAL
          ? canonicals.find((c) => c.name === choice.newName?.trim())
          : canonicals.find(
              (c) => c.id === choice.choice.slice(CANONICAL_PREFIX.length),
            );
      if (
        canonical &&
        isRole(canonical.role) &&
        !roleAllowsType(canonical.role, choice.dataType)
      ) {
        throw roleTypeMismatch(canonical.name, canonical.role, choice.dataType);
      }
    }
  }

  /**
   * Los nombres de canónicas nuevas (`__new__`) deben cumplir las reglas y no pueden repetir,
   * aunque sea con otras mayúsculas, una canónica de la encuesta ni otro nombre nuevo del mismo
   * envío. Un nombre idéntico a una canónica existente la reutiliza, como antes, aunque sea un
   * nombre anterior a las reglas.
   */
  private async assertNewCanonicalNames(
    dataset: { surveyId: string; columns: string[] },
    choiceByColumn: Map<string, MappingChoiceDto>,
  ): Promise<void> {
    const existing = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId: dataset.surveyId },
      select: { name: true },
    });
    const known = existing.map((c) => c.name);
    const created = new Map<string, string>(); // nombre nuevo → columna que lo crea
    for (const column of dataset.columns) {
      const choice = choiceByColumn.get(column);
      if (choice?.choice !== NEW_CANONICAL) continue;
      const name = choice.newName?.trim() ?? '';
      if (!name || known.includes(name) || created.has(name)) continue;
      const problem = canonicalNameProblem(name);
      if (problem) {
        throw new BadRequestException({
          code: 'canonical_variable_name_invalid',
          message: `Column "${column}": the name "${name}" is not valid: ${CANONICAL_NAME_PROBLEM_TEXT[problem]}.`,
          params: { column, name, problem },
        });
      }
      const clash = known.find((other) => sameCanonicalName(other, name));
      if (clash) {
        throw new ConflictException({
          code: 'canonical_variable_name_taken',
          message: `Column "${column}": variable "${clash}" already exists and names are case-insensitive. Pick it from the list instead of creating "${name}".`,
          params: { column, name, existing: clash },
        });
      }
      const sibling = [...created.entries()].find(([other]) =>
        sameCanonicalName(other, name),
      );
      if (sibling) {
        throw new ConflictException({
          code: 'canonical_variable_name_taken',
          message: `Column "${column}": column "${sibling[1]}" already creates variable "${sibling[0]}" and names are case-insensitive. Use the same name or a different one.`,
          params: {
            column,
            name,
            existing: sibling[0],
            otherColumn: sibling[1],
          },
        });
      }
      created.set(name, column);
    }
  }
}
