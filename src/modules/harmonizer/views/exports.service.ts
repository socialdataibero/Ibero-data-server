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
  inferredType as inferredTypeOf,
  mergeFacts,
  notFittingQuery,
  readNotFitting,
  readValueFacts,
  valueFactsQuery,
  type TypeFacts,
} from '../column-checks.js';
import {
  editionCsvLinesSql,
  editionParquetSql,
  originalCsvLinesSql,
  surveyParquetSql,
  type ExportColumn,
} from '../harmonized-export.js';
import { neutralizeCsvFormula, type ValueType } from '../harmonized-view.js';
import {
  buildSourceMetadata,
  sourceMetadataFooter,
  type MetadataEdition,
  type SourceMetadata,
} from '../source-metadata.js';
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

/** Una edición lista para descargarse (ver `exportEdition`). */
export interface ExportEdition {
  dataset: EditionRecord;
  /** Su Parquet crudo; `null` si la edición no tiene columnas (H-08). */
  path: string | null;
  columns: ExportColumn[];
  /** Rol de diseño muestral de cada canónica que lo tiene. */
  roles: Map<string, string>;
}

/** Lo que los metadatos de la fuente necesitan de una edición y sus columnas en la vista. */
function metadataEdition(
  edition: ExportEdition,
  columns: ExportColumn[],
): MetadataEdition {
  return {
    id: edition.dataset.id,
    design: edition.dataset.design,
    unit: edition.dataset.unit,
    columns: columns.map((c) => ({
      canon: c.canon,
      missingCodes: c.missingCodes,
      role: edition.roles.get(c.canon) ?? null,
    })),
  };
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
    const metadata = buildSourceMetadata(
      [metadataEdition(edition, edition.columns)],
      headers,
      types,
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

  async exportSurvey(
    surveyId: string,
    fmt: string,
    variables: string | string[] | undefined,
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
    const sources = included.map((i, n) => ({
      alias: `e${n}`,
      path: i.edition.path!,
    }));
    const metadata = buildSourceMetadata(
      included.map((i) => metadataEdition(i.edition, i.columns)),
      ['_dataset', '_year', '_row', ...wanted],
      types,
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
      select: { name: true, dataType: true },
    });
    const confirmedByName = new Map(
      confirmed.map((c) => [c.name, c.dataType as ValueType | null]),
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
