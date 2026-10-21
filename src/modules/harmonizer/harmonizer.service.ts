import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AnalysisService,
  type ParquetColumnType,
} from '../analysis/analysis.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { asciiFold, matchByName, parseVariables } from './matching.js';
import {
  buildDatasetView,
  buildSurveyView,
  inferValueType,
  neutralizeCsvFormula,
  sourceColumnValues,
  valuesNotFitting,
  type DatasetEdition,
  type HarmonizedView,
  type RawData,
  type ValueType,
} from './harmonized-view.js';
import {
  NEW_SURVEY,
  type UploadDatasetDto,
  type UploadEncoding,
} from './dto/upload-dataset.dto.js';
import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from './dto/mapping-choice.dto.js';
import type { CreateSurveyDto } from './dto/create-survey.dto.js';
import type { UpdateSurveyDto } from './dto/update-survey.dto.js';
import type { SaveMappingDto } from './dto/save-mapping.dto.js';
import type { RenameCanonicalVariableDto } from './dto/rename-canonical-variable.dto.js';
import { canonicalNameProblem, sameCanonicalName } from './canonical-name.js';
import {
  DbfError,
  readDbf,
  type DbfEncoding,
  type DbfEncodingSource,
} from './dbf.js';

export interface SurveyDatasetSummary {
  id: string;
  name: string;
  year: number;
  rowCount: number;
  mappedColumns: number;
  totalColumns: number;
}

export interface SurveySummary {
  id: string;
  name: string;
  description: string | null;
  datasets: SurveyDatasetSummary[];
}

export interface ListSurveysParams {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

export interface DatasetInfo {
  id: string;
  name: string;
  year: number;
  surveyId: string;
  surveyName: string;
  // Filas de datos leídas del archivo, sin contar el encabezado ni, en un DBF,
  // los registros borrados (H-09).
  rowCount: number;
  // Columnas del archivo, mapeadas o no (H-18).
  columnCount: number;
}

export interface ViewPageParams {
  limit?: number;
  offset?: number;
}

export interface ViewPage {
  limit: number;
  offset: number;
}

// Filas por página de las vistas en pantalla. La web ofrece 50, 100 y 500.
const DEFAULT_VIEW_LIMIT = 100;
const MAX_VIEW_LIMIT = 500;

function viewPage(params: ViewPageParams): ViewPage {
  const limit =
    params.limit === undefined || !Number.isFinite(params.limit)
      ? DEFAULT_VIEW_LIMIT
      : Math.min(Math.max(Math.trunc(params.limit), 1), MAX_VIEW_LIMIT);
  const offset =
    params.offset === undefined || !Number.isFinite(params.offset)
      ? 0
      : Math.max(Math.trunc(params.offset), 0);
  return { limit, offset };
}

interface EditionRecord {
  id: string;
  name: string;
  year: number;
  columns: string[];
}

interface EditionMapping {
  sourceColumn: string;
  missingCodes: string[];
  canonicalVariable: { name: string };
}

function toEdition(
  dataset: EditionRecord,
  mappings: EditionMapping[],
  rows: RawData[],
): DatasetEdition {
  return {
    name: dataset.name,
    year: dataset.year,
    columns: dataset.columns,
    columnToCanonical: new Map(
      mappings.map((m) => [m.sourceColumn, m.canonicalVariable.name]),
    ),
    missingCodes: new Map(
      mappings.map((m) => [m.sourceColumn, new Set(m.missingCodes)]),
    ),
    rows,
  };
}

export type SuggestionSource = 'history' | 'name';

export interface MappingColumn {
  name: string;
  selectedCanonicalId: string | null;
  suggested: string | null;
  suggestionSource: SuggestionSource | null;
  missingCodes: string[];
  // Tipo que sugieren los valores de esta edición, con sus códigos guardados.
  inferredType: ValueType;
}

export interface CanonicalVariableInfo {
  id: string;
  name: string;
  // `null` = nadie lo ha confirmado todavía.
  dataType: ValueType | null;
}

export type ExportFormat = 'csv' | 'parquet';

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

function safeFileBase(name: string, fallback: string): string {
  return (
    asciiFold(name)
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_.-]/g, '') || fallback
  );
}

// Cada edición se guarda una sola vez como Parquet todo-VARCHAR. Guardarla como
// un JSON por fila repetía el nombre de cada columna en cada fila (H-31).
function rawStorageKey(datasetId: string): string {
  return `harmonizer/${datasetId}.parquet`;
}

// Las columnas del Parquet crudo son posicionales (`c0`, `c1`, …) y los nombres
// reales viven en `HarmonizerDataset.columns`. DuckDB no distingue mayúsculas en
// los identificadores, así que `EDAD` y `edad` chocarían como nombres de columna.
function rawColumnNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `c${i}`);
}

const PARQUET_TYPE: Record<ValueType, ParquetColumnType> = {
  text: 'VARCHAR',
  integer: 'BIGINT',
  decimal: 'DOUBLE',
};

const VALUE_TYPE_LABEL: Record<ValueType, string> = {
  text: 'texto',
  integer: 'números enteros',
  decimal: 'números',
};

function quoteList(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
};

function isExportFormat(fmt: string): fmt is ExportFormat {
  return fmt === 'csv' || fmt === 'parquet';
}

