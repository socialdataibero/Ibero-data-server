import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AnalysisService } from '../../analysis/analysis.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import { csvError } from '../csv-errors.js';
import {
  NEW_SURVEY,
  type UploadDatasetDto,
  type UploadEncoding,
} from '../dto/upload-dataset.dto.js';
import { rawColumnNames, rawStorageKey } from '../edition-files.js';
import type { RawData } from '../harmonized-view.js';
import { datasetNameTaken } from '../harmonizer-errors.js';
import type { DatasetInfo } from '../harmonizer-types.js';
import { HarmonizerLookupService } from '../lookup.service.js';
import { ColumnProfilesService } from '../profiles/column-profiles.service.js';
import { SurveysService } from '../surveys/surveys.service.js';
import type { AnalysisUnit, SourceDesign } from '../source-metadata.js';
import {
  decodeUtf8,
  dedupeHeaders,
  parseDbfUpload,
  type ParsedUpload,
  type RenamedColumn,
  type UploadSource,
} from './upload-parse.js';

/**
 * The upload of an edition in one request (`POST /harmonizer/upload`), read in memory. The web
 * app uses tus instead; scripts use this. Its errors must stay those of the import worker
 * (`csv-rows.spec.ts` compares them).
 */
@Injectable()
export class SyncUploadService {
  private readonly logger = new Logger(SyncUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analysisService: AnalysisService,
    private readonly storage: LocalStorageService,
    private readonly lookup: HarmonizerLookupService,
    private readonly surveys: SurveysService,
    private readonly profiles: ColumnProfilesService,
  ) {}

  async uploadDataset(
    dto: UploadDatasetDto,
    file: { originalname: string; buffer: Buffer },
    userId: string,
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
    const survey = await this.resolveSurveyForUpload(dto, userId);

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
          Object.fromEntries(
            columns.map((col, i) => [positional[i], row[col]]),
          ),
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
          design: dto.design,
          unit: dto.unit,
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

    // El perfil se usa para comparar códigos entre ediciones. Si falla aquí, se calcula la
    // primera vez que se necesite: la subida no se pierde por eso.
    try {
      await this.profiles.columnProfiles([{ dataset, column: null }]);
    } catch (err) {
      this.logger.warn(
        `Could not profile edition ${dataset.id}: ${(err as Error).message}`,
      );
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
        design: dataset.design as SourceDesign | null,
        unit: dataset.unit as AnalysisUnit | null,
        coverage: null,
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

  private async resolveSurveyForUpload(dto: UploadDatasetDto, userId: string) {
    if (dto.surveyId !== NEW_SURVEY) {
      return this.lookup.getSurvey(dto.surveyId);
    }
    const name = dto.newSurvey?.trim() ?? '';
    if (!name) {
      throw new BadRequestException({
        code: 'new_survey_name_required',
        message: 'Enter the name of the new survey (field "newSurvey").',
      });
    }
    // The controller already checked that organizationId is set and the user may create surveys there.
    return this.surveys.createSurvey(
      { name, organizationId: dto.organizationId! },
      userId,
    );
  }

  private parseDbf(
    buffer: Buffer,
    encoding: UploadEncoding | undefined,
  ): ParsedUpload {
    return parseDbfUpload(buffer, encoding);
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
        ...csvError(err, lastRecordLine),
      });
    }
    // Una edición sin filas no aporta datos, pero sí permitiría crear
    // variables canónicas permanentes en la encuesta (H-08). Una línea con
    // solo espacios se lee como un encabezado de nombres vacíos.
    if (rows.length === 0 && columns.every((c) => c === '')) {
      throw new BadRequestException({
        code: 'csv_empty',
        message: 'The file is empty: it has no header and no data.',
      });
    }
    if (rows.length === 0) {
      throw new BadRequestException({
        code: 'csv_no_rows',
        message: 'The file only has a header and no data rows.',
      });
    }
    return { columns, rows, renamed };
  }
}
