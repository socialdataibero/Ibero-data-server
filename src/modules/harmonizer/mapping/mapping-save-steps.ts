import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CodebookVariableInfo } from '../codebook.js';
import {
  CANONICAL_PREFIX,
  NEW_CANONICAL,
  type MappingChoiceDto,
} from '../dto/mapping-choice.dto.js';
import type { ValueType } from '../harmonized-view.js';
import { normalizeCertaintyCodes, type SourceRole } from '../source-metadata.js';
import { normalizeMissingCodes } from './mapping-choices.js';

/**
 * The steps of saving a mapping (`MappingService.saveMapping`), as pure functions over what the
 * transaction already read. The transaction runs them in this order and writes what they return.
 */

export interface CanonicalRef {
  id: string;
  name: string;
  description: string | null;
  dataType: string | null;
}

export interface SavedMapping {
  id: string;
  canonicalVariableId: string;
  missingCodes: string[];
  role: string | null;
  certaintyCodes: string[];
}

export interface ResolvedColumn {
  column: string;
  canonicalId: string | null;
  missingCodes: string[];
  role: SourceRole | null;
  /** Saved only with `role = certainty`; empty otherwise. */
  certaintyCodes: string[];
  dataType: ValueType | undefined;
}

/**
 * 1. The new canonicals to create, by name, with their description: the one sent or, if none,
 * the label of the column in the edition's dictionary. A name that already exists is reused.
 */
export function newCanonicalsToCreate(
  columns: string[],
  choiceByColumn: Map<string, MappingChoiceDto>,
  byName: Map<string, CanonicalRef>,
  columnCodebook: Map<string, CodebookVariableInfo>,
): Map<string, string | null> {
  const toCreate = new Map<string, string | null>();
  for (const column of columns) {
    const choice = choiceByColumn.get(column);
    if (choice?.choice !== NEW_CANONICAL) continue;
    const name = choice.newName?.trim() ?? '';
    if (!name || byName.has(name) || toCreate.has(name)) continue;
    toCreate.set(
      name,
      choice.newDescription?.trim() ||
        columnCodebook.get(column)?.label ||
        null,
    );
  }
  return toCreate;
}

/**
 * 2. The canonical of each column of the file (`null` = unmapped), with its normalized codes,
 * role and type. A `cv:<id>` of another survey is `400 canonical_variable_not_found`.
 */
export function resolveChoices(
  columns: string[],
  choiceByColumn: Map<string, MappingChoiceDto>,
  byId: Map<string, CanonicalRef>,
  byName: Map<string, CanonicalRef>,
): ResolvedColumn[] {
  const resolved: ResolvedColumn[] = [];
  for (const column of columns) {
    const choice = choiceByColumn.get(column);
    let canonicalId: string | null = null;
    if (choice?.choice === NEW_CANONICAL) {
      const name = choice.newName?.trim() ?? '';
      canonicalId = name ? (byName.get(name)?.id ?? null) : null;
    } else if (choice?.choice.startsWith(CANONICAL_PREFIX)) {
      const id = choice.choice.slice(CANONICAL_PREFIX.length);
      if (!byId.has(id)) {
        throw new BadRequestException({
          code: 'canonical_variable_not_found',
          message: `Variable with id "${id}" does not belong to this survey.`,
          params: { id },
        });
      }
      canonicalId = id;
    }
    resolved.push({
      column,
      canonicalId,
      missingCodes: normalizeMissingCodes(choice?.missingCodes),
      role: choice?.role ?? null,
      certaintyCodes: choice?.role === 'certainty' ? normalizeCertaintyCodes(choice.certaintyCodes) : [],
      dataType: choice?.dataType,
    });
  }
  return resolved;
}

/**
 * 3. Groups of columns that point to the same canonical. The harmonized view has one column per
 * canonical: if two columns of the file pointed to the same one, one would overwrite the other.
 */
export function mappingCollisions(resolved: ResolvedColumn[]): string[][] {
  const columnsByCanonical = new Map<string, string[]>();
  for (const { column, canonicalId } of resolved) {
    if (canonicalId === null) continue;
    const columns = columnsByCanonical.get(canonicalId) ?? [];
    columns.push(column);
    columnsByCanonical.set(canonicalId, columns);
  }
  return [...columnsByCanonical.values()].filter(
    (columns) => columns.length > 1,
  );
}

export interface MappingChanges {
  /** In column order; the transaction applies them first. */
  toUpdate: {
    id: string;
    data: Prisma.HarmonizerMappingUncheckedUpdateInput;
  }[];
  toDelete: string[];
  toInsert: Prisma.HarmonizerMappingCreateManyInput[];
}

/**
 * 4. What changes in the saved mapping of the edition: new rows, removed rows, and rows whose
 * canonical, codes or role changed. Moving a column to another canonical drops its recoding,
 * which belonged to the previous variable.
 */
export function mappingChanges(
  datasetId: string,
  resolved: ResolvedColumn[],
  savedByColumn: Map<string, SavedMapping>,
): MappingChanges {
  const changes: MappingChanges = { toUpdate: [], toDelete: [], toInsert: [] };
  for (const { column, canonicalId, missingCodes, role, certaintyCodes } of resolved) {
    const existing = savedByColumn.get(column);
    if (canonicalId === null) {
      if (existing) changes.toDelete.push(existing.id);
    } else if (!existing) {
      changes.toInsert.push({
        datasetId,
        sourceColumn: column,
        canonicalVariableId: canonicalId,
        missingCodes,
        role,
        certaintyCodes,
      });
    } else if (existing.canonicalVariableId !== canonicalId) {
      changes.toUpdate.push({
        id: existing.id,
        data: {
          canonicalVariableId: canonicalId,
          missingCodes,
          role,
          certaintyCodes,
          valueMap: {},
        },
      });
    } else if (
      existing.missingCodes.join('\u0000') !== missingCodes.join('\u0000') ||
      existing.role !== role ||
      existing.certaintyCodes.join('\u0000') !== certaintyCodes.join('\u0000')
    ) {
      changes.toUpdate.push({ id: existing.id, data: { missingCodes, role, certaintyCodes } });
    }
  }
  return changes;
}

/**
 * 5. What changes in the canonicals: saving a type confirms it for the canonical in every
 * edition, and a canonical without description takes the dictionary label of the column.
 */
export function canonicalUpdates(
  resolved: ResolvedColumn[],
  byId: Map<string, CanonicalRef>,
  columnCodebook: Map<string, CodebookVariableInfo>,
): Map<string, Prisma.HarmonizerCanonicalVariableUpdateInput> {
  const updates = new Map<
    string,
    Prisma.HarmonizerCanonicalVariableUpdateInput
  >();
  for (const { column, canonicalId, dataType } of resolved) {
    if (canonicalId === null) continue;
    const canonical = byId.get(canonicalId)!;
    const data = updates.get(canonicalId) ?? {};
    if (dataType !== undefined && canonical.dataType !== dataType)
      data.dataType = dataType;
    const label = columnCodebook.get(column)?.label;
    if (!canonical.description && label) data.description = label;
    if (Object.keys(data).length > 0) updates.set(canonicalId, data);
  }
  return updates;
}
