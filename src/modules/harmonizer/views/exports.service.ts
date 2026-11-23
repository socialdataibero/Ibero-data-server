import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { stringify } from 'csv-stringify/sync';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, rm, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AnalysisService,
  type NamedSource,
  type ParquetColumnType,
} from '../../analysis/analysis.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import { cachedColumnChecks } from '../column-check-store.js';
import {
  codeCountQuery,
  inferredType as inferredTypeOf,
  mergeFacts,
  notFittingQuery,
  readCount,
  readNotFitting,
  readValueFacts,
  readValueList,
  valueFactsQuery,
  valuesAmongQuery,
  type TypeFacts,
} from '../column-checks.js';
import {
  editionCsvLinesSql,
  editionParquetSql,
  keptMissingCodes,
  originalCsvLinesSql,
  surveyParquetSql,
  type ExportColumn,
} from '../harmonized-export.js';
import { neutralizeCsvFormula, type ValueType } from '../harmonized-view.js';
import {
  buildSourceMetadata,
  sourceMetadataFooter,
  sourceSignature,
  type MetadataEdition,
  type MetadataVariable,
  type SourceMetadata,
} from '../source-metadata.js';
import { comparisonStatus } from '../comparison.js';
import { readCoverage } from '../harmonizer-types.js';
import { toCatalog } from '../editions/edition-reader.service.js';
import { VariablesService } from '../variables/variables.service.js';
import { variableCategories } from './metadata-categories.js';
import {
  EXPORT_CONTENT_TYPE,
  isExportFormat,
  type ExportFile,
  type ExportFormat,
} from '../export-file.js';
import { originalStorageKey } from '../edition-files.js';
import { EditionFilesService } from '../editions/edition-files.service.js';
import {
  EditionReaderService,
  type EditionMapping,
  type EditionRecord,
} from '../editions/edition-reader.service.js';
import { editionColumns } from '../editions/edition-reader.service.js';
import {
  VALUE_TYPE_LABEL,
  quoteList,
} from '../mapping/mapping-types.service.js';
import { safeFileBase } from '../export-file.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { readAnalysis, unconfirmedTypeOf } from '../variables/variable-role.js';

/** Una edición lista para descargarse (ver `exportEdition`). */
export interface ExportEdition {
  dataset: EditionRecord;
  /** Su Parquet crudo; `null` si la edición no tiene columnas (H-08). */
  path: string | null;
  columns: ExportColumn[];
  /** Rol de diseño muestral de cada canónica que lo tiene. */
  roles: Map<string, string>;
}

/**
 * Lo que los metadatos de la fuente necesitan de una edición y sus columnas en la vista. Una
 * columna que conserva sus códigos de no especificado los declara como quedan en el archivo
 * (recodificados); las demás, los de la fuente con cuántas celdas los tenían (`counts`).
 */
function metadataEdition(
  edition: ExportEdition,
  columns: ExportColumn[],
  counts: Map<string, number>,
): MetadataEdition {
  return {
    id: edition.dataset.id,
    name: edition.dataset.name,
    year: edition.dataset.year,
    design: edition.dataset.design,
    unit: edition.dataset.unit,
    coverage: readCoverage(edition.dataset.coverage),
    columns: columns.map((c) => {
      const areNull = !c.keepMissingCodes;
      return {
        canon: c.canon,
        missingCodes: areNull ? c.missingCodes : keptMissingCodes(c),
        missingCodesAreNull: areNull,
        ...(areNull && c.missingCodes.length > 0
          ? { missingCount: counts.get(c.canon) ?? 0 }
          : {}),
        role: edition.roles.get(c.canon) ?? null,
      };
    }),
  };
}

/** `409 missing_code_conflict`: see `ExportsService.assertMissingCodesAgree`. */
function missingCodeConflict(
  variable: string,
  code: string,
  missingIn: EditionRecord,
  validIn: EditionRecord,
): ConflictException {
  const edition = (e: EditionRecord) => ({ name: e.name, year: e.year });
  return new ConflictException({
    code: 'missing_code_conflict',
    message: `Code "${code}" of variable "${variable}" means "not specified" in edition "${missingIn.name}" (${missingIn.year}) but is a valid value in edition "${validIn.name}" (${validIn.year}). Recode it in one of them so the file has one meaning per code.`,
    params: {
      variable,
      code,
      missingIn: edition(missingIn),
      validIn: edition(validIn),
    },
  });
}