export interface RenamedColumn {
  // Posición de la columna en el archivo, empezando en 1.
  position: number;
  original: string;
  renamed: string;
}

// Cómo se leyó el archivo subido, para que el cliente avise al usuario. No se guarda.
export type UploadSource =
  | { format: 'csv' }
  | {
      format: 'dbf';
      encoding: DbfEncoding;
      encodingSource: DbfEncodingSource;
      deletedRecords: number;
    };

interface ParsedUpload {
  columns: string[];
  rows: RawData[];
  renamed: RenamedColumn[];
  source: UploadSource;
}

// Los encabezados repetidos se renombran con `.1`, `.2`, … y se informa al
// usuario (H-10). El sufijo salta los nombres que ya existen en el archivo:
// con `EDAD, EDAD, EDAD.1` la segunda pasa a `EDAD.2`, no a otro `EDAD.1`.
function dedupeHeaders(headers: string[]): {
  columns: string[];
  renamed: RenamedColumn[];
} {
  const taken = new Set(headers);
  const seen = new Set<string>();
  const renamed: RenamedColumn[] = [];
  const columns = headers.map((h, i) => {
    if (!seen.has(h)) {
      seen.add(h);
      return h;
    }
    let n = 1;
    while (taken.has(`${h}.${n}`)) n++;
    const name = `${h}.${n}`;
    taken.add(name);
    renamed.push({ position: i + 1, original: h, renamed: name });
    return name;
  });
  return { columns, renamed };
}

// Si la elección asigna una canónica (existente o nueva con nombre).
function isMappedChoice(choice: MappingChoiceDto): boolean {
  if (choice.choice.startsWith(CANONICAL_PREFIX)) return true;
  return choice.choice === NEW_CANONICAL && (choice.newName?.trim() ?? '') !== '';
}

// Se recortan, se descartan vacíos y repetidos: el valor de la celda también se
// compara recortado (ver harmonized-view.ts).
function normalizeMissingCodes(codes: string[] | undefined): string[] {
  return [
    ...new Set((codes ?? []).map((c) => c.trim()).filter((c) => c !== '')),
  ];
}

function datasetNameTaken(name: string, surveyName: string) {
  return new ConflictException({
    code: 'dataset_name_taken',
    message: `La encuesta «${surveyName}» ya tiene una edición llamada «${name}». Usa otro nombre.`,
  });
}

// Un archivo que no es UTF-8 (p. ej. Latin-1) se decodificaría con U+FFFD en
// lugar de cada carácter acentuado, y el byte original se perdería para siempre.
function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const lossy = new TextDecoder('utf-8').decode(buffer);
    const line = lossy.slice(0, lossy.indexOf('\uFFFD')).split('\n').length;
    throw new BadRequestException({
      code: 'csv_not_utf8',
      message: `El archivo no está en UTF-8 y sus acentos se perderían (el primer carácter que no se puede leer está en la línea ${line}). Vuelve a guardarlo como «CSV UTF-8» y súbelo de nuevo.`,
    });
  }
}

/**
 * Mensaje en español para un CSV que no se pudo leer (H-07). Dice la línea y qué revisar, en
 * lugar de la regla interna del lector («Invalid Opening Quote»). `lastRecordLine` es la línea
 * donde terminó la última fila leída bien.
 */
function csvErrorMessage(err: unknown, lastRecordLine: number): string {
  const info = (err ?? {}) as {
    code?: string;
    lines?: number;
    record?: unknown[];
    columns?: unknown[];
  };
  switch (info.code) {
    case 'CSV_QUOTE_NOT_CLOSED':
      return `Hay un dato que abre comillas (") y nunca las cierra, a partir de la línea ${lastRecordLine + 1}. Un dato que empieza con comillas debe terminar con comillas; las comillas dentro de él se escriben dobles ("").`;
    case 'CSV_RECORD_INCONSISTENT_COLUMNS':
      if (info.record && info.columns) {
        return `La fila de la línea ${info.lines} tiene ${info.record.length} columnas y el encabezado tiene ${info.columns.length}. Revisa esa fila: puede faltar o sobrar una coma, un dato con comas debe ir entre comillas, o puede haber una comilla sin cerrar en la fila.`;
      }
      break;
  }
  const where = info.lines ? ` cerca de la línea ${info.lines}` : '';
  return `No se pudo leer el archivo como CSV${where}. Revisa que esté separado por comas y que cada dato entre comillas abra y cierre sus comillas.`;
}

