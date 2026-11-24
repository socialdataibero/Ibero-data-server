import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnalysisService } from '../../analysis/analysis.service.js';
import { cachedColumnChecks } from '../column-check-store.js';
import {
  columnTypeQuery,
  notFittingQuery,
  readColumnTypeResult,
  readNotFitting,
  type ColumnTypeCheck,
  type ColumnTypeResult,
} from '../column-checks.js';
import { type ValueType } from '../harmonized-view.js';
import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from '../dto/mapping-choice.dto.js';
import { EditionFilesService } from '../editions/edition-files.service.js';
import { isMappedChoice, normalizeMissingCodes } from './mapping-choices.js';
import { toValueMap } from '../editions/edition-reader.service.js';

export const VALUE_TYPE_LABEL: Record<ValueType, string> = {
  text: 'text',
  integer: 'whole numbers',
  decimal: 'numbers',
};

export function quoteList(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

/**
 * Whether the values of a column fit a numeric type, asked to DuckDB over the stored files
 * (see column-checks.ts). Saving a mapping and saving a recoding check with it, outside their
 * transactions: reading the files can take longer than a transaction may stay open.
 */
@Injectable()
export class MappingTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly files: EditionFilesService,
  ) {}

  /**
   * Un tipo numérico solo se acepta si todos los valores no faltantes de la columna lo
   * cumplen, con los códigos de no especificado de este mismo envío. Si el tipo de una
   * canónica existente cambia, también se revisan las otras ediciones que la usan,
   * porque el tipo es uno solo para la variable.
   */
  async assertValueTypes(
    dataset: {
      id: string;
      name: string;
      surveyId: string;
      columns: string[];
      rowCount: number;
    },
    choiceByColumn: Map<string, MappingChoiceDto>,
    savedByColumn: Map<
      string,
      {
        canonicalVariableId: string;
        missingCodes: string[];
        valueMap: Prisma.JsonValue;
      }
    >,
  ): Promise<void> {
    const numeric = dataset.columns
      .map((column) => choiceByColumn.get(column))
      .filter(
        (c): c is MappingChoiceDto & { dataType: ValueType } =>
          c !== undefined &&
          c.dataType !== undefined &&
          c.dataType !== 'text' &&
          isMappedChoice(c),
      );
    if (numeric.length === 0) return;

    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: {
        surveyId: dataset.surveyId,
        OR: numeric.map((c) =>
          c.choice === NEW_CANONICAL
            ? { name: c.newName?.trim() ?? '' }
            : { id: c.choice.slice(CANONICAL_PREFIX.length) },
        ),
      },
      select: { id: true, name: true, dataType: true },
    });
    const canonicalOf = (c: MappingChoiceDto) =>
      canonicals.find((cv) =>
        c.choice === NEW_CANONICAL
          ? cv.name === c.newName?.trim()
          : cv.id === c.choice.slice(CANONICAL_PREFIX.length),
      );

    // Una columna que ya estaba guardada con la misma variable, los mismos códigos y el tipo
    // ya confirmado se validó al guardarla y sus datos no cambian: no se vuelve a leer.
    const changed = numeric.filter((choice) => {
      const saved = savedByColumn.get(choice.column);
      const canonical = canonicalOf(choice);
      return !(
        saved &&
        canonical &&
        saved.canonicalVariableId === canonical.id &&
        canonical.dataType === choice.dataType &&
        saved.missingCodes.join('\u0000') ===
          normalizeMissingCodes(choice.missingCodes).join('\u0000')
      );
    });
    if (changed.length > 0) {
      const badByChoice = await this.valuesNotFittingIn(
        dataset,
        changed.map((choice) => {
          // La recodificación guardada sigue aplicando si la columna mantiene su variable.
          const saved = savedByColumn.get(choice.column);
          const keepsVariable =
            saved !== undefined &&
            choice.choice === `${CANONICAL_PREFIX}${saved.canonicalVariableId}`;
          return {
            column: choice.column,
            type: choice.dataType,
            missingCodes: normalizeMissingCodes(choice.missingCodes),
            valueMap: keepsVariable ? toValueMap(saved.valueMap) : undefined,
          };
        }),
      );
      for (const [i, choice] of changed.entries()) {
        const bad = badByChoice[i];
        if (bad.length > 0) {
          throw new BadRequestException({
            code: 'value_type_mismatch',
            message: `Column "${choice.column}" has values that are not ${VALUE_TYPE_LABEL[choice.dataType]}: ${quoteList(bad)}.`,
            params: {
              source: 'column',
              column: choice.column,
              expectedType: choice.dataType,
              values: bad,
            },
          });
        }
      }
    }

    const wanted = new Map<string, ValueType>();
    for (const c of numeric) {
      const canonical = canonicalOf(c);
      if (canonical && canonical.dataType !== c.dataType)
        wanted.set(canonical.id, c.dataType);
    }
    if (wanted.size === 0) return;

    const others = await this.prisma.harmonizerMapping.findMany({
      where: {
        canonicalVariableId: { in: [...wanted.keys()] },
        datasetId: { not: dataset.id },
      },
      include: {
        dataset: {
          select: { id: true, name: true, columns: true, rowCount: true },
        },
        canonicalVariable: { select: { name: true } },
      },
      orderBy: { dataset: { year: 'asc' } },
    });
    for (const m of others) {
      const type = wanted.get(m.canonicalVariableId)!;
      const [bad] = await this.valuesNotFittingIn(m.dataset, [
        {
          column: m.sourceColumn,
          type,
          missingCodes: m.missingCodes,
          valueMap: toValueMap(m.valueMap),
        },
      ]);
      if (bad.length > 0) {
        throw new BadRequestException({
          code: 'value_type_mismatch',
          message: `Variable "${m.canonicalVariable.name}" is also used in edition "${m.dataset.name}" (column "${m.sourceColumn}"), which has values that are not ${VALUE_TYPE_LABEL[type]}: ${quoteList(bad)}.`,
          params: {
            source: 'other_edition',
            variable: m.canonicalVariable.name,
            edition: m.dataset.name,
            column: m.sourceColumn,
            expectedType: type,
            values: bad,
          },
        });
      }
    }
  }

  /**
   * Para cada revisión, los valores de la columna (sin los códigos de no especificado y ya
   * recodificados) que no caben en el tipo: como mucho 5, en orden de aparición. DuckDB los
   * busca en el Parquet; las filas no se cargan. Una columna que la edición no tiene no da
   * ninguno.
   */
  async valuesNotFittingIn(
    dataset: { id: string; columns: string[]; rowCount: number },
    checks: {
      column: string;
      type: ValueType;
      missingCodes: string[];
      valueMap?: Map<string, string>;
    }[],
  ): Promise<string[][]> {
    const out: string[][] = checks.map(() => []);
    const queried: number[] = [];
    const queries: string[] = [];
    for (const [i, check] of checks.entries()) {
      const position = dataset.columns.indexOf(check.column);
      if (position < 0 || dataset.rowCount === 0 || check.type === 'text')
        continue;
      queried.push(i);
      queries.push(
        notFittingQuery({
          rawColumn: `c${position}`,
          type: check.type,
          missingCodes: check.missingCodes,
          valueMap: check.valueMap,
        }),
      );
    }
    if (queries.length === 0) return out;
    const rows = await this.analysisService.runInternalQueries(
      await this.files.rawPath(dataset),
      queries,
    );
    queried.forEach((checkIndex, q) => {
      out[checkIndex] = readNotFitting(rows[q]);
    });
    return out;
  }

  /**
   * Tipos de varias columnas de una edición (ver column-checks.ts), en el mismo orden. Cada
   * resultado se guarda la primera vez (`HarmonizerColumnCheck`): los datos no cambian.
   */
  async columnTypeResults(
    dataset: { id: string; columns: string[] },
    checks: ColumnTypeCheck[],
  ): Promise<ColumnTypeResult[]> {
    if (checks.length === 0) return [];
    const rows = await cachedColumnChecks(
      this.prisma,
      this.analysisService,
      dataset.id,
      await this.files.rawPath(dataset),
      checks.map(columnTypeQuery),
    );
    return checks.map((check, i) => readColumnTypeResult(check, rows[i]));
  }
}
