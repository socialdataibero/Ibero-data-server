import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parseVariables } from '../matching.js';
import type { CatalogCategory } from '../comparison.js';
import { exportColumns, type ExportColumn } from '../harmonized-export.js';
import { keepsMissingCodes } from '../variables/variable-role.js';

export interface EditionRecord {
  id: string;
  name: string;
  year: number;
  columns: string[];
  design: string | null;
  unit: string | null;
}

export interface EditionMapping {
  sourceColumn: string;
  missingCodes: string[];
  valueMap: Prisma.JsonValue;
  role: string | null;
  /** `role` is the canonical's role in analysis (category, measure…), not the sample one. */
  canonicalVariable: { name: string; role: string | null };
}

const CANONICAL = { select: { name: true, role: true } } as const;

/** La recodificación guardada de un mapeo (`{ valor: código }`) como Map. */
export function toValueMap(
  json: Prisma.JsonValue | undefined,
): Map<string, string> {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    return new Map();
  return new Map(
    Object.entries(json).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}

export function toCatalog(
  json: Prisma.JsonValue | null | undefined,
): CatalogCategory[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((c) =>
    c &&
    typeof c === 'object' &&
    !Array.isArray(c) &&
    typeof c.code === 'string'
      ? [{ code: c.code, label: typeof c.label === 'string' ? c.label : '' }]
      : [],
  );
}

/** The columns of an edition's harmonized view for these of its mappings (see `exportColumns`). */
export function editionColumns(
  dataset: EditionRecord,
  mappings: EditionMapping[],
): ExportColumn[] {
  return exportColumns(
    dataset.columns,
    mappings.map((m) => ({
      sourceColumn: m.sourceColumn,
      canon: m.canonicalVariable.name,
      missingCodes: m.missingCodes,
      keepMissingCodes: keepsMissingCodes(m.canonicalVariable.role),
      valueMap: toValueMap(m.valueMap),
    })),
  );
}

/**
 * Reads editions with their mapping, the same way for the views and the downloads: in the order
 * they are stacked (year, upload date, id), and which variables of the survey a request asks for.
 */
@Injectable()
export class EditionReaderService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every edition of a survey, stacked in the order of the views and downloads, with its mapping. */
  surveyEditions(surveyId: string) {
    return this.prisma.harmonizerDataset.findMany({
      where: { surveyId },
      orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: {
        mappings: { include: { canonicalVariable: CANONICAL } },
      },
    });
  }

  editionMappings(datasetId: string): Promise<EditionMapping[]> {
    return this.prisma.harmonizerMapping.findMany({
      where: { datasetId },
      include: { canonicalVariable: CANONICAL },
    });
  }

  private async availableVariables(surveyId: string): Promise<string[]> {
    const canonicals = await this.prisma.harmonizerCanonicalVariable.findMany({
      where: { surveyId, mappings: { some: {} } },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    return canonicals.map((c) => c.name);
  }

  async surveySelection(
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
}
