import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  parseSourceMetadata,
  type SourceMetadata,
  type SourceMetadataColumn,
  type SourceRole,
} from '../harmonizer/source-metadata.js';

export type { SourceMetadata, SourceMetadataColumn, SourceRole };

/**
 * Source metadata of resources for analyses: whether a source is a census or a sample, its
 * expansion factor, the "not specified" codes of a column.
 *
 * It reads the copy stored in the resource (`Resource.sourceMetadata`), never the Parquet footer
 * (slower; the footer is for using the file outside the platform) nor the harmonizer (the
 * resource keeps what was declared when it was created).
 */
@Injectable()
export class ResourceMetadataService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The metadata of a resource of `datasetId`, or `null` when it has none. A resource that does not
   * exist in that dataset returns `404 resource_not_found`.
   */
  async forResource(datasetId: string, resourceId: string): Promise<SourceMetadata | null> {
    const resource = await this.prisma.resource.findFirst({
      where: { id: resourceId, datasetId },
      select: { sourceMetadata: true },
    });
    if (!resource) {
      throw new NotFoundException({ code: 'resource_not_found', message: 'Resource not found.' });
    }
    return parseSourceMetadata(resource.sourceMetadata);
  }
}

/** The metadata of one column of the file, or `null` if it has no such column. */
export function columnMetadata(
  metadata: SourceMetadata | null,
  column: string,
): SourceMetadataColumn | null {
  return metadata?.columns.find((c) => c.name === column) ?? null;
}

/** The column with a sample design role, or `null` if none has it. */
export function roleColumn(metadata: SourceMetadata | null, role: SourceRole): string | null {
  return metadata?.columns.find((c) => c.role === role)?.name ?? null;
}

/** The expansion factor column, or `null` (census sources, sources without one, no metadata). */
export function weightColumn(metadata: SourceMetadata | null): string | null {
  return roleColumn(metadata, 'weight');
}

/**
 * The "not specified" codes declared for a column. They describe the source: in the file these
 * values are already `NULL` (`missingCodesAreNull`).
 */
export function missingCodesOf(metadata: SourceMetadata | null, column: string): string[] {
  return columnMetadata(metadata, column)?.missingCodes ?? [];
}

/** Whether the source is a sample, so estimates need its expansion factor. */
export function isSample(metadata: SourceMetadata | null): boolean {
  return metadata?.design === 'sample';
}