@Injectable()
export class HarmonizerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly storage: LocalStorageService,
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

  async createSurvey(dto: CreateSurveyDto) {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException({
        code: 'survey_name_required',
        message: 'El nombre de la encuesta no puede quedar vacío.',
      });
    }
    const existing = await this.prisma.harmonizerSurvey.findUnique({
      where: { name },
    });
    if (existing) {
      throw new ConflictException({
        code: 'survey_name_taken',
        message: `Ya existe una encuesta llamada «${name}».`,
      });
    }
    const created = await this.prisma.harmonizerSurvey.create({
      data: { name, description: dto.description?.trim() || null },
    });
    return this.toSurveyDto(created);
  }

  async getSurvey(surveyId: string) {
    const survey = await this.prisma.harmonizerSurvey.findUnique({
      where: { id: surveyId },
    });
    if (!survey) {
      throw new NotFoundException({
        code: 'survey_not_found',
        message: 'La encuesta no existe.',
      });
    }
    return survey;
  }

  async removeSurvey(surveyId: string): Promise<void> {
    await this.getSurvey(surveyId);
    const datasets = await this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      select: { id: true },
    });
    // Las ediciones, los mapeos y las canónicas se borran en cascada; los
    // Parquet crudos no, porque viven en disco.
    await this.prisma.harmonizerSurvey.delete({ where: { id: surveyId } });
    await Promise.all(
      datasets.map((d) => this.storage.remove(rawStorageKey(d.id))),
    );
  }

  async listCanonicalVariables(surveyId: string) {
    const survey = await this.getSurvey(surveyId);
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
    return {
      survey: { id: survey.id, name: survey.name },
      items: variables.map((v) => ({
        id: v.id,
        name: v.name,
        dataType: v.dataType,
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

  private async getCanonicalVariable(surveyId: string, variableId: string) {
    await this.getSurvey(surveyId);
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
        message: 'La variable no existe en esta encuesta.',
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
        message: `El nombre «${name}» no es válido, ${problem}.`,
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
        message: `Ya existe la variable «${clash.name}» en esta encuesta (los nombres no distinguen mayúsculas).`,
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
      const usages = variable.mappings
        .map((m) => `«${m.dataset.name}» (columna «${m.sourceColumn}»)`)
        .join(', ');
      throw new ConflictException({
        code: 'canonical_variable_in_use',
        message: `La variable «${variable.name}» está mapeada en ${usages}. Quita esos mapeos antes de borrarla.`,
      });
    }
    await this.prisma.harmonizerCanonicalVariable.delete({
      where: { id: variable.id },
    });
  }

  async updateSurvey(surveyId: string, dto: UpdateSurveyDto) {
    const survey = await this.getSurvey(surveyId);
    const data: Prisma.HarmonizerSurveyUpdateInput = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException({
          code: 'survey_name_required',
          message: 'El nombre de la encuesta no puede quedar vacío.',
        });
      }
      if (name !== survey.name) {
        const existing = await this.prisma.harmonizerSurvey.findUnique({
          where: { name },
        });
        if (existing) {
          throw new ConflictException({
            code: 'survey_name_taken',
            message: `Ya existe una encuesta llamada «${name}».`,
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
  }) {
    return {
      id: survey.id,
      name: survey.name,
      description: survey.description,
    };
  }

  async uploadDataset(
    dto: UploadDatasetDto,
    file: { originalname: string; buffer: Buffer },
  ): Promise<{
    datasetId: string;
    dataset: DatasetInfo;
    renamedColumns: RenamedColumn[];
    source: UploadSource;
  }> {
    // Se valida el archivo antes de crear la encuesta nueva (`__new__`), para
    // que un archivo rechazado no deje una encuesta vacía.
    const { columns, rows, renamed, source } = /\.dbf$/i.test(file.originalname)
      ? this.parseDbf(file.buffer, dto.encoding)
      : { ...this.parseCsv(file.buffer), source: { format: 'csv' as const } };
    const name = dto.name.trim();
    if (dto.surveyId !== NEW_SURVEY) {
      await this.assertDatasetNameFree(dto.surveyId, name);
    }
    const survey = await this.resolveSurveyForUpload(dto);

    // El Parquet se escribe antes que la edición: si falla, no queda una
    // edición sin datos; si falla la edición, se borra el Parquet.
    const datasetId = randomUUID();
    const key = rawStorageKey(datasetId);
    if (columns.length > 0) {
      const positional = rawColumnNames(columns.length);
      await this.storage.ensureDir(key);
      await this.analysisService.writeRowsToParquet(
        positional,
        rows.map((row) =>
          Object.fromEntries(columns.map((col, i) => [positional[i], row[col]])),
        ),
        this.storage.resolvePath(key),
      );
    }

    let dataset;
    try {
      dataset = await this.prisma.harmonizerDataset.create({
        data: {
          id: datasetId,
          surveyId: survey.id,
          name,
          year: dto.year,
          columns,
          rowCount: rows.length,
        },
      });
    } catch (err) {
      await this.storage.remove(key);
      // Dos subidas simultáneas con el mismo nombre: la restricción única gana.
      if ((err as { code?: string }).code === 'P2002') {
        throw datasetNameTaken(name, survey.name);
      }
      throw err;
    }

    return {
      datasetId: dataset.id,
      dataset: {
        id: dataset.id,
        name: dataset.name,
        year: dataset.year,
        surveyId: survey.id,
        surveyName: survey.name,
        rowCount: dataset.rowCount,
        columnCount: dataset.columns.length,
      },
      renamedColumns: renamed,
      source,
    };
  }

  // `_dataset` en la vista por encuesta es el nombre de la edición: si se
  // repitiera, sus filas serían indistinguibles (H-05).
  private async assertDatasetNameFree(surveyId: string, name: string) {
    const existing = await this.prisma.harmonizerDataset.findFirst({
      where: { surveyId, name },
      include: { survey: { select: { name: true } } },
    });
    if (existing) throw datasetNameTaken(name, existing.survey.name);
  }

  private async resolveSurveyForUpload(dto: UploadDatasetDto) {
    if (dto.surveyId !== NEW_SURVEY) {
      return this.getSurvey(dto.surveyId);
    }
    const name = dto.newSurvey?.trim() ?? '';
    if (!name) {
      throw new BadRequestException({
        code: 'new_survey_name_required',
        message: 'Escribe el nombre de la encuesta nueva (campo «newSurvey»).',
      });
    }
    return this.createSurvey({ name });
  }

  private parseDbf(
    buffer: Buffer,
    encoding: UploadEncoding | undefined,
  ): ParsedUpload {
    let table;
    try {
      table = readDbf(buffer, encoding === 'auto' ? undefined : encoding);
    } catch (err) {
      if (err instanceof DbfError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }
    if (table.rows.length === 0) {
      throw new BadRequestException({
        code: 'dbf_no_rows',
        message:
          'El archivo DBF no tiene registros, o todos están marcados como borrados. Sube un archivo con al menos un registro.',
      });
    }
    const { columns, renamed } = dedupeHeaders(table.headers);
    return {
      columns,
      rows: table.rows.map((values) =>
        Object.fromEntries(columns.map((col, i) => [col, values[i]])),
      ),
      renamed,
      source: {
        format: 'dbf',
        encoding: table.encoding,
        encodingSource: table.encodingSource,
        deletedRecords: table.deletedRecords,
      },
    };
  }

  private parseCsv(buffer: Buffer): {
    columns: string[];
    rows: RawData[];
    renamed: RenamedColumn[];
  } {
    const text = decodeUtf8(buffer);
    let columns: string[] = [];
    let renamed: RenamedColumn[] = [];
    let rows: RawData[];
    let lastRecordLine = 1;
    try {
      rows = parse(text, {
        bom: true,
        columns: (header: string[]) => {
          // Se recortan antes de deduplicar: `EDAD␣` y `EDAD` serían columnas
          // distintas en la base aunque en pantalla se vean iguales.
          ({ columns, renamed } = dedupeHeaders(header.map((h) => h.trim())));
          return columns;
        },
        skip_empty_lines: true,
        trim: false,
        cast: false,
        // Una comilla dentro de un dato sin entrecomillar (`{"clave":1}`, `5" pantalla`) se
        // conserva tal cual, como en pandas o Polars, en vez de rechazar el archivo (H-07).
        relax_quotes: true,
        on_record: (record: RawData, context: { lines: number }) => {
          lastRecordLine = context.lines;
          return record;
        },
      }) as RawData[];
    } catch (err) {
      throw new BadRequestException({
        code: 'csv_invalid',
        message: csvErrorMessage(err, lastRecordLine),
      });
    }
    // Una edición sin filas no aporta datos, pero sí permitiría crear
    // variables canónicas permanentes en la encuesta (H-08). Una línea con
    // solo espacios se lee como un encabezado de nombres vacíos.
    if (rows.length === 0 && columns.every((c) => c === '')) {
      throw new BadRequestException({
        code: 'csv_empty',
        message:
          'El archivo está vacío: no tiene encabezado ni datos. Revisa que sea el archivo correcto.',
      });
    }
    if (rows.length === 0) {
      throw new BadRequestException({
        code: 'csv_no_rows',
        message:
          'El archivo solo tiene encabezado y ninguna fila de datos. Sube un archivo con al menos una fila.',
      });
    }
    return { columns, rows, renamed };
  }

  async getDataset(datasetId: string) {
    const dataset = await this.prisma.harmonizerDataset.findUnique({
      where: { id: datasetId },
      include: { survey: true },
    });
    if (!dataset) {
      throw new NotFoundException({
        code: 'harmonizer_dataset_not_found',
        message: 'La edición no existe.',
      });
    }
    return dataset;
  }

  async removeDataset(datasetId: string): Promise<void> {
    await this.getDataset(datasetId);
    // Los mapeos se borran en cascada. Las canónicas se conservan (con su tipo
    // confirmado) para reutilizarlas al volver a subir la edición; las que ya no
    // mapea ninguna edición dejan de salir en la vista por encuesta.
    await this.prisma.harmonizerDataset.delete({ where: { id: datasetId } });
    await this.storage.remove(rawStorageKey(datasetId));
  }

  private toDatasetInfo(dataset: {
    id: string;
    name: string;
    year: number;
    surveyId: string;
    rowCount: number;
    columns: string[];
    survey: { name: string };
  }): DatasetInfo {
    return {
      id: dataset.id,
      name: dataset.name,
      year: dataset.year,
      surveyId: dataset.surveyId,
      surveyName: dataset.survey.name,
      rowCount: dataset.rowCount,
      columnCount: dataset.columns.length,
    };
  }

  async getMapping(datasetId: string): Promise<{
    dataset: DatasetInfo;
    columns: MappingColumn[];
    canonicalVariables: CanonicalVariableInfo[];
  }> {
    const dataset = await this.getDataset(datasetId);

    const [canonicals, saved, historical, rawRows] = await Promise.all([
      this.prisma.harmonizerCanonicalVariable.findMany({
        where: { surveyId: dataset.surveyId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, dataType: true },
      }),
      this.prisma.harmonizerMapping.findMany({ where: { datasetId } }),
      this.prisma.harmonizerMapping.findMany({
        where: {
          datasetId: { not: datasetId },
          sourceColumn: { in: dataset.columns },
          dataset: { surveyId: dataset.surveyId },
        },
      }),
      this.readRawRows(dataset),
    ]);

    const nameById = new Map(canonicals.map((c) => [c.id, c.name]));
    const savedByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.canonicalVariableId]),
    );
    const savedCodesByColumn = new Map(
      saved.map((m) => [m.sourceColumn, m.missingCodes]),
    );
    const historicalByColumn = new Map<string, string>();
    for (const m of historical) {
      if (!historicalByColumn.has(m.sourceColumn))
        historicalByColumn.set(m.sourceColumn, m.canonicalVariableId);
    }

    // Una canónica ya asignada (o ya sugerida) a otra columna de este archivo
    // no se vuelve a sugerir: dos columnas a la misma canónica colisionan.
    const usedIds = new Set(savedByColumn.values());

    const columns = dataset.columns.map((name): MappingColumn => {
      const inferredType = inferValueType(
        sourceColumnValues(
          rawRows,
          name,
          new Set(savedCodesByColumn.get(name) ?? []),
        ),
      );
      const savedId = savedByColumn.get(name);
      if (savedId) {
        return {
          name,
          selectedCanonicalId: savedId,
          suggested: null,
          suggestionSource: null,
          missingCodes: savedCodesByColumn.get(name) ?? [],
          inferredType,
        };
      }
      const historicalId = historicalByColumn.get(name);
      if (historicalId && !usedIds.has(historicalId)) {
        usedIds.add(historicalId);
        return {
          name,
          selectedCanonicalId: historicalId,
          suggested: nameById.get(historicalId) ?? null,
          suggestionSource: 'history',
          missingCodes: [],
          inferredType,
        };
      }
      const matchedId = matchByName(
        name,
        canonicals.filter((c) => !usedIds.has(c.id)),
      );
      if (matchedId) {
        usedIds.add(matchedId);
        return {
          name,
          selectedCanonicalId: matchedId,
          suggested: nameById.get(matchedId) ?? null,
          suggestionSource: 'name',
          missingCodes: [],
          inferredType,
        };
      }
      return {
        name,
        selectedCanonicalId: null,
        suggested: null,
        suggestionSource: null,
        missingCodes: [],
        inferredType,
      };
    });

    return {
      dataset: this.toDatasetInfo(dataset),
      columns,
      canonicalVariables: canonicals.map((c) => ({
        id: c.id,
        name: c.name,
        dataType: c.dataType as ValueType | null,
      })),
    };
  }

  async saveMapping(
    datasetId: string,
    dto: SaveMappingDto,
  ): Promise<{ ok: true; datasetId: string }> {
    const dataset = await this.getDataset(datasetId);
    const choiceByColumn = new Map(dto.columns.map((c) => [c.column, c]));

    await this.assertNewCanonicalNames(dataset, choiceByColumn);
    // Fuera de la transacción: leer los Parquet puede tardar más que su timeout.
    await this.assertValueTypes(dataset, choiceByColumn);

    await this.prisma.$transaction(async (tx) => {
      const resolved: {
        column: string;
        canonicalId: string | null;
        missingCodes: string[];
        dataType: ValueType | undefined;
      }[] = [];
      const columnsByCanonical = new Map<string, string[]>();
      for (const column of dataset.columns) {
        const choice = choiceByColumn.get(column);
        const canonicalId = await this.resolveCanonicalChoice(
          tx,
          dataset.surveyId,
          choice,
        );
        resolved.push({
          column,
          canonicalId,
          missingCodes: normalizeMissingCodes(choice?.missingCodes),
          dataType: choice?.dataType,
        });
        if (canonicalId !== null) {
          const columns = columnsByCanonical.get(canonicalId) ?? [];
          columns.push(column);
          columnsByCanonical.set(canonicalId, columns);
        }
      }

      // La vista armonizada tiene una sola columna por canónica: si dos
      // columnas del archivo apuntan a la misma, una sobrescribiría a la otra.
      const collisions = [...columnsByCanonical.values()].filter(
        (columns) => columns.length > 1,
      );
      if (collisions.length > 0) {
        throw new ConflictException({
          code: 'canonical_variable_collision',
          message: `Cada variable canónica solo puede venir de una columna por edición. Estas columnas comparten variable: ${collisions
            .map((columns) => columns.join(', '))
            .join('; ')}. Asigna una variable distinta a cada una o deja alguna sin mapear.`,
        });
      }

      for (const { column, canonicalId, missingCodes } of resolved) {
        const existing = await tx.harmonizerMapping.findUnique({
          where: {
            datasetId_sourceColumn: { datasetId, sourceColumn: column },
          },
        });

        if (canonicalId === null) {
          if (existing)
            await tx.harmonizerMapping.delete({ where: { id: existing.id } });
        } else if (existing) {
          if (
            existing.canonicalVariableId !== canonicalId ||
            existing.missingCodes.join('\u0000') !== missingCodes.join('\u0000')
          ) {
            await tx.harmonizerMapping.update({
              where: { id: existing.id },
              data: { canonicalVariableId: canonicalId, missingCodes },
            });
          }
        } else {
          await tx.harmonizerMapping.create({
            data: {
              datasetId,
              sourceColumn: column,
              canonicalVariableId: canonicalId,
              missingCodes,
            },
          });
        }
      }

      // Guardar el tipo lo confirma para la variable canónica en todas las ediciones.
      for (const { canonicalId, dataType } of resolved) {
        if (canonicalId === null || dataType === undefined) continue;
        await tx.harmonizerCanonicalVariable.update({
          where: { id: canonicalId },
          data: { dataType },
        });
      }
    });

    return { ok: true, datasetId };
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
          message: `Columna «${column}»: el nombre «${name}» no es válido, ${problem}.`,
        });
      }
      const clash = known.find((other) => sameCanonicalName(other, name));
      if (clash) {
        throw new ConflictException({
          code: 'canonical_variable_name_taken',
          message: `Columna «${column}»: ya existe la variable «${clash}» y los nombres no distinguen mayúsculas. Elígela en la lista en lugar de crear «${name}».`,
        });
      }
      const sibling = [...created.entries()].find(([other]) =>
        sameCanonicalName(other, name),
      );
      if (sibling) {
        throw new ConflictException({
          code: 'canonical_variable_name_taken',
          message: `Columna «${column}»: la columna «${sibling[1]}» ya crea la variable «${sibling[0]}» y los nombres no distinguen mayúsculas. Usa el mismo nombre o uno distinto.`,
        });
      }
      created.set(name, column);
    }
  }

  /**
   * Un tipo numérico solo se acepta si todos los valores no faltantes de la columna lo
   * cumplen, con los códigos de no especificado de este mismo envío. Si el tipo de una
   * canónica existente cambia, también se revisan las otras ediciones que la usan,
   * porque el tipo es uno solo para la variable.
   */
  private async assertValueTypes(
    dataset: { id: string; name: string; surveyId: string; columns: string[] },
    choiceByColumn: Map<string, MappingChoiceDto>,
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

    const rows = await this.readRawRows(dataset);
    for (const choice of numeric) {
      const codes = new Set(normalizeMissingCodes(choice.missingCodes));
      const bad = valuesNotFitting(
        sourceColumnValues(rows, choice.column, codes),
        choice.dataType,
      );
      if (bad.length > 0) {
        throw new BadRequestException({
          code: 'value_type_mismatch',
          message: `La columna "${choice.column}" tiene valores que no son ${VALUE_TYPE_LABEL[choice.dataType]}: ${quoteList(bad)}. Márcalos como No especificado o elige el tipo Texto.`,
        });
      }
    }

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
    const wanted = new Map<string, ValueType>();
    for (const c of numeric) {
      const canonical = canonicals.find((cv) =>
        c.choice === NEW_CANONICAL
          ? cv.name === c.newName?.trim()
          : cv.id === c.choice.slice(CANONICAL_PREFIX.length),
      );
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
        dataset: { select: { id: true, name: true, columns: true } },
        canonicalVariable: { select: { name: true } },
      },
      orderBy: { dataset: { year: 'asc' } },
    });
    const rowsByDataset = new Map<string, RawData[]>();
    for (const m of others) {
      let otherRows = rowsByDataset.get(m.datasetId);
      if (!otherRows) {
        otherRows = await this.readRawRows(m.dataset);
        rowsByDataset.set(m.datasetId, otherRows);
      }
      const type = wanted.get(m.canonicalVariableId)!;
      const bad = valuesNotFitting(
        sourceColumnValues(otherRows, m.sourceColumn, new Set(m.missingCodes)),
        type,
      );
      if (bad.length > 0) {
        throw new BadRequestException({
          code: 'value_type_mismatch',
          message: `La variable "${m.canonicalVariable.name}" también se usa en la edición "${m.dataset.name}" (columna "${m.sourceColumn}"), que tiene valores que no son ${VALUE_TYPE_LABEL[type]}: ${quoteList(bad)}. Márcalos como No especificado en esa edición o elige el tipo Texto.`,
        });
      }
    }
  }

  private async resolveCanonicalChoice(
    tx: Prisma.TransactionClient,
    surveyId: string,
    choice: MappingChoiceDto | undefined,
  ): Promise<string | null> {
    if (!choice) return null;

    if (choice.choice === NEW_CANONICAL) {
      const name = choice.newName?.trim() ?? '';
      if (!name) return null;
      const existing = await tx.harmonizerCanonicalVariable.findUnique({
        where: { surveyId_name: { surveyId, name } },
      });
      if (existing) return existing.id;
      const created = await tx.harmonizerCanonicalVariable.create({
        data: { surveyId, name },
      });
      return created.id;
    }

    if (choice.choice.startsWith(CANONICAL_PREFIX)) {
      const id = choice.choice.slice(CANONICAL_PREFIX.length);
      const canonical = await tx.harmonizerCanonicalVariable.findFirst({
        where: { id, surveyId },
      });
      if (!canonical) {
        throw new BadRequestException({
          code: 'canonical_variable_not_found',
          message: `La variable con id «${id}» no pertenece a esta encuesta.`,
        });
      }
      return canonical.id;
    }

    return null;
  }

  /** Edición con todas sus filas (descargas y validación de tipos). */
  private async loadEdition(dataset: EditionRecord): Promise<DatasetEdition> {
    const [mappings, rawRows] = await Promise.all([
      this.editionMappings(dataset.id),
      this.readRawRows(dataset),
    ]);
    return toEdition(dataset, mappings, rawRows);
  }

  /**
   * Edición con solo una página de filas y solo las columnas de `mappings` (vistas
   * en pantalla). DuckDB lee ese tramo del Parquet; el resto no se carga.
   */
  private async loadEditionPage(
    dataset: EditionRecord,
    mappings: EditionMapping[],
    page: ViewPage,
  ): Promise<DatasetEdition> {
    const columns = mappings
      .map((m) => m.sourceColumn)
      .filter((column) => dataset.columns.includes(column));
    let rows: RawData[] = [];
    if (columns.length > 0 && page.limit > 0) {
      const sliced = await this.analysisService.readParquetSlice(
        await this.rawPath(dataset),
        columns.map((column) => `c${dataset.columns.indexOf(column)}`),
        page.offset,
        page.limit,
      );
      rows = sliced.map((values) =>
        Object.fromEntries(
          columns.map((column, i) => [column, String(values[i] ?? '')]),
        ),
      );
    }
    return { ...toEdition(dataset, mappings, rows), rowOffset: page.offset };
  }

  private editionMappings(datasetId: string): Promise<EditionMapping[]> {
    return this.prisma.harmonizerMapping.findMany({
      where: { datasetId },
      include: { canonicalVariable: { select: { name: true } } },
    });
  }

  private async rawPath(dataset: { id: string }): Promise<string> {
    const path = this.storage.resolvePath(rawStorageKey(dataset.id));
    try {
      await access(path);
    } catch {
      throw new NotFoundException({
        code: 'harmonizer_dataset_file_missing',
        message: 'No se encontraron los datos guardados de esta edición. Vuelve a subir el archivo.',
      });
    }
    return path;
  }

  private async readRawRows(dataset: {
    id: string;
    columns: string[];
  }): Promise<RawData[]> {
    // Un archivo vacío no tiene encabezados y no se escribe Parquet.
    if (dataset.columns.length === 0) return [];
    const rows = await this.analysisService.readParquetRows(
      await this.rawPath(dataset),
    );
    return rows.map((values) =>
      Object.fromEntries(
        dataset.columns.map((col, i) => [col, String(values[i] ?? '')]),
      ),
    );
  }

  async getDatasetHarmonized(datasetId: string, params: ViewPageParams = {}) {
    const dataset = await this.getDataset(datasetId);
    const page = viewPage(params);
    const mappings = await this.editionMappings(dataset.id);
    const view = buildDatasetView(
      await this.loadEditionPage(dataset, mappings, page),
    );
    return {
      dataset: this.toDatasetInfo(dataset),
      headers: view.headers,
      rows: view.rows,
      // Una edición sin mapeos no tiene columnas ni filas.
      total: view.headers.length > 0 ? dataset.rowCount : 0,
      limit: page.limit,
      offset: page.offset,
      availableVariables: view.headers,
      selectedCount: view.headers.length,
    };
  }

  private async availableVariables(surveyId: string): Promise<string[]> {
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, mappings: { some: {} } },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return canonicals.map((c) => c.name);
  }

  private async surveySelection(
    surveyId: string,
    variables: string | string[] | undefined,
  ) {
    const available = await this.availableVariables(surveyId);
    // Orden fijo (el alfabético de `available`), sin importar cómo vengan en la URL, para que
    // las columnas no cambien de posición entre descargas (H-14). Se descartan nombres que no
    // son variables mapeadas de la encuesta.
    const requested = new Set(parseVariables(variables));
    const selected = available.filter((v) => requested.has(v));
    const wanted = requested.size > 0 ? selected : available;
    return { available, selected, wanted };
  }

  private async surveyView(
    surveyId: string,
    variables: string | string[] | undefined,
  ) {
    const survey = await this.getSurvey(surveyId);
    const { available, selected, wanted } = await this.surveySelection(
      surveyId,
      variables,
    );

    const datasets = await this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const editions: DatasetEdition[] = [];
    for (const dataset of datasets) {
      editions.push(await this.loadEdition(dataset));
    }

    return {
      survey,
      available,
      selected,
      view: buildSurveyView(editions, wanted),
    };
  }

  /**
   * Una página de la vista por encuesta. Las ediciones van apiladas en el
   * mismo orden que la descarga y se conoce el `rowCount` de cada una, así que solo
   * se leen las filas de las ediciones que caen en la página.
   */
  async getSurveyHarmonized(
    surveyId: string,
    variables: string | string[] | undefined,
    params: ViewPageParams = {},
  ) {
    const survey = await this.getSurvey(surveyId);
    const page = viewPage(params);
    const { available, selected, wanted } = await this.surveySelection(
      surveyId,
      variables,
    );
    const wantedSet = new Set(wanted);

    const datasets = await this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        mappings: {
          include: { canonicalVariable: { select: { name: true } } },
        },
      },
    });

    let total = 0;
    const editions: DatasetEdition[] = [];
    for (const { mappings, ...dataset } of datasets) {
      const used = mappings.filter((m) =>
        wantedSet.has(m.canonicalVariable.name),
      );
      // Una edición sin ninguna de las variables elegidas no aporta filas (igual que
      // en la descarga).
      if (used.length === 0) continue;
      const start = Math.max(page.offset - total, 0);
      const end = Math.min(page.offset + page.limit - total, dataset.rowCount);
      if (start < end) {
        editions.push(
          await this.loadEditionPage(dataset, used, {
            offset: start,
            limit: end - start,
          }),
        );
      }
      total += dataset.rowCount;
    }
    const view = buildSurveyView(editions, wanted);

    return {
      survey: { id: survey.id, name: survey.name },
      headers: view.headers,
      rows: view.rows,
      total: view.headers.length > 0 ? total : 0,
      limit: page.limit,
      offset: page.offset,
      availableVariables: available,
      selected,
      selectedCount: view.headers.length,
    };
  }

  async exportDataset(datasetId: string, fmt: string): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const dataset = await this.getDataset(datasetId);
    const view = buildDatasetView(await this.loadEdition(dataset));
    return this.exportView(
      `harmonized_${dataset.name}_${dataset.year}`,
      view.headers,
      view,
      format,
      dataset.surveyId,
    );
  }

  async exportSurvey(
    surveyId: string,
    fmt: string,
    variables: string | string[] | undefined,
  ): Promise<ExportFile> {
    const format = this.assertExportFormat(fmt);
    const { survey, view } = await this.surveyView(surveyId, variables);
    return this.exportView(
      `harmonized_${survey.name}`,
      ['_dataset', '_year', '_row', ...view.headers],
      view,
      format,
      survey.id,
    );
  }

  /**
   * El CSV subido, regenerado desde lo guardado: todas las columnas, mapeadas
   * o no, con los valores tal como se leyeron. No aplica mapeo, códigos de "No
   * especificado" ni la neutralización de fórmulas de la vista armonizada.
   */
  async exportOriginal(datasetId: string): Promise<ExportFile> {
    const dataset = await this.getDataset(datasetId);
    const rows = await this.readRawRows(dataset);
    // Filas como arreglos: con objetos, csv-stringify leería `EDAD.1` como ruta anidada.
    const csv = stringify([
      dataset.columns,
      ...rows.map((row) => dataset.columns.map((column) => row[column])),
    ]);
    return {
      filename: `${safeFileBase(`original_${dataset.name}_${dataset.year}`, 'original')}.csv`,
      contentType: EXPORT_CONTENT_TYPE.csv,
      body: Buffer.from(`\ufeff${csv}`, 'utf8'),
    };
  }

  private assertExportFormat(fmt: string): ExportFormat {
    const format = fmt.toLowerCase();
    if (!isExportFormat(format)) {
      throw new NotFoundException({
        code: 'export_format_not_supported',
        message: `Formato de exportación no admitido: «${fmt}». Usa «csv» o «parquet».`,
      });
    }
    return format;
  }

  private async exportView(
    baseName: string,
    columns: string[],
    view: HarmonizedView,
    format: ExportFormat,
    surveyId: string,
  ): Promise<ExportFile> {
    const filename = `${safeFileBase(baseName, 'harmonized')}.${format}`;
    const contentType = EXPORT_CONTENT_TYPE[format];

    if (format === 'csv') {
      const csv = stringify(view.rows, {
        header: true,
        columns: columns.map((key) => ({ key, header: neutralizeCsvFormula(key) })),
        cast: { number: (n) => String(n), string: neutralizeCsvFormula },
      });
      return {
        filename,
        contentType,
        body: Buffer.from(`\ufeff${csv}`, 'utf8'),
      };
    }

    if (columns.length === 0) {
      throw new BadRequestException({
        code: 'harmonized_view_empty',
        message: 'No hay variables mapeadas para exportar como Parquet. Mapea al menos una columna.',
      });
    }
    const types = await this.parquetTypes(surveyId, view);
    const tmpPath = join(tmpdir(), `ibero-harmonized-${randomUUID()}.parquet`);
    try {
      await this.analysisService.writeRowsToParquet(
        columns,
        view.rows,
        tmpPath,
        types,
      );
      return { filename, contentType, body: await readFile(tmpPath) };
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /**
   * Tipo de cada columna en el Parquet: el confirmado en la variable canónica o, si
   * no hay, el que infieren los valores exportados. Las de origen son fijas.
   */
  private async parquetTypes(
    surveyId: string,
    view: HarmonizedView,
  ): Promise<Record<string, ParquetColumnType>> {
    const confirmed = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, name: { in: view.headers } },
      select: { name: true, dataType: true },
    });
    const confirmedByName = new Map(
      confirmed.map((c) => [c.name, c.dataType as ValueType | null]),
    );

    const types: Record<string, ParquetColumnType> = {
      _dataset: 'VARCHAR',
      _year: 'BIGINT',
      _row: 'BIGINT',
    };
    for (const header of view.headers) {
      const values = view.rows.map((r) => r[header] ?? null);
      const type = confirmedByName.get(header) ?? inferValueType(values);
      // El mapeo ya valida al guardar; esto cubre ediciones mapeadas sin enviar tipo.
      const bad = valuesNotFitting(values, type);
      if (bad.length > 0) {
        throw new ConflictException({
          code: 'value_type_mismatch',
          message: `El tipo confirmado de la variable "${header}" pide ${VALUE_TYPE_LABEL[type]}, pero tiene valores que no lo son: ${quoteList(bad)}. Revisa su mapeo o cambia su tipo a Texto.`,
        });
      }
      types[header] = PARQUET_TYPE[type];
    }
    return types;
  }
}
