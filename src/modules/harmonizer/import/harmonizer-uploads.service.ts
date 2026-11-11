import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Server } from '@tus/server';
import type { Upload } from '@tus/utils';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobsService } from '../../jobs/jobs.service.js';
import type { AuthenticatedUser } from '../../auth/jwt-payload.interface.js';
import { SurveyAccessService } from '../survey-access.service.js';
import { NEW_SURVEY, UploadDatasetDto } from '../dto/upload-dataset.dto.js';
import { datasetNameTaken } from '../harmonizer.service.js';
import { importErrorBody, type ImportErrorBody } from './import-error.js';
import { importFormat } from './import-format.js';
import {
  UPLOAD_STORAGE,
  uploadConfig,
  type UploadStorage,
} from './upload-storage.js';

/** Where the tus endpoint is mounted (see `HarmonizerUploadsController`). */
export const UPLOADS_PATH = '/harmonizer/uploads';

const RECONCILE_MS = 60_000;
const CLEANUP_MS = 3600_000;
/** A pending or processing import whose job vanished is re-queued after this long. */
const STALE_MS = 60_000;

/** A tus hook error: the same JSON body the rest of the API answers with. */
function tusError(body: ImportErrorBody & { details?: string[] }) {
  return { status_code: body.statusCode, body: JSON.stringify(body) };
}

/** Runs a hook body, turning Nest exceptions (from shared checks) into tus errors. */
async function asTusError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const body = importErrorBody(err);
    if (body) throw tusError(body);
    throw err;
  }
}

/** The signed-in user. The controller runs `JwtAuthGuard` before handing the request to tus. */
function userOf(req: {
  runtime?: { node?: { req: unknown } };
}): AuthenticatedUser {
  const user = (
    req.runtime?.node?.req as { user?: AuthenticatedUser } | undefined
  )?.user;
  if (!user)
    throw tusError({
      statusCode: 401,
      code: 'unauthorized',
      message: 'Sign in to upload files.',
    });
  return user;
}