const PARQUET_TYPE: Record<ValueType, ParquetColumnType> = {
  text: 'VARCHAR',
  integer: 'BIGINT',
  decimal: 'DOUBLE',
};

/**
 * The downloads of the harmonizer: the harmonized view of an edition or a survey as CSV or typed
 * Parquet (with the source metadata in its footer), and the original file of an edition. Also
 * what "use in a dataset" saves as a resource.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly storage: LocalStorageService,
    private readonly lookup: HarmonizerLookupService,
    private readonly files: EditionFilesService,
    private readonly reader: EditionReaderService,
    private readonly variables: VariablesService,
  ) {}

  async exportDataset(datasetId: string, fmt: string): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const dataset = await this.lookup.getDataset(datasetId);
    const edition = await this.exportEdition(dataset);
    const file = {
      filename: `${safeFileBase(`harmonized_${dataset.name}_${dataset.year}`, 'harmonized')}.${format}`,
      contentType: EXPORT_CONTENT_TYPE[format],
    };
    const headers = edition.columns.map((c) => c.canon);
    if (format === 'csv') {
      return {
        ...file,
        ...(await this.csvLinesFile(
          headers,
          edition.path ? [{ alias: 'e0', path: edition.path }] : [],
          edition.path && headers.length > 0
            ? [editionCsvLinesSql('e0', edition.columns, headers)]
            : [],
        )),
      };
    }
    if (headers.length === 0 || !edition.path) {
      throw new BadRequestException({
        code: 'harmonized_view_empty',
        message:
          'There are no mapped variables to export as Parquet. Map at least one column.',
      });
    }
    const types = await this.exportTypes(dataset.surveyId, [edition], headers);
    const metadata = await this.sourceMetadata(
      dataset.surveyId,
      [{ edition, columns: edition.columns }],
      headers,
      types,
      dataset.id,
    );
    return {
      ...file,
      metadata,
      ...(await this.parquetExportFile(
        [{ alias: 'e0', path: edition.path }],
        [editionParquetSql('e0', edition.columns, types)],
        metadata,
      )),
    };
  }

  /**
   * With `forResource` ("use in a dataset"), a code that is «No especificado» in one edition and
   * a valid value in another stops the Parquet (`409 missing_code_conflict`): the resource keeps
   * one list of codes per column. The downloads are not stopped.
   */
  async exportSurvey(
    surveyId: string,
    fmt: string,
    variables: string | string[] | undefined,
    options: { forResource?: boolean } = {},
  ): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const survey = await this.lookup.getSurvey(surveyId);
    const { wanted } = await this.reader.surveySelection(surveyId, variables);
    const datasets = await this.reader.surveyEditions(surveyId);
    // Se revisan todas las ediciones (un archivo que falta da 404 aunque no se pidan sus
    // variables), pero solo aportan filas las que tienen alguna de las variables elegidas.
    const wantedSet = new Set(wanted);
    const included: { edition: ExportEdition; columns: ExportColumn[] }[] = [];
    for (const { mappings, ...dataset } of datasets) {
      const edition = await this.exportEdition(dataset, mappings);
      const columns = edition.columns.filter((c) => wantedSet.has(c.canon));
      if (columns.length > 0) included.push({ edition, columns });
    }
    const file = {
      filename: `${safeFileBase(`harmonized_${survey.name}`, 'harmonized')}.${format}`,
      contentType: EXPORT_CONTENT_TYPE[format],
    };

    if (format === 'csv') {
      return {
        ...file,
        ...(await this.csvLinesFile(
          ['_dataset', '_year', '_row', ...wanted],
          included.map((i, n) => ({ alias: `e${n}`, path: i.edition.path! })),
          included.map((i, n) =>
            editionCsvLinesSql(`e${n}`, i.columns, wanted, {
              name: i.edition.dataset.name,
              year: i.edition.dataset.year,
            }),
          ),
        )),
      };
    }

    const types = await this.exportTypes(
      survey.id,
      included.map((i) => ({ ...i.edition, columns: i.columns })),
      wanted,
    );
    if (options.forResource) await this.assertMissingCodesAgree(included);
    const sources = included.map((i, n) => ({
      alias: `e${n}`,
      path: i.edition.path!,
    }));
    const metadata = await this.sourceMetadata(
      survey.id,
      included,
      ['_dataset', '_year', '_row', ...wanted],
      types,
      null,
    );
    return {
      ...file,
      metadata,
      ...(await this.parquetExportFile(
        sources,
        surveyParquetSql(
          included.map((i, n) => ({
            source: sources[n].alias,
            name: i.edition.dataset.name,
            year: i.edition.dataset.year,
            columns: i.columns,
          })),
          wanted,
          types,
        ),
        metadata,
      )),
    };
  }

  /**
   * El CSV subido, regenerado desde lo guardado: todas las columnas, mapeadas
   * o no, con los valores tal como se leyeron. No aplica mapeo, códigos de "No
   * especificado" ni la neutralización de fórmulas de la vista armonizada.
   */
  async exportOriginal(datasetId: string): Promise<ExportFile> {
    const dataset = await this.lookup.getDataset(datasetId);
    const filename = `${safeFileBase(`original_${dataset.name}_${dataset.year}`, 'original')}.csv`;
    // Ediciones importadas por el worker: el archivo que se subió, byte por byte,
    // descomprimido mientras se envía. No pasa por memoria, así que no tiene límite de filas.
    const kept = this.storage.resolvePath(originalStorageKey(dataset.id));
    if (
      await access(kept).then(
        () => true,
        () => false,
      )
    ) {
      const gunzip = createGunzip();
      const file = createReadStream(kept);
      file.on('error', (err) => gunzip.destroy(err));
      // Descartado sin leerse (una descarga preparada que vence): suelta el archivo.
      gunzip.once('close', () => file.destroy());
      return {
        filename,
        contentType: EXPORT_CONTENT_TYPE.csv,
        body: file.pipe(gunzip),
      };
    }
    // Las demás se reconstruyen del Parquet: DuckDB escribe las líneas (ver harmonized-export.ts)
    // y el encabezado lo escribe csv-stringify. Un archivo vacío (H-08) no tiene Parquet.
    const path =
      dataset.columns.length > 0 ? await this.files.rawPath(dataset) : null;
    // El encabezado como arreglo: con objetos, csv-stringify leería `EDAD.1` como ruta anidada.
    const header = `\ufeff${stringify([dataset.columns])}`;
    return {
      filename,
      contentType: EXPORT_CONTENT_TYPE.csv,
      ...(await this.exportTempFile('csv', (dest) =>
        this.analysisService.writeInternalLines(
          path ? [{ alias: 'e0', path }] : [],
          path ? [originalCsvLinesSql('e0', dataset.columns)] : [],
          dest,
          header,
        ),
      )),
    };
  }

  private assertExportFormat(fmt: string): ExportFormat {
    const format = fmt.toLowerCase();
    if (!isExportFormat(format)) {
      throw new NotFoundException({
        code: 'export_format_not_supported',
        message: `Unsupported export format: "${fmt}". Use "csv" or "parquet".`,
        params: { format: fmt },
      });
    }
    return format;
  }

  /**
   * Las columnas de la vista de una edición (ver harmonized-export.ts) y su Parquet crudo, que
   * debe existir (`404 harmonizer_dataset_file_missing`). Una edición sin columnas (subida vacía,
   * H-08) no tiene Parquet: `path` es `null`.
   */
  private async exportEdition(
    dataset: EditionRecord,
    mappings?: EditionMapping[],
  ): Promise<ExportEdition> {
    const [used, path] = await Promise.all([
      mappings ?? this.reader.editionMappings(dataset.id),
      dataset.columns.length > 0 ? this.files.rawPath(dataset) : null,
    ]);
    return {
      dataset,
      path,
      roles: new Map(
        used.flatMap((m) =>
          m.role ? [[m.canonicalVariable.name, m.role] as const] : [],
        ),
      ),
      columns: editionColumns(dataset, used),
    };
  }

  /**
   * The source metadata of a harmonized view (version 2, `source-metadata.ts`): the survey, the
   * editions with their codes and counts, and per variable its label, use in analysis, categories
   * and (survey views) the state of its codes between editions, plus the signature of what defined
   * the view. `editionId` is the edition of an edition view, `null` for a survey view.
   */
  private async sourceMetadata(
    surveyId: string,
    included: { edition: ExportEdition; columns: ExportColumn[] }[],
    headers: string[],
    types: Record<string, ParquetColumnType>,
    editionId: string | null,
  ): Promise<SourceMetadata | null> {
    const survey = await this.lookup.getSurvey(surveyId);
    const editions: MetadataEdition[] = [];
    for (const i of included) {
      editions.push(
        metadataEdition(i.edition, i.columns, await this.missingCounts(i.edition, i.columns)),
      );
    }
    const names = [...new Set(included.flatMap((i) => i.columns.map((c) => c.canon)))];
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, name: { in: names } },
    });
    const comparisons = await this.variables.variableComparisons(
      surveyId,
      canonicals.map((c) => c.id),
    );
    const variables = new Map<string, MetadataVariable>();
    for (const c of canonicals) {
      const inView = new Set(
        included.filter((i) => i.columns.some((col) => col.canon === c.name)).map((i) => i.edition.dataset.id),
      );
      const found = comparisons.get(c.id);
      const keep = (_: unknown, n: number) => inView.has(found!.inputs[n].datasetId);
      const analysis = readAnalysis(c);
      const missingCodes = [
        ...new Set(editions.flatMap((e) => e.columns.find((col) => col.canon === c.name)?.missingCodes ?? [])),
      ];
      variables.set(c.name, {
        label: c.description?.trim() || null,
        analysis,
        categories: found
          ? variableCategories(
              analysis.role,
              toCatalog(c.categories),
              found.inputs.filter(keep),
              found.comparison.editions.filter(keep),
              missingCodes,
            )
          : [],
        codeReview:
          editionId === null && found
            ? comparisonStatus(found.comparison, c.reviewedSignature)
            : null,
      });
    }
    const variableNames = headers.filter((h) => !h.startsWith('_'));
    return buildSourceMetadata({
      survey: { name: survey.name, shortName: survey.shortName },
      editions,
      variables,
      headers,
      types,
      origin: {
        surveyId,
        editionId,
        variables: variableNames,
        signature: (await this.originSignature(surveyId, editionId, variableNames))!,
      },
    });
  }

  /**
   * The signature of a harmonized view as the harmonizer has it now: a hash of the survey's name
   * and short name, and of the editions of the view (an edition view: that edition; a survey view:
   * every edition that maps one of `variables`) with their files, design, unit, coverage,
   * dictionary and their mappings of `variables` (codes, recoding, sample role), and of those
   * canonical variables (description, type, catalog, review, use in analysis). It reads only the
   * database. `null` when the survey or the edition no longer exists.
   */
  async originSignature(
    surveyId: string,
    editionId: string | null,
    variables: string[],
  ): Promise<string | null> {
    const survey = await this.prisma.harmonizerSurvey.findUnique({ where: { id: surveyId } });
    if (!survey) return null;
    const wanted = new Set(variables);
    const all = await this.reader.surveyEditions(surveyId);
    const editions = editionId
      ? all.filter((e) => e.id === editionId)
      : all.filter((e) => e.mappings.some((m) => wanted.has(m.canonicalVariable.name)));
    if (editionId && editions.length === 0) return null;
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, name: { in: variables } },
      orderBy: { name: 'asc' },
    });
    const sortedEntries = (json: unknown) =>
      json && typeof json === 'object' && !Array.isArray(json)
        ? Object.entries(json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        : [];
    return sourceSignature({
      survey: [survey.name, survey.shortName],
      variables,
      editions: editions.map((e) => [
        e.id,
        e.name,
        e.year,
        e.columns,
        e.design,
        e.unit,
        e.coverage,
        e.codebookId,
        e.codebookTable,
        e.mappings
          .filter((m) => wanted.has(m.canonicalVariable.name))
          .sort((a, b) => (a.sourceColumn < b.sourceColumn ? -1 : a.sourceColumn > b.sourceColumn ? 1 : 0))
          .map((m) => [m.sourceColumn, m.canonicalVariable.name, m.missingCodes, sortedEntries(m.valueMap), m.role]),
      ]),
      canonicals: canonicals.map((c) => [
        c.name,
        c.description,
        c.dataType,
        c.categories,
        c.reviewedSignature,
        c.role,
        c.universe,
        c.positiveValue,
        c.geoLevel,
        c.unit,
        c.disaggregation,
      ]),
    });
  }

  /**
   * Por canónica, cuántas celdas de la edición tenían un código de no especificado en las
   * columnas que lo vuelven `NULL` (medidas y sin rol, D13). Se guarda como las demás revisiones
   * de columna: los datos de una edición no cambian.
   */
  private async missingCounts(
    edition: ExportEdition,
    columns: ExportColumn[],
  ): Promise<Map<string, number>> {
    const counted = columns.filter(
      (c) => !c.keepMissingCodes && c.missingCodes.length > 0,
    );
    if (!edition.path || counted.length === 0) return new Map();
    const rows = await cachedColumnChecks(
      this.prisma,
      this.analysisService,
      edition.dataset.id,
      edition.path,
      counted.map((c) => codeCountQuery(c.rawColumn, c.missingCodes)),
    );
    return new Map(counted.map((c, i) => [c.canon, readCount(rows[i])]));
  }

  /**
   * In the columns that keep their «No especificado» codes, a code of one edition must not be a
   * valid value (after recoding) of another: the resource keeps one list of codes per column, so
   * the file would call valid answers "not specified" (`409 missing_code_conflict`, the first one
   * found, in the order of the editions).
   */
  private async assertMissingCodesAgree(
    included: { edition: ExportEdition; columns: ExportColumn[] }[],
  ): Promise<void> {
    const codesByCanon = new Map<string, { edition: EditionRecord; codes: string[] }[]>();
    for (const { edition, columns } of included) {
      for (const c of columns) {
        const codes = keptMissingCodes(c);
        if (codes.length === 0) continue;
        codesByCanon.set(c.canon, [
          ...(codesByCanon.get(c.canon) ?? []),
          { edition: edition.dataset, codes },
        ]);
      }
    }
    if (codesByCanon.size === 0) return;
    for (const { edition, columns } of included) {
      if (!edition.path) continue;
      const checks = columns.flatMap((c) => {
        const own = new Set(keptMissingCodes(c));
        const others = (codesByCanon.get(c.canon) ?? []).filter(
          (o) => o.edition.id !== edition.dataset.id,
        );
        const codes = [
          ...new Set(others.flatMap((o) => o.codes.filter((code) => !own.has(code)))),
        ];
        return c.keepMissingCodes && codes.length > 0
          ? [{ column: c, others, codes }]
          : [];
      });
      if (checks.length === 0) continue;
      const rows = await cachedColumnChecks(
        this.prisma,
        this.analysisService,
        edition.dataset.id,
        edition.path,
        checks.map(({ column, codes }) =>
          valuesAmongQuery({
            rawColumn: column.rawColumn,
            missingCodes: column.missingCodes,
            valueMap: column.valueMap,
            codes,
          }),
        ),
      );
      checks.forEach(({ column, others }, i) => {
        const [code] = readValueList(rows[i]);
        if (code === undefined) return;
        const missingIn = others.find((o) => o.codes.includes(code))!.edition;
        throw missingCodeConflict(column.canon, code, missingIn, edition.dataset);
      });
    }
  }

  /**
   * Tipo de cada columna en el Parquet: el confirmado en la variable canónica o, si no hay, el
   * que infieren los valores exportados de todas las ediciones. DuckDB revisa los valores sobre
   * cada Parquet (ver column-checks.ts); las filas no se cargan. Las de origen son fijas.
   */
  private async exportTypes(
    surveyId: string,
    editions: ExportEdition[],
    headers: string[],
  ): Promise<Record<string, ParquetColumnType>> {
    const confirmed = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, name: { in: headers } },
      select: { name: true, dataType: true, role: true },
    });
    // A variable of codes (category, geographic…) with no confirmed type stays text, so `001`
    // is not downloaded as `1` (variables/variable-role.ts).
    const confirmedByName = new Map(
      confirmed.map((c) => [
        c.name,
        (c.dataType as ValueType | null) ?? unconfirmedTypeOf(c.role),
      ]),
    );

    const headerSet = new Set(headers);
    const facts = new Map<string, TypeFacts[]>();
    const bad = new Map<string, string[]>();
    for (const edition of editions) {
      if (!edition.path) continue;
      const columns = edition.columns.filter((c) => headerSet.has(c.canon));
      const toInfer = columns.filter((c) => !confirmedByName.get(c.canon));
      const toCheck = columns.filter((c) => {
        const type = confirmedByName.get(c.canon);
        return type === 'integer' || type === 'decimal';
      });
      const factRows = await cachedColumnChecks(
        this.prisma,
        this.analysisService,
        edition.dataset.id,
        edition.path,
        toInfer.map(valueFactsQuery),
      );
      toInfer.forEach((c, i) => {
        facts.set(c.canon, [
          ...(facts.get(c.canon) ?? []),
          readValueFacts(factRows[i]),
        ]);
      });
      const badRows = await this.analysisService.runInternalQueries(
        edition.path,
        toCheck.map((c) =>
          notFittingQuery({
            rawColumn: c.rawColumn,
            type: confirmedByName.get(c.canon)!,
            missingCodes: c.missingCodes,
            valueMap: c.valueMap,
          }),
        ),
      );
      // Ediciones en orden: los primeros valores de cada una son los primeros de la descarga.
      toCheck.forEach((c, i) => {
        bad.set(c.canon, [
          ...(bad.get(c.canon) ?? []),
          ...readNotFitting(badRows[i]),
        ]);
      });
    }

    const types: Record<string, ParquetColumnType> = {
      _dataset: 'VARCHAR',
      _year: 'BIGINT',
      _row: 'BIGINT',
    };
    for (const header of headers) {
      const type =
        confirmedByName.get(header) ??
        inferredTypeOf(mergeFacts(facts.get(header) ?? []));
      // El mapeo ya valida al guardar; esto cubre ediciones mapeadas sin enviar tipo.
      const values = [...new Set(bad.get(header) ?? [])].slice(0, 5);
      if (values.length > 0) {
        throw new ConflictException({
          code: 'value_type_mismatch',
          message: `The confirmed type of variable "${header}" requires ${VALUE_TYPE_LABEL[type]}, but it has values that are not: ${quoteList(values)}.`,
          params: {
            source: 'confirmed_type',
            variable: header,
            expectedType: type,
            values,
          },
        });
      }
      types[header] = PARQUET_TYPE[type];
    }
    return types;
  }

  /**
   * El CSV de una vista armonizada: el BOM y el encabezado (con neutralización de fórmulas) los
   * escribe csv-stringify, como antes; las filas las escribe DuckDB, ya como líneas de CSV, una
   * parte (edición) tras otra. Las filas no pasan por JavaScript.
   */
  private csvLinesFile(
    columns: string[],
    sources: NamedSource[],
    parts: string[],
  ): Promise<Pick<ExportFile, 'body' | 'size'>> {
    const header = `\ufeff${stringify([], {
      header: true,
      columns: columns.map((key) => ({
        key,
        header: neutralizeCsvFormula(key),
      })),
      cast: { number: (n) => String(n), string: neutralizeCsvFormula },
    })}`;
    return this.exportTempFile('csv', (path) =>
      this.analysisService.writeInternalLines(sources, parts, path, header),
    );
  }

  /** The Parquet of a harmonized view, with its source metadata in the footer when it has any. */
  private parquetExportFile(
    sources: NamedSource[],
    parts: string[],
    metadata: SourceMetadata | null,
  ): Promise<Pick<ExportFile, 'body' | 'size'>> {
    return this.exportTempFile('parquet', (path) =>
      this.analysisService.copyInternalQueryToParquet(
        sources,
        parts,
        path,
        sourceMetadataFooter(metadata),
      ),
    );
  }

  /**
   * Escribe la descarga completa en un archivo temporal y la devuelve como stream, con su
   * tamaño. El stream borra el archivo al cerrarse (también si el cliente corta o si se
   * descarta sin leerlo). Un error al escribir llega antes de mandar nada, con su código.
   */
  private async exportTempFile(
    ext: ExportFormat,
    write: (path: string) => Promise<unknown>,
  ): Promise<Pick<ExportFile, 'body' | 'size'>> {
    const path = join(tmpdir(), `ibero-harmonized-${randomUUID()}.${ext}`);
    try {
      await write(path);
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    const { size } = await stat(path);
    const body = createReadStream(path);
    body.once('close', () => void rm(path, { force: true }));
    return { body, size };
  }
}
