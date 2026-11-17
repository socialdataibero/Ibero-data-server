import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  HarmonizerImportStatus,
  Prisma,
  type HarmonizerImport,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LocalStorageService } from '../../storage/local-storage.service.js';
import { AnalysisService } from '../../analysis/analysis.service.js';
import { WorkerDuckDb } from '../../../worker/worker-duckdb.js';
import {
  PROFILE_MAX_VALUES,
  datasetNameTaken,
  originalStorageKey,
  parseDbfUpload,
  rawStorageKey,
  type DatasetInfo,
  type RenamedColumn,
  type UploadSource,
} from '../harmonizer.service.js';
import type { AnalysisUnit, SourceDesign } from '../source-metadata.js';
import type { UploadEncoding } from '../dto/upload-dataset.dto.js';
import { importCsvFile, type ImportPhase } from './csv-file.js';
import { cachedColumnChecks } from '../column-check-store.js';
import { columnTypeQuery, jsTrimSql } from '../column-checks.js';
import {
  ImportError,
  importErrorBody,
  type ImportErrorBody,
} from './import-error.js';
import type { ImportFormat } from './import-format.js';
import { RawParquetWriter } from './raw-parquet-writer.js';
import {
  UPLOAD_STORAGE,
  uploadConfig,
  type UploadStorage,
} from './upload-storage.js';

/** What a completed import stores in `result`: the same object the synchronous upload answers. */
export interface ImportResult {
  datasetId: string;
  dataset: DatasetInfo;
  renamedColumns: RenamedColumn[];
  source: UploadSource;
}

const PROGRESS_WRITE_MS = 2000;

/** Times an import may start before it is given up (see `attempts`). */
export const MAX_ATTEMPTS = 3;

const INTERRUPTED: ImportErrorBody = {
  statusCode: 500,
  code: 'import_interrupted',
  message: `The import stopped ${MAX_ATTEMPTS} times before finishing, so it was cancelled. The file may be too large for the server's memory settings; tell the administrator.`,
  params: { attempts: MAX_ATTEMPTS },
};

const INTERNAL_ERROR: ImportErrorBody = {
  statusCode: 500,
  code: 'internal_error',
  message:
    'The file could not be imported because of an unexpected error. Try again; if it happens again, tell the administrator.',
};

interface ReadFile {
  columns: string[];
  renamed: RenamedColumn[];
  rowCount: number;
  source: UploadSource;
}

/**
 * Turns a finished tus upload into an edition, in the worker process. It does what the
 * synchronous upload (`HarmonizerService.uploadDataset`) does, with the same checks, error
 * codes and result, but reading the file from disk instead of from memory. The outcome is
 * written to the `HarmonizerImport` row, which the client polls.
 */
