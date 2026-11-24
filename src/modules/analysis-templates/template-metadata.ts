import { BadRequestException } from '@nestjs/common';
import type {
  SourceMetadata,
  SourceMetadataColumn,
} from '../harmonizer/source-metadata.js';

/**
 * What the analysis templates read about one edition of a resource and its variables, built from
 * the resource's source metadata (version 2, `harmonizer/source-metadata.ts`) by
 * `templateMetadata`. Before phase 3b of the templates plan it was a second object loaded by hand
 * (`Resource.variableMetadata`); the names are those it had, so the template code did not change.
 * Labels and texts are in Spanish because they are shown to the user as they are.
 */

/** A role of a column: its use in analysis (`variable-role.ts`) or a sample design role. */
export type VariableRole = string;

export interface VariableCategory {
  code: string;
  label: string;
}

export interface VariableMetadataColumn {
  name: string;
  role: VariableRole;
  label: string;
  /** Codes and labels in catalog order, "not specified" ones included. */
  categories?: VariableCategory[];
  /**
   * "Not specified" codes: the question was asked and there was no answer. They are in the data
   * of variables of codes; in a measure they are already null (`missingCount` says how many).
   */
  missingCodes?: string[];
  /** Measures: cells of the edition that had a "not specified" code before becoming null. */
  missingCount?: number;
  /** Who was asked, e.g. "población de 5 años y más". An empty cell is outside it ("no aplica"). */
  universe?: string;
  /** Label of an empty cell when the variable is a group, e.g. "No aplica (menores de 12 años)". */
  notApplicableLabel?: string;
  /** Dichotomous: the code that counts as "yes", and how to say it. */
  positiveValue?: string;
  positiveLabel?: string;
  /** Measure: its unit, e.g. "años". */
  unit?: string;
  /** Geographic: its level as the result's `nivel` column writes it, e.g. "municipio". */
  geoLevel?: string;
}

export interface TemplateEdition {
  id: string;
  name: string | null;
  year: number | null;
}

export interface VariableMetadata {
  /** Name of the source, for notes and downloads. */
  title: string;
  /** The result's `fuente` column. */
  source: string;
  /** The result's `edicion` column: the year of the edition. */
  edition: number | null;
  design: 'census' | 'sample';
  /** Unit of analysis and its plural for texts: `person`, "personas". */
  unit: string;
  unitPlural: string;
  /** The place the edition covers, for the total row: level, code and name. */
  total: { level: string; code: string; label: string };
  columns: VariableMetadataColumn[];
  /** The edition the analysis is about, and the other editions of the file. */
  editionInfo: TemplateEdition;
  editions: TemplateEdition[];
  /**
   * SQL condition that keeps the rows of that edition (`_dataset` and `_year` of a survey view),
   * or `null` when the file has one edition.
   */
  rowFilter: string | null;
}

/** Territorial levels as the result tables of the proposal write them (`nivel`). */
const LEVEL_TEXT: Record<string, string> = {
  country: 'país',
  state: 'entidad',
  municipality: 'municipio',
  locality: 'localidad',
  ageb: 'ageb',
  block: 'manzana',
};

const UNIT_PLURAL: Record<string, string> = {
  person: 'personas',
  dwelling: 'viviendas',
  household: 'hogares',
};

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

const editionOf = (e: SourceMetadata['editions'][number]): TemplateEdition => ({
  id: e.id,
  name: e.name,
  year: e.year,
});

/**
 * The edition of the analysis: the one asked for, or the only one. A file with several editions
 * needs one (`400 template_edition_required`, with the editions in `params`), and an id that is
 * not one of them is `400 template_edition_unknown`. With `pickFirst` (to list the templates),
 * the first one is taken instead of asking.
 */
function chooseEdition(
  metadata: SourceMetadata,
  editionId: string | null | undefined,
  pickFirst: boolean,
) {
  const editions = metadata.editions;
  const params = { editions: editions.map(editionOf) };
  if (editionId) {
    const found = editions.find((e) => e.id === editionId);
    if (!found) {
      throw new BadRequestException({
        code: 'template_edition_unknown',
        message: `"${editionId}" is not an edition of this resource.`,
        params: { edition: editionId, ...params },
      });
    }
    return found;
  }
  if (editions.length === 1 || pickFirst) return editions[0] ?? null;
  throw new BadRequestException({
    code: 'template_edition_required',
    message: 'This resource has several editions: choose one for the analysis.',
    params,
  });
}