export interface ImportStatusDto {
  id: string;
  status: string;
  phase: string | null;
  rowsRead: number;
  fileName: string;
  fileSize: number;
  format: string;
  name: string;
  year: number;
  surveyId: string | null;
  newSurveyName: string | null;
  datasetId: string | null;
  result: unknown;
  error: unknown;
  createdAt: Date;
  uploadedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/**
 * Resumable uploads of harmonizer editions with tus (`@tus/server`). The file arrives in chunks
 * into the upload storage; when it is complete, an import job is added for the worker. Each
 * upload has a `HarmonizerImport` row with the same id, which the client polls.
 */
@Injectable()
export class HarmonizerUploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HarmonizerUploadsService.name);
  private readonly config = uploadConfig();
  private readonly server: Server;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SurveyAccessService,
    private readonly jobs: JobsService,
    @Inject(UPLOAD_STORAGE) private readonly storage: UploadStorage,
  ) {
    this.server = new Server({
      path: UPLOADS_PATH,
      datastore: storage.datastore,
      maxSize: this.config.maxBytes,
      // `Location: /harmonizer/uploads/<id>`, whatever host or proxy the client used.
      relativeLocation: true,
      namingFunction: () => randomUUID(),
      onUploadCreate: async (req, upload) => {
        await asTusError(() => this.create(userOf(req), upload));
        return {};
      },
      // Also called for the POST that creates the upload, before `onUploadCreate`; there is
      // nothing to own yet, and `create` checks the user's permissions.
      onIncomingRequest: async (req, id) => {
        if (req.method === 'POST') return;
        await asTusError(() => this.assertOwner(userOf(req), id, req.method));
      },
      onUploadFinish: async (_req, upload) => {
        await this.finish(upload.id);
        return {};
      },
    });
  }

  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.server.handle(req, res);
  }

  onModuleInit(): void {
    const every = (ms: number, task: () => Promise<void>, what: string) => {
      const timer = setInterval(() => {
        task().catch((err: Error) =>
          this.logger.warn(`${what} failed: ${err.message}`),
        );
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(RECONCILE_MS, () => this.requeueLostImports(), 'Re-queueing imports');
    every(
      CLEANUP_MS,
      () => this.removeExpiredUploads(),
      'Removing expired uploads',
    );
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  /**
   * Checks the edition fields before the first byte arrives, with the same order and codes as
   * `POST /harmonizer/upload`: field validation, survey permissions, size, then names.
   */
  private async create(user: AuthenticatedUser, upload: Upload): Promise<void> {
    const meta = upload.metadata ?? {};
    if (upload.size === undefined) {
      throw tusError({
        statusCode: 400,
        code: 'upload_length_required',
        message:
          'Send the file size when the upload starts (Upload-Length); deferred length is not supported.',
      });
    }
    // Metadata keys are those of POST /harmonizer/upload, except `editionName`: tus clients
    // such as Uppy use `name` for the file name. Errors still name the DTO field (`name`).
    const dto = plainToInstance(UploadDatasetDto, {
      name: meta.editionName ?? undefined,
      year: meta.year ?? undefined,
      surveyId: meta.surveyId ?? undefined,
      newSurvey: meta.newSurvey ?? undefined,
      organizationId: meta.organizationId ?? undefined,
      encoding: meta.encoding || undefined,
    });
    const details = (await validate(dto, { whitelist: true })).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );
    const fileName = meta.filename?.trim() ?? '';
    if (!fileName) details.push('filename must not be empty.');
    if (details.length > 0) {
      throw tusError({
        statusCode: 400,
        code: 'validation_error',
        message: details[0],
        details,
      });
    }

    if (dto.surveyId === NEW_SURVEY) {
      if (!dto.organizationId) {
        throw tusError({
          statusCode: 400,
          code: 'survey_organization_required',
          message:
            'A new survey needs an organization (field "organizationId").',
        });
      }
      await this.access.assertCanCreateIn(user, dto.organizationId);
    } else {
      await this.access.assertCanEditSurvey(user, dto.surveyId);
    }

    const format = importFormat(fileName);
    if (upload.size > this.config.maxBytes) {
      throw tusError({
        statusCode: 413,
        code: 'upload_too_large',
        message: `Files can be at most ${this.config.maxBytes} bytes; this one has ${upload.size}.`,
        params: { maxBytes: this.config.maxBytes, size: upload.size },
      });
    }
    if (format === 'dbf' && upload.size > this.config.dbfMaxBytes) {
      throw tusError({
        statusCode: 413,
        code: 'dbf_too_large',
        message: `DBF files can be at most ${this.config.dbfMaxBytes} bytes; this one has ${upload.size}. Export the table to CSV and upload that instead.`,
        params: { maxBytes: this.config.dbfMaxBytes, size: upload.size },
      });
    }

    const name = dto.name.trim();
    let newSurveyName: string | null = null;
    if (dto.surveyId === NEW_SURVEY) {
      newSurveyName = dto.newSurvey?.trim() ?? '';
      if (!newSurveyName) {
        throw tusError({
          statusCode: 400,
          code: 'new_survey_name_required',
          message: 'Enter the name of the new survey (field "newSurvey").',
        });
      }
      if (
        await this.prisma.harmonizerSurvey.findUnique({
          where: { name: newSurveyName },
        })
      ) {
        throw tusError({
          statusCode: 409,
          code: 'survey_name_taken',
          message: `A survey named "${newSurveyName}" already exists.`,
          params: { name: newSurveyName },
        });
      }
    } else {
      const existing = await this.prisma.harmonizerDataset.findFirst({
        where: { surveyId: dto.surveyId, name },
        include: { survey: { select: { name: true } } },
      });
      if (existing) throw datasetNameTaken(name, existing.survey.name);
    }

    await this.prisma.harmonizerImport.create({
      data: {
        id: upload.id,
        fileName,
        fileSize: BigInt(upload.size),
        format,
        name,
        year: dto.year,
        surveyId: newSurveyName === null ? dto.surveyId : null,
        newSurveyName,
        organizationId: newSurveyName === null ? null : dto.organizationId!,
        encoding: format === 'dbf' ? (dto.encoding ?? 'auto') : null,
        createdById: user.id,
      },
    });
  }

  /** Only who started an upload (or the sysadmin) can continue, check or cancel it. */
  private async assertOwner(
    user: AuthenticatedUser,
    id: string,
    method: string,
  ): Promise<void> {
    const record = await this.prisma.harmonizerImport.findUnique({
      where: { id },
    });
    if (!record || (record.createdById !== user.id && !user.isSysadmin)) {
      throw tusError({
        statusCode: 404,
        code: 'upload_not_found',
        message: 'Upload not found.',
      });
    }
    if (
      (method === 'PATCH' || method === 'DELETE') &&
      record.status !== 'UPLOADING'
    ) {
      throw tusError({
        statusCode: 409,
        code: 'upload_finished',
        message:
          'This upload is complete and is being imported; it can no longer be changed.',
      });
    }
    if (method === 'DELETE') {
      await this.prisma.harmonizerImport.update({
        where: { id },
        data: {
          status: 'FAILED',
          error: {
            statusCode: 409,
            code: 'upload_cancelled',
            message: 'The upload was cancelled.',
          },
          finishedAt: new Date(),
        },
      });
    }
  }

  /** The whole file arrived: queue it for the worker. */
  private async finish(id: string): Promise<void> {
    await this.prisma.harmonizerImport.update({
      where: { id },
      data: { status: 'PENDING', uploadedAt: new Date() },
    });
    try {
      await this.jobs.add('harmonizerImport', { importId: id }, { jobId: id });
    } catch (err) {
      // The upload is safe on disk; `requeueLostImports` adds the job when Redis is back.
      this.logger.warn(
        `Could not queue import ${id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Imports whose job is gone (Redis lost it, it could not be added, or the worker died and
   * BullMQ gave up on it) are queued again. The processor caps how often one can start.
   */
  async requeueLostImports(): Promise<void> {
    const stale = await this.prisma.harmonizerImport.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING'] },
        OR: [
          { uploadedAt: { lt: new Date(Date.now() - STALE_MS) } },
          { startedAt: { lt: new Date(Date.now() - STALE_MS) } },
        ],
      },
      select: { id: true },
    });
    for (const { id } of stale) {
      const status = await this.jobs.status(id);
      if (status && !['completed', 'failed', 'unknown'].includes(status.state))
        continue;
      if (status) await this.jobs.remove(id);
      await this.jobs.add('harmonizerImport', { importId: id }, { jobId: id });
      this.logger.warn(
        `Re-queued import ${id} (job ${status?.state ?? 'missing'}).`,
      );
    }
  }

  /** Unfinished uploads older than `UPLOAD_EXPIRATION_HOURS` are deleted and their imports fail. */
  async removeExpiredUploads(): Promise<void> {
    const removed = await this.storage.deleteExpired();
    const { count } = await this.prisma.harmonizerImport.updateMany({
      where: {
        status: 'UPLOADING',
        createdAt: { lt: new Date(Date.now() - this.config.expirationMs) },
      },
      data: {
        status: 'FAILED',
        error: {
          statusCode: 410,
          code: 'upload_expired',
          message:
            'The upload was not finished in time and was deleted. Upload the file again.',
        },
        finishedAt: new Date(),
      },
    });
    if (removed > 0 || count > 0) {
      this.logger.log(
        `Removed ${removed} expired upload file(s); ${count} import(s) marked expired.`,
      );
    }
  }

  async status(user: AuthenticatedUser, id: string): Promise<ImportStatusDto> {
    const record = await this.prisma.harmonizerImport.findUnique({
      where: { id },
    });
    if (!record || (record.createdById !== user.id && !user.isSysadmin)) {
      throw new NotFoundException({
        code: 'harmonizer_import_not_found',
        message: 'Import not found.',
      });
    }
    return {
      id: record.id,
      status: record.status,
      phase: record.phase,
      rowsRead: record.rowsRead,
      fileName: record.fileName,
      fileSize: Number(record.fileSize),
      format: record.format,
      name: record.name,
      year: record.year,
      surveyId: record.surveyId,
      newSurveyName: record.newSurveyName,
      datasetId: record.datasetId,
      result: record.result,
      error: record.error,
      createdAt: record.createdAt,
      uploadedAt: record.uploadedAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }
}
