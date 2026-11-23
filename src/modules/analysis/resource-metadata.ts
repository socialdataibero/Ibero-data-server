import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  parseSourceMetadata,
  type ColumnRole,
  type SourceMetadata,
  type SourceMetadataCategory,
  type SourceMetadataColumn,
  type SourceRole,
} from '../harmonizer/source-metadata.js';

export type { SourceMetadata, SourceMetadataCategory, SourceMetadataColumn, SourceRole };

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

/**
 * The column with a sample design role, or `null` if none has it. A column has it only when every
 * edition of the file gives it that role; `editionWeight` gives the factor of one edition.
 */
export function roleColumn(metadata: SourceMetadata | null, role: SourceRole): string | null {
  return metadata?.columns.find((c) => c.role === role)?.name ?? null;
}

/** The expansion factor column of the whole file, or `null` (census, none, or one per edition). */
export function weightColumn(metadata: SourceMetadata | null): string | null {
  return roleColumn(metadata, 'weight');
}

/** The expansion factor column of one source edition, or `null`. */
export function editionWeight(metadata: SourceMetadata | null, editionId: string): string | null {
  return metadata?.editions.find((e) => e.id === editionId)?.weight ?? null;
}

/** The role of a column (a sample design role or its use in analysis), or `null`. */
export function roleOf(metadata: SourceMetadata | null, column: string): ColumnRole | null {
  return columnMetadata(metadata, column)?.role ?? null;
}

/** The columns with one of `roles`, in file order. */
export function columnsWithRole(
  metadata: SourceMetadata | null,
  ...roles: ColumnRole[]
): SourceMetadataColumn[] {
  return metadata?.columns.filter((c) => c.role !== undefined && roles.includes(c.role)) ?? [];
}

/** The categories of a column ("not specified" ones included, `kind: 'missing'`), or `[]`. */
export function categoriesOf(
  metadata: SourceMetadata | null,
  column: string,
): SourceMetadataCategory[] {
  return columnMetadata(metadata, column)?.categories ?? [];
}

/** Who was asked a column's question, or `null` when it was not said. */
export function universeOf(metadata: SourceMetadata | null, column: string): string | null {
  return columnMetadata(metadata, column)?.universe ?? null;
}

/**
 * The "not specified" codes declared for a column. With the column's `missingCodesAreNull` they
 * only describe the source (in the file they are already `NULL`); without it (variables of codes)
 * they are in the file, apart from the empty cells («no aplica»), which are `NULL`.
 */
export function missingCodesOf(metadata: SourceMetadata | null, column: string): string[] {
  return columnMetadata(metadata, column)?.missingCodes ?? [];
}

/** Whether the source is a sample, so estimates need its expansion factor. */
export function isSample(metadata: SourceMetadata | null): boolean {
  return metadata?.design === 'sample';
}