function column(
  c: SourceMetadataColumn,
  role: string,
  editionId: string,
): VariableMetadataColumn {
  const categories = c.categories?.map((k) => ({ code: k.code, label: k.label ?? k.code }));
  const positive = c.positiveValue
    ? c.categories?.find((k) => k.code === c.positiveValue)?.label
    : undefined;
  return {
    name: c.name,
    role,
    label: c.label ?? c.name,
    ...(categories && categories.length > 0 ? { categories } : {}),
    ...(c.missingCodes?.length ? { missingCodes: c.missingCodes } : {}),
    ...(c.missingCodesAreNull && c.missingCount
      ? { missingCount: c.missingCount[editionId] ?? 0 }
      : {}),
    ...(c.universe ? { universe: c.universe } : {}),
    ...(c.notApplicableLabel ? { notApplicableLabel: c.notApplicableLabel } : {}),
    ...(c.positiveValue ? { positiveValue: c.positiveValue } : {}),
    ...(positive ? { positiveLabel: positive } : {}),
    ...(c.unit ? { unit: c.unit } : {}),
    ...(c.geoLevel ? { geoLevel: LEVEL_TEXT[c.geoLevel] ?? c.geoLevel } : {}),
  };
}

/**
 * What the templates read about one edition of a resource (see `VariableMetadata`), or `null` when
 * the resource has no source metadata or the edition has no design or unit (editions uploaded
 * before they were asked). Only columns with a role are described. The expansion factor is the
 * edition's (`editions[].weight`), so a survey whose editions have different factors still works
 * one edition at a time. A file without the place it covers gets "Total" as its total row.
 */
export function templateMetadata(
  metadata: SourceMetadata | null,
  editionId?: string | null,
  options: { pickFirst?: boolean } = {},
): VariableMetadata | null {
  if (!metadata) return null;
  const edition = chooseEdition(metadata, editionId, options.pickFirst ?? false);
  if (!edition) return null;
  const design = edition.design ?? metadata.design;
  const unit = edition.unit ?? metadata.unit;
  if (!design || !unit) return null;

  const columns: VariableMetadataColumn[] = [];
  for (const c of metadata.columns) {
    if (c.name.startsWith('_')) continue;
    const role =
      edition.weight === c.name
        ? 'weight'
        : c.role === 'weight'
          ? null
          : (c.role ?? null);
    if (role) columns.push(column(c, role, edition.id));
  }
  const coverage = edition.coverage ?? metadata.total;
  const hasOrigin = metadata.columns.some((c) => c.name === '_dataset');
  const rowFilter =
    metadata.editions.length > 1 && hasOrigin && edition.name !== null
      ? `"_dataset" = ${lit(edition.name)}${edition.year !== null ? ` AND "_year" = ${Math.trunc(edition.year)}` : ''}`
      : null;
  return {
    title: metadata.title ?? metadata.source ?? 'Fuente',
    source: metadata.source ?? metadata.title ?? '',
    edition: edition.year,
    design,
    unit,
    unitPlural: UNIT_PLURAL[unit] ?? unit,
    total: coverage
      ? { level: LEVEL_TEXT[coverage.level] ?? coverage.level, code: coverage.code, label: coverage.label }
      : { level: 'total', code: '', label: 'Total' },
    columns,
    editionInfo: editionOf(edition),
    editions: metadata.editions.map(editionOf),
    rowFilter,
  };
}

export function columnOf(metadata: VariableMetadata, name: string): VariableMetadataColumn | null {
  return metadata.columns.find((c) => c.name === name) ?? null;
}

export function columnWithRole(metadata: VariableMetadata, role: VariableRole): VariableMetadataColumn | null {
  return metadata.columns.find((c) => c.role === role) ?? null;
}