@Injectable()
export class HarmonizerImportProcessor {
  private readonly logger = new Logger(HarmonizerImportProcessor.name);
  private readonly dbfMaxBytes = uploadConfig().dbfMaxBytes;
  private readonly maxUncompressedBytes = uploadConfig().maxUncompressedBytes;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly analysis: AnalysisService,
    private readonly duckdb: WorkerDuckDb,
    @Inject(UPLOAD_STORAGE) private readonly uploads: UploadStorage,
  ) {}

  async process(
    importId: string,
  ): Promise<{ status: HarmonizerImportStatus | 'missing' }> {
    const record = await this.prisma.harmonizerImport.findUnique({
      where: { id: importId },
    });
    if (!record) return { status: 'missing' };
    // A job can run twice (a retried stalled job, or the API re-adding a pending one).
    // A finished import stays as it is. One left PROCESSING by a dead worker starts over.
    if (record.status === 'COMPLETED' || record.status === 'FAILED')
      return { status: record.status };
    if (record.status === 'UPLOADING') {
      this.logger.warn(`Import ${importId} is still uploading; job ignored.`);
      return { status: record.status };
    }

    if (record.attempts >= MAX_ATTEMPTS) {
      // The worker stopped (crashed, or was killed for memory) every time it read this file.
      await this.prisma.harmonizerImport.update({
        where: { id: importId },
        data: {
          status: 'FAILED',
          phase: null,
          error: INTERRUPTED as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      await this.uploads.remove(importId);
      this.logger.error(
        `Import ${importId} given up after ${record.attempts} interrupted attempts.`,
      );
      return { status: 'FAILED' };
    }

    await this.prisma.harmonizerImport.update({
      where: { id: importId },
      data: {
        status: 'PROCESSING',
        startedAt: new Date(),
        phase: 'checking',
        rowsRead: 0,
        attempts: { increment: 1 },
      },
    });

    const datasetId = randomUUID();
    const parquetKey = rawStorageKey(datasetId);
    const originalKey = originalStorageKey(datasetId);
    let file: { path: string; release(): Promise<void> } | null = null;
    try {
      await this.assertTarget(record);
      file = await this.uploads.open(importId);
      await this.storage.ensureDir(parquetKey);
      await this.storage.ensureDir(originalKey);

      const read = await this.readUpload(
        record,
        file.path,
        parquetKey,
        originalKey,
      );
      const result = await this.save(record, datasetId, read);
      await this.profile(datasetId, read.columns);

      await this.prisma.harmonizerImport.update({
        where: { id: importId },
        data: {
          status: 'COMPLETED',
          phase: null,
          rowsRead: read.rowCount,
          surveyId: result.dataset.surveyId,
          datasetId,
          result: result as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      this.logger.log(
        `Import ${importId} completed: edition ${datasetId}, ${read.rowCount} rows.`,
      );
      return { status: 'COMPLETED' };
    } catch (err) {
      await rm(this.storage.resolvePath(parquetKey), { force: true });
      await rm(this.storage.resolvePath(originalKey), { force: true });
      const body = importErrorBody(err);
      if (body) {
        this.logger.log(`Import ${importId} rejected: ${body.code}`);
      } else {
        this.logger.error(
          `Import ${importId} failed: ${(err as Error).stack ?? String(err)}`,
        );
      }
      await this.prisma.harmonizerImport.update({
        where: { id: importId },
        data: {
          status: 'FAILED',
          phase: null,
          error: (body ?? INTERNAL_ERROR) as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      return { status: 'FAILED' };
    } finally {
      await file?.release();
      // The upload is no longer needed either way: the edition has its own files, and a
      // rejected file has to be fixed and uploaded again.
      await this.uploads.remove(importId);
    }
  }

  /** Checks that the target survey and names are still valid, before reading a large file. */
  private async assertTarget(record: HarmonizerImport): Promise<void> {
    if (record.newSurveyName !== null) {
      const taken = await this.prisma.harmonizerSurvey.findUnique({
        where: { name: record.newSurveyName },
      });
      if (taken) throw surveyNameTaken(record.newSurveyName);
      const organization = record.organizationId
        ? await this.prisma.organization.findUnique({
            where: { id: record.organizationId },
          })
        : null;
      if (!organization) {
        throw new ImportError(404, 'organization_not_found', {
          message: 'Organization not found.',
        });
      }
      return;
    }
    // `surveyId` becomes null if the survey is deleted while the file uploads.
    const survey = record.surveyId
      ? await this.prisma.harmonizerSurvey.findUnique({
          where: { id: record.surveyId },
        })
      : null;
    if (!survey)
      throw new ImportError(404, 'survey_not_found', {
        message: 'Survey not found.',
      });
    const existing = await this.prisma.harmonizerDataset.findFirst({
      where: { surveyId: survey.id, name: record.name },
    });
    if (existing) throw datasetNameTaken(record.name, survey.name);
  }

  private async readUpload(
    record: HarmonizerImport,
    path: string,
    parquetKey: string,
    originalKey: string,
  ): Promise<ReadFile> {
    const format = record.format as ImportFormat;
    const parquetPath = this.storage.resolvePath(parquetKey);
    if (format === 'dbf') return this.readDbf(record, path, parquetPath);

    const progress = this.progressWriter(record.id);
    const { header, rowCount } = await importCsvFile({
      path,
      gzip: format === 'csv_gz',
      maxUncompressedBytes: this.maxUncompressedBytes,
      settings: this.duckdb.settings,
      parquetPath,
      originalPath: this.storage.resolvePath(originalKey),
      onProgress: progress,
    });
    return {
      columns: header.columns,
      renamed: header.renamed,
      rowCount,
      source: { format: 'csv' },
    };
  }

  /** A DBF is read whole, as in the synchronous upload, so its size is limited. */
  private async readDbf(
    record: HarmonizerImport,
    path: string,
    parquetPath: string,
  ): Promise<ReadFile> {
    const { size } = await stat(path);
    if (size > this.dbfMaxBytes) {
      throw new ImportError(413, 'dbf_too_large', {
        message: `DBF files can be at most ${this.dbfMaxBytes} bytes; this one has ${size}. Export the table to CSV and upload that instead.`,
        params: { maxBytes: this.dbfMaxBytes, size },
      });
    }
    await this.prisma.harmonizerImport.update({
      where: { id: record.id },
      data: { phase: 'reading' },
    });
    const parsed = parseDbfUpload(
      await readFile(path),
      (record.encoding ?? undefined) as UploadEncoding | undefined,
    );
    const writer = await RawParquetWriter.open(
      this.duckdb.settings,
      parsed.columns.length,
    );
    try {
      for (const row of parsed.rows)
        writer.append(parsed.columns.map((c) => String(row[c] ?? '')));
      await writer.finish(parquetPath);
    } finally {
      await writer.close();
    }
    return {
      columns: parsed.columns,
      renamed: parsed.renamed,
      rowCount: parsed.rows.length,
      source: parsed.source,
    };
  }

  /** Creates the survey (for a new one) and the edition together, so a failure leaves neither. */
  private async save(
    record: HarmonizerImport,
    datasetId: string,
    read: ReadFile,
  ): Promise<ImportResult> {
    await this.prisma.harmonizerImport.update({
      where: { id: record.id },
      data: { phase: 'saving', rowsRead: read.rowCount },
    });
    const { survey, dataset } = await this.prisma.$transaction(async (tx) => {
      let survey;
      if (record.newSurveyName !== null) {
        try {
          survey = await tx.harmonizerSurvey.create({
            data: {
              name: record.newSurveyName,
              organizationId: record.organizationId,
              createdById: record.createdById,
            },
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002')
            throw surveyNameTaken(record.newSurveyName);
          throw err;
        }
      } else {
        survey = await tx.harmonizerSurvey.findUnique({
          where: { id: record.surveyId! },
        });
        if (!survey)
          throw new ImportError(404, 'survey_not_found', {
            message: 'Survey not found.',
          });
      }
      try {
        const dataset = await tx.harmonizerDataset.create({
          data: {
            id: datasetId,
            surveyId: survey.id,
            name: record.name,
            year: record.year,
            columns: read.columns,
            rowCount: read.rowCount,
            design: record.design,
            unit: record.unit,
          },
        });
        return { survey, dataset };
      } catch (err) {
        // Two uploads with the same name: the unique constraint decides.
        if ((err as { code?: string }).code === 'P2002')
          throw datasetNameTaken(record.name, survey.name);
        throw err;
      }
    });
    return {
      datasetId,
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
      },
      renamedColumns: read.renamed,
      source: read.source,
    };
  }

  /**
   * Value profiles of every column, as the synchronous upload computes them, and the suggested
   * type of each column as the mapping screen first asks for it (no codes, no dictionary). If
   * this fails, the API computes them the first time they are needed, so the import does not
   * fail for it.
   */
  private async profile(datasetId: string, columns: string[]): Promise<void> {
    try {
      await cachedColumnChecks(
        this.prisma,
        this.analysis,
        datasetId,
        this.storage.resolvePath(rawStorageKey(datasetId)),
        columns.map((_, i) =>
          columnTypeQuery({ rawColumn: `c${i}`, missingCodes: [], codebookMissing: null }),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Could not check the column types of edition ${datasetId}: ${(err as Error).message}`,
      );
    }
    try {
      const counts = await this.analysis.columnValueCounts(
        this.storage.resolvePath(rawStorageKey(datasetId)),
        columns.map((_, i) => `c${i}`),
        PROFILE_MAX_VALUES,
        jsTrimSql,
      );
      await this.prisma.harmonizerColumnProfile.createMany({
        data: columns.map((column, i) => ({
          datasetId,
          sourceColumn: column,
          values: counts[i].values,
          distinctCapped: counts[i].capped,
          empty: counts[i].empty,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      this.logger.warn(
        `Could not profile edition ${datasetId}: ${(err as Error).message}`,
      );
    }
  }

  /** Writes the phase and rows read to the import at most every 2 s, so the client can show them. */
  private progressWriter(importId: string) {
    let lastWrite = 0;
    let lastPhase: ImportPhase | null = null;
    return ({ phase, rowsRead }: { phase: ImportPhase; rowsRead: number }) => {
      const now = Date.now();
      if (phase === lastPhase && now - lastWrite < PROGRESS_WRITE_MS) return;
      lastWrite = now;
      lastPhase = phase;
      // Only while processing: a late write must not touch a finished import.
      this.prisma.harmonizerImport
        .updateMany({
          where: { id: importId, status: 'PROCESSING' },
          data: { phase, rowsRead },
        })
        .catch((err: Error) =>
          this.logger.warn(
            `Could not save progress of import ${importId}: ${err.message}`,
          ),
        );
    };
  }
}

function surveyNameTaken(name: string): ImportError {
  return new ImportError(409, 'survey_name_taken', {
    message: `A survey named "${name}" already exists.`,
    params: { name },
  });
}
