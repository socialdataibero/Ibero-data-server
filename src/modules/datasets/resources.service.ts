import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { OrgRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt-payload.interface.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { AnalysisService } from '../analysis/analysis.service.js';
import { HarmonizerService } from '../harmonizer/harmonizer.service.js';
import { discardExportFile } from '../harmonizer/export-response.js';
import type { AttachHarmonizedDto } from './dto/attach-harmonized.dto.js';

const PARQUET_MAGIC = Buffer.from('PAR1', 'ascii');

/** `Resource.sizeBytes` is a 32-bit integer. */
export const MAX_RESOURCE_BYTES = 2_147_483_647;

export function looksLikeParquet(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer.subarray(0, 4).equals(PARQUET_MAGIC) &&
    buffer.subarray(-4).equals(PARQUET_MAGIC)
  );
}

@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
    private readonly analysisService: AnalysisService,
    private readonly harmonizer: HarmonizerService,
  ) {}

  findAll(datasetId: string) {
    return this.prisma.resource.findMany({ where: { datasetId }, orderBy: { createdAt: 'desc' } });
  }

  async handoffContext(organizationId: string, datasetId: string, user: AuthenticatedUser) {
    const [dataset, membership] = await Promise.all([
      this.prisma.dataset.findFirst({
        where: { id: datasetId, organizationId },
        select: { title: true, organization: { select: { name: true } } },
      }),
      this.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId } },
        select: { role: true },
      }),
    ]);
    if (!dataset) {
      throw new NotFoundException({ code: 'dataset_not_found', message: 'Dataset not found.' });
    }
    return {
      organizationId,
      organizationName: dataset.organization.name,
      datasetId,
      datasetTitle: dataset.title,
      // Same roles as the publish endpoints; members may explore in vistrace but not save back.
      canPublish: user.isSysadmin || membership?.role === OrgRole.ADMIN || membership?.role === OrgRole.EDITOR,
    };
  }

  async findOne(datasetId: string, resourceId: string) {
    const resource = await this.prisma.resource.findFirst({ where: { id: resourceId, datasetId } });
    if (!resource) {
      throw new NotFoundException({ code: 'resource_not_found', message: 'Resource not found.' });
    }
    return resource;
  }

  async upload(datasetId: string, file: { originalname: string; buffer: Buffer; size: number }) {
    if (!file.originalname.toLowerCase().endsWith('.parquet')) {
      throw new BadRequestException({
        code: 'invalid_file_extension',
        message: 'Only .parquet files are accepted.',
      });
    }
    if (!looksLikeParquet(file.buffer)) {
      throw new BadRequestException({
        code: 'invalid_parquet_format',
        message: 'The file is not a valid Parquet file.',
      });
    }

    const storageKey = await this.storage.save(datasetId, file.originalname, file.buffer);
    return this.createStored(datasetId, file.originalname, file.size, storageKey);
  }

  /**
   * Saves a harmonized view (the Parquet of `GET /harmonizer/.../harmonized.parquet`) as a
   * resource of the dataset. The server writes it straight to storage: it never goes through
   * the browser, memory, or the 500 MB upload limit. Errors of the export come back as they are.
   */
  async attachHarmonized(datasetId: string, dto: AttachHarmonizedDto) {
    if (Boolean(dto.editionId) === Boolean(dto.surveyId) || (dto.editionId && dto.variables)) {
      throw new BadRequestException({
        code: 'harmonized_source_invalid',
        message: 'Send editionId, or surveyId with optional variables.',
      });
    }
    const file = dto.editionId
      ? await this.harmonizer.exportDataset(dto.editionId, 'parquet')
      : await this.harmonizer.exportSurvey(dto.surveyId!, 'parquet', dto.variables);
    const size = file.size ?? (Buffer.isBuffer(file.body) ? file.body.length : 0);
    if (size > MAX_RESOURCE_BYTES) {
      discardExportFile(file);
      throw new UnprocessableEntityException({
        code: 'resource_too_large',
        message: `The file is ${size} bytes and a resource can be at most ${MAX_RESOURCE_BYTES}.`,
        params: { size, maxBytes: MAX_RESOURCE_BYTES },
      });
    }
    const body = Buffer.isBuffer(file.body) ? Readable.from([file.body]) : file.body;
    const storageKey = await this.storage.saveStream(datasetId, file.filename, body);
    try {
      return await this.createStored(datasetId, file.filename, size, storageKey);
    } catch (err) {
      await this.storage.remove(storageKey);
      throw err;
    }
  }

  /** The resource of a Parquet already in storage, with its column schema when it can be read. */
  private async createStored(
    datasetId: string,
    filename: string,
    sizeBytes: number,
    storageKey: string,
  ) {
    let columns: unknown = null;
    try {
      columns = await this.analysisService.describeSchema(this.storage.resolvePath(storageKey));
    } catch {
      columns = null;
    }

    return this.prisma.resource.create({
      data: {
        datasetId,
        filename,
        format: 'parquet',
        sizeBytes,
        storageKey,
        columns: columns as any,
      },
    });
  }

  async resolveFilePath(datasetId: string, resourceId: string): Promise<string> {
    const resource = await this.findOne(datasetId, resourceId);
    const path = this.storage.resolvePath(resource.storageKey);
    try {
      await access(path);
    } catch {
      throw new NotFoundException({
        code: 'resource_file_missing',
        message: 'This resource\'s file is no longer in storage (was it deleted manually?).',
      });
    }
    return path;
  }
}
