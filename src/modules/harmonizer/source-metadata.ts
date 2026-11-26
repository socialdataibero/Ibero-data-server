import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { ComparisonStatus } from './comparison.js';
import type { Disaggregation, GeoLevel, VariableAnalysis } from './variables/variable-role.js';

/** How a source was collected: every unit enumerated, or a sample where each record stands for several. */
export const SOURCE_DESIGNS = ['census', 'sample'] as const;
export type SourceDesign = (typeof SOURCE_DESIGNS)[number];

/** What each record of a source is. */
export const ANALYSIS_UNITS = ['person', 'dwelling', 'household'] as const;
export type AnalysisUnit = (typeof ANALYSIS_UNITS)[number];

/**
 * Sample design role of a column: expansion factor, stratum, primary sampling unit, or the
 * column that says which strata were enumerated completely (`certainty`, with its codes).
 */
export const SOURCE_ROLES = ['weight', 'stratum', 'psu', 'certainty'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export type SourceInfoField = 'design' | 'unit';

/** The source fields an upload left out, in a fixed order. */
export function missingSourceInfo(dto: { design?: string; unit?: string }): SourceInfoField[] {
  const missing: SourceInfoField[] = [];
  if (!dto.design) missing.push('design');
  if (!dto.unit) missing.push('unit');
  return missing;
}

const SOURCE_INFO_TEXT: Record<SourceInfoField, string> = {
  design: 'the source design (census or sample)',
  unit: 'the unit of analysis (person, dwelling or household)',
};

/** Error body of an upload without design, unit or both (`params.missing` names them). */
export function sourceInfoRequiredBody(missing: SourceInfoField[]) {
  return {
    statusCode: 400,
    code: 'source_info_required',
    message: `Missing ${missing.map((f) => SOURCE_INFO_TEXT[f]).join(' and ')}.`,
    params: { missing },
  };
}

/** One column of a mapping as the role rules see it. */
export interface RoleChoice {
  column: string;
  mapped: boolean;
  role?: string | null;
  /** Codes of a `certainty` column that mark a completely enumerated stratum. */
  certaintyCodes?: string[];
}

/**
 * Role rules of a mapping, checked before it is saved:
 * - Only sample editions take roles (census ones and those without a design do not).
 * - A role needs a mapped column: unmapped columns are not in the harmonized view.
 * - At most one column per role.
 * - A sample edition needs a column marked as `weight`.
 * - A `certainty` column needs at least one code that marks a completely enumerated stratum.
 */
export function assertSourceRoles(design: string | null, choices: RoleChoice[]): void {
  const withRole = choices.filter((c) => c.role);
  if (design !== 'sample') {
    if (withRole.length > 0) {
      throw new BadRequestException({
        code: 'source_role_not_allowed',
        message: `Only sample sources can mark sample design roles; column "${withRole[0].column}" has one.`,
        params: { column: withRole[0].column, role: withRole[0].role, design },
      });
    }
    return;
  }
  const unmapped = withRole.find((c) => !c.mapped);
  if (unmapped) {
    throw new BadRequestException({
      code: 'source_role_unmapped',
      message: `Column "${unmapped.column}" has the role "${unmapped.role}" but is not mapped to a variable.`,
      params: { column: unmapped.column, role: unmapped.role },
    });
  }
  for (const role of SOURCE_ROLES) {
    const columns = withRole.filter((c) => c.role === role).map((c) => c.column);
    if (columns.length > 1) {
      throw new BadRequestException({
        code: 'source_role_repeated',
        message: `Only one column can have the role "${role}"; these have it: ${columns.join(', ')}.`,
        params: { role, columns },
      });
    }
  }
  if (!withRole.some((c) => c.role === 'weight')) {
    throw new BadRequestException({
      code: 'sample_weight_required',
      message: 'Sample sources need one column marked as the expansion factor (role "weight").',
    });
  }
  const certainty = withRole.find((c) => c.role === 'certainty');
  if (certainty && normalizeCertaintyCodes(certainty.certaintyCodes).length === 0) {
    throw new BadRequestException({
      code: 'certainty_codes_required',
      message: `Column "${certainty.column}" has the role "certainty" but no code that marks a completely enumerated stratum.`,
      params: { column: certainty.column },
    });
  }
}

/**
 * The codes of a `certainty` column as they are saved: trimmed, without blanks or repeats, in
 * the order given. Any other role saves none.
 */
export function normalizeCertaintyCodes(codes: string[] | undefined | null): string[] {
  return [...new Set((codes ?? []).map((c) => c.trim()).filter((c) => c !== ''))];
}

/**
 * Footer key (`KV_METADATA`) of a harmonized Parquet that holds its `SourceMetadata` as JSON, so
 * the file describes itself outside the platform too.
 */
export const SOURCE_METADATA_KEY = 'socialdata_metadata';

/** The footer of a harmonized Parquet: its metadata as JSON under one key, or nothing. */
export function sourceMetadataFooter(metadata: SourceMetadata | null | undefined): Record<string, string> {
  return metadata ? { [SOURCE_METADATA_KEY]: JSON.stringify(metadata) } : {};
}

/**
 * Metadata of a harmonized source, copied to a resource when a harmonized view is saved as one
 * ("Usar en un dataset") and written in the footer of its Parquet. It is a snapshot: later
 * changes to the editions or their mappings do not change it (`origin.signature` tells when they
 * did). Version 2 (templates plan, phase 3) is the one object of metadata of a resource: what the
 * templates need about each variable is captured once, in the harmonizer. Keys and roles are in
 * English; texts shown to the user (labels, universe, `unitPlural`) are in Spanish. Readers ignore
 * properties they do not know, so it can grow without breaking stored copies.
 */
export interface SourceMetadata {
  version: 2;
  /** Name of the survey; `null` in copies of version 1. */
  title: string | null;
  /** Short name of the source for notes and result tables ("Censo 2000"); `null` when not given. */
  source: string | null;
  /** Design and unit of every edition; `null` when the editions do not share it (each has its own). */
  design: SourceDesign | null;
  unit: AnalysisUnit | null;
  /** The unit in plural, for texts ("personas"); `null` with `unit`. */
  unitPlural: string | null;
  /** The place the whole file covers (the coverage of its editions when they all share it). */
  total: MetadataPlace | null;
  /** The editions the data comes from, in the order they are stacked. */
  editions: SourceMetadataEdition[];
  /** Every column of the file, in its order. */
  columns: SourceMetadataColumn[];
  /** What was saved, to tell later whether the harmonizer changed; `null` in copies of version 1. */
  origin: SourceOrigin | null;
}

export interface MetadataPlace {
  level: GeoLevel;
  code: string;
  label: string;
}

export interface SourceMetadataEdition {
  id: string;
  /** `null` only in copies of version 1, which kept the ids alone. */
  name: string | null;
  year: number | null;
  design: SourceDesign | null;
  unit: AnalysisUnit | null;
  coverage: MetadataPlace | null;
  /** The column of the file that is this edition's expansion factor, or `null`. */
  weight: string | null;
  /** Edition overrides when stratum/PSU roles are not shared by the whole resource. */
  stratum?: string | null;
  psu?: string | null;
  /** Retained missing codes by column when the edition differs from the resource's union. */
  missingCodes?: Record<string, string[]>;
  /**
   * Which strata of this edition were enumerated completely: the column with the sample role
   * `certainty` and its codes as they are in the file (after the recoding). A stratum where one
   * of its records has one of those codes adds nothing to the variance. `null`: none declared
   * (copies made before 2026-11-23 do not have it).
   */
  certainty: EditionCertainty | null;
}

export interface EditionCertainty {
  column: string;
  codes: string[];
}

/** The harmonized view a resource was made from, and a signature of what defined it. */
export interface SourceOrigin {
  surveyId: string;
  /** The edition of an edition view; `null` for a survey view. */
  editionId: string | null;
  /** The canonical variables of the file, in its order. */
  variables: string[];
  /** Hash of the mappings, codes, recodings, catalogs and uses in analysis of the view. */
  signature: string;
}

export type CategoryKind = 'value' | 'missing';

export interface SourceMetadataCategory {
  code: string;
  label: string | null;
  kind: CategoryKind;
}

/** A role of a column: one of use in analysis (`variable-role.ts`) or a sample design role. */
export type ColumnRole = string;

export interface SourceMetadataColumn {
  name: string;
  /** Parquet type, e.g. `VARCHAR`, `BIGINT`, `DOUBLE`. */
  type: string;
  /**
   * The sample design role (`weight`, `stratum`, `psu`) when every edition gives the column that
   * role, or else its use in analysis (`category`, `measure`…). Omitted when it has none.
   */
  role?: ColumnRole;
  /** Label for charts and notes: the canonical's description. */
  label?: string;
  /** Who was asked; an empty cell is outside it ("no aplica"). */
  universe?: string;
  /**
   * A narrower universe that can be computed: the records whose `column` (another column of the
   * file, a number) is at least `min`. Records outside it are "no aplica" too.
   */
  universeRule?: { column: string; min: number };
  /** Codes and labels, in catalog order (variables of categories only). */
  categories?: SourceMetadataCategory[];
  /** Dichotomous: the code that counts as "yes". */
  positiveValue?: string;
  /** Label of an empty cell when the column splits a result. */
  notApplicableLabel?: string;
  /** Measure: its unit ("años"). */
  unit?: string;
  /** Geographic: its territorial level. */
  geoLevel?: GeoLevel;
  /** How a result can be split by it (without `notApplicableLabel`, which is above). */
  disaggregation?: Omit<Disaggregation, 'notApplicableLabel'>;
  /** Survey views: whether its codes agree between the editions when it was saved. */
  codeReview?: ComparisonStatus;
  /**
   * Codes that mean "not specified"; omitted when there are none. In a column that keeps them
   * they are the codes as they appear in the file (after the recoding); otherwise those of the
   * source, which are no longer in the file.
   */
  missingCodes?: string[];
  /**
   * With `missingCodes` only. `true`: those codes, like empty cells, are already `NULL` in the
   * file (measures and variables without a role). `false`: the codes are in the file and only
   * empty cells («no aplica») are `NULL` (variables of codes, F2 of the templates plan).
   */
  missingCodesAreNull?: boolean;
  /**
   * With `missingCodesAreNull: true` only: per source edition id, how many cells held one of the
   * codes before they became `NULL` (D13), so a result can say how many were left out.
   */
  missingCount?: Record<string, number>;
}

/** One edition of a harmonized view, as the metadata needs it. */
export interface MetadataEdition {
  id: string;
  name: string;
  year: number;
  design: string | null;
  unit: string | null;
  coverage: MetadataPlace | null;
  /**
   * The edition's columns in the view: canonical name, missing codes (as `SourceMetadataColumn`
   * describes them), whether they are `NULL` in the file, how many cells had them (when they are)
   * and sample design role.
   */
  columns: {
    canon: string;
    missingCodes: string[];
    missingCodesAreNull: boolean;
    missingCount?: number;
    role: string | null;
    /** With `role = certainty`: its codes as they are in the file (after the recoding). */
    certaintyCodes?: string[];
  }[];
}

/** What the metadata says about a canonical variable, the same in every edition. */
export interface MetadataVariable {
  label: string | null;
  analysis: VariableAnalysis;
  categories: SourceMetadataCategory[];
  codeReview: ComparisonStatus | null;
}

export interface MetadataInput {
  survey: { name: string; shortName: string | null };
  /** The editions of the view, in order (one for an edition view). */
  editions: MetadataEdition[];
  /** By canonical name; a column without an entry gets only what its editions say. */
  variables: Map<string, MetadataVariable>;
  /** The columns of the file, in order, and their Parquet types. */
  headers: string[];
  types: Record<string, string>;
  origin: SourceOrigin;
}

const UNIT_PLURAL: Record<AnalysisUnit, string> = {
  person: 'personas',
  dwelling: 'viviendas',
  household: 'hogares',
};

const samePlace = (a: MetadataPlace | null, b: MetadataPlace | null) =>
  a !== null && b !== null && a.level === b.level && a.code === b.code && a.label === b.label;

/**
 * The metadata of a harmonized view (`null` only without editions). Design, unit and total are
 * those of the root only when every edition shares them; each edition keeps its own, with its
 * expansion factor, so editions with different designs or factors are still described. A column
 * has a sample design role only in a sample source and when every edition gives it that role.
 * `missingCodes` joins the codes of every edition, and `missingCount` lists every edition that
 * has the column.
 */
export function buildSourceMetadata(input: MetadataInput): SourceMetadata | null {
  const { editions, headers, types, variables } = input;
  const first = editions[0];
  if (!first) return null;
  const isDesign = (v: string | null): v is SourceDesign => isOneOf(SOURCE_DESIGNS, v);
  const isUnit = (v: string | null): v is AnalysisUnit => isOneOf(ANALYSIS_UNITS, v);
  const design =
    isDesign(first.design) && editions.every((e) => e.design === first.design) ? first.design : null;
  const unit = isUnit(first.unit) && editions.every((e) => e.unit === first.unit) ? first.unit : null;
  const total = editions.every((e) => samePlace(e.coverage, first.coverage)) ? first.coverage : null;
  const inFile = new Set(headers);

  const columnsOf = (canon: string) =>
    editions.flatMap((e) => {
      const column = e.columns.find((c) => c.canon === canon);
      return column ? [{ edition: e.id, column }] : [];
    });
  const sampleRoleOf = (canon: string): SourceRole | undefined => {
    if (design !== 'sample') return undefined;
    const roles = editions.map((e) => e.columns.find((c) => c.canon === canon)?.role ?? null);
    const role = roles[0];
    return role && roles.every((r) => r === role) && isOneOf(SOURCE_ROLES, role) ? role : undefined;
  };

  return {
    version: 2,
    title: input.survey.name,
    source: input.survey.shortName,
    design,
    unit,
    unitPlural: unit ? UNIT_PLURAL[unit] : null,
    total,
    editions: editions.map((e) => {
      const weight = e.columns.find((c) => c.role === 'weight' && inFile.has(c.canon))?.canon ?? null;
      const certain = e.columns.find((c) => c.role === 'certainty' && inFile.has(c.canon));
      const roles = Object.fromEntries(['stratum', 'psu'].flatMap((role) => {
        const own = e.columns.find((c) => c.role === role && inFile.has(c.canon))?.canon ?? null;
        const shared = headers.find((name) => sampleRoleOf(name) === role) ?? null;
        return own === shared ? [] : [[role, own]];
      }));
      const missingCodes = Object.fromEntries(e.columns
        .filter((c) => !c.missingCodesAreNull && inFile.has(c.canon) &&
          columnsOf(c.canon).some((f) => f.column.missingCodes.some((code) => !c.missingCodes.includes(code))))
        .map((c) => [c.canon, c.missingCodes]));
      return {
        id: e.id,
        name: e.name,
        year: e.year,
        design: isDesign(e.design) ? e.design : null,
        unit: isUnit(e.unit) ? e.unit : null,
        coverage: e.coverage,
        weight,
        ...roles,
        ...(Object.keys(missingCodes).length > 0 ? { missingCodes } : {}),
        certainty:
          certain && (certain.certaintyCodes?.length ?? 0) > 0
            ? { column: certain.canon, codes: certain.certaintyCodes! }
            : null,
      };
    }),
    columns: headers.map((name) => {
      const found = columnsOf(name);
      const missingCodes = [...new Set(found.flatMap((f) => f.column.missingCodes))];
      // The same canonical keeps its codes in every edition or in none (it follows its role).
      const areNull = !found.some((f) => !f.column.missingCodesAreNull);
      const variable = variables.get(name);
      const a = variable?.analysis;
      const role = sampleRoleOf(name) ?? a?.role ?? undefined;
      const { notApplicableLabel, ...disaggregation } = a?.disaggregation ?? { summable: false };
      return {
        name,
        type: types[name] ?? 'VARCHAR',
        ...(role ? { role } : {}),
        ...(variable?.label ? { label: variable.label } : {}),
        ...(a?.universe ? { universe: a.universe } : {}),
        ...(a?.universeRule ? { universeRule: { column: a.universeRule.variable, min: a.universeRule.min } } : {}),
        ...(variable && variable.categories.length > 0 ? { categories: variable.categories } : {}),
        ...(a?.positiveValue ? { positiveValue: a.positiveValue } : {}),
        ...(notApplicableLabel ? { notApplicableLabel } : {}),
        ...(a?.unit ? { unit: a.unit } : {}),
        ...(a?.geoLevel ? { geoLevel: a.geoLevel } : {}),
        ...(a?.disaggregation ? { disaggregation } : {}),
        ...(variable?.codeReview ? { codeReview: variable.codeReview } : {}),
        ...(missingCodes.length > 0 ? { missingCodes, missingCodesAreNull: areNull } : {}),
        ...(missingCodes.length > 0 && areNull
          ? {
              missingCount: Object.fromEntries(
                found.map((f) => [f.edition, f.column.missingCount ?? 0]),
              ),
            }
          : {}),
      };
    }),
    origin: input.origin,
  };
}

/**
 * The signature of what defines a harmonized view (`SourceOrigin.signature`): a hash of `parts`
 * written as JSON. Callers give the parts in a fixed order, so the same state gives the same hash.
 */
export function sourceSignature(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const isCountMap = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n));
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const GEO_LEVEL_NAMES = ['country', 'state', 'municipality', 'locality', 'ageb', 'block'] as const;
const STATUSES = ['single', 'ok', 'warning', 'reviewed'] as const;

function readPlace(v: unknown): MetadataPlace | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !isOneOf(GEO_LEVEL_NAMES, v.level) || !isText(v.code) || !isText(v.label)) {
    return undefined;
  }
  return { level: v.level, code: v.code, label: v.label };
}

/** The "not specified" properties of a stored column, or `undefined` when they are malformed. */
function readMissing(c: Record<string, unknown>, allNull: boolean) {
  if (c.missingCodes !== undefined && !isStringList(c.missingCodes)) return undefined;
  if (c.missingCodesAreNull !== undefined && typeof c.missingCodesAreNull !== 'boolean') return undefined;
  if (c.missingCount !== undefined && !isCountMap(c.missingCount)) return undefined;
  const areNull = typeof c.missingCodesAreNull === 'boolean' ? c.missingCodesAreNull : allNull;
  return {
    ...(c.missingCodes !== undefined
      ? { missingCodes: c.missingCodes, missingCodesAreNull: areNull }
      : {}),
    ...(c.missingCodes !== undefined && areNull && c.missingCount !== undefined
      ? { missingCount: c.missingCount }
      : {}),
  };
}

/**
 * A copy of version 1 (2026-11-13 to 2026-11-22) as version 2: the same design, unit and codes,
 * the editions by id only, sample design roles as roles, no use in analysis and no origin (so it
 * is never reported as out of date). Copies made before F2 said `missingCodesAreNull` once for
 * the whole file: every column with codes reads as `true`.
 */
function fromVersion1(value: Record<string, unknown>): SourceMetadata | null {
  if (!isOneOf(SOURCE_DESIGNS, value.design) || !isOneOf(ANALYSIS_UNITS, value.unit)) return null;
  if (!isStringList(value.sourceEditionIds) || !Array.isArray(value.columns)) return null;
  const design = value.design;
  const unit = value.unit;
  const allNull = value.missingCodesAreNull === true;
  const columns: SourceMetadataColumn[] = [];
  for (const c of value.columns) {
    if (!isRecord(c) || typeof c.name !== 'string' || typeof c.type !== 'string') return null;
    const missing = readMissing(c, allNull);
    if (!missing) return null;
    columns.push({
      name: c.name,
      type: c.type,
      // A role this version does not know (added later) is skipped like an unknown property.
      ...(isOneOf(SOURCE_ROLES, c.role) ? { role: c.role } : {}),
      ...missing,
    });
  }
  const weight = columns.find((c) => c.role === 'weight')?.name ?? null;
  return {
    version: 2,
    title: null,
    source: null,
    design,
    unit,
    unitPlural: UNIT_PLURAL[unit],
    total: null,
    editions: value.sourceEditionIds.map((id) => ({
      id,
      name: null,
      year: null,
      design,
      unit,
      coverage: null,
      weight,
      certainty: null,
    })),
    columns,
    origin: null,
  };
}

function readCategories(v: unknown): SourceMetadataCategory[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SourceMetadataCategory[] = [];
  for (const c of v) {
    if (!isRecord(c) || !isText(c.code) || !(c.label === null || isText(c.label))) return undefined;
    if (c.kind !== 'value' && c.kind !== 'missing') return undefined;
    out.push({ code: c.code, label: c.label, kind: c.kind });
  }
  return out;
}

function readDisaggregation(v: unknown): SourceMetadataColumn['disaggregation'] | undefined {
  if (!isRecord(v) || typeof v.summable !== 'boolean') return undefined;
  return {
    summable: v.summable,
    ...(Array.isArray(v.cuts) ? { cuts: v.cuts as Disaggregation['cuts'] } : {}),
    ...(isOneOf(GEO_LEVEL_NAMES, v.maxLevel) ? { maxLevel: v.maxLevel } : {}),
  };
}

function readColumn(c: unknown): SourceMetadataColumn | null {
  if (!isRecord(c) || typeof c.name !== 'string' || typeof c.type !== 'string') return null;
  const missing = readMissing(c, false);
  if (!missing) return null;
  const text = (key: string) => (isText(c[key]) ? { [key]: c[key] as string } : {});
  const categories = readCategories(c.categories);
  const disaggregation = readDisaggregation(c.disaggregation);
  return {
    name: c.name,
    type: c.type,
    ...text('role'),
    ...text('label'),
    ...text('universe'),
    ...(isRecord(c.universeRule) && isText(c.universeRule.column) && typeof c.universeRule.min === 'number'
      ? { universeRule: { column: c.universeRule.column, min: c.universeRule.min } }
      : {}),
    ...(categories ? { categories } : {}),
    ...text('positiveValue'),
    ...text('notApplicableLabel'),
    ...text('unit'),
    ...(isOneOf(GEO_LEVEL_NAMES, c.geoLevel) ? { geoLevel: c.geoLevel } : {}),
    ...(disaggregation ? { disaggregation } : {}),
    ...(isOneOf(STATUSES, c.codeReview) ? { codeReview: c.codeReview } : {}),
    ...missing,
  };
}

function readEdition(e: unknown): SourceMetadataEdition | null {
  if (!isRecord(e) || !isText(e.id)) return null;
  const coverage = readPlace(e.coverage ?? null);
  if (coverage === undefined) return null;
  if (e.missingCodes !== undefined &&
    (!isRecord(e.missingCodes) || !Object.values(e.missingCodes).every(isStringList))) return null;
  return {
    id: e.id,
    name: isText(e.name) ? e.name : null,
    year: typeof e.year === 'number' ? e.year : null,
    design: isOneOf(SOURCE_DESIGNS, e.design) ? e.design : null,
    unit: isOneOf(ANALYSIS_UNITS, e.unit) ? e.unit : null,
    coverage,
    weight: isText(e.weight) ? e.weight : null,
    ...(e.stratum === null || isText(e.stratum) ? { stratum: e.stratum } : {}),
    ...(e.psu === null || isText(e.psu) ? { psu: e.psu } : {}),
    ...(e.missingCodes !== undefined ? { missingCodes: e.missingCodes as Record<string, string[]> } : {}),
    certainty: readCertainty(e.certainty),
  };
}

function readCertainty(v: unknown): EditionCertainty | null {
  if (!isRecord(v) || !isText(v.column) || !isStringList(v.codes) || v.codes.length === 0) return null;
  return { column: v.column, codes: v.codes };
}

function readOrigin(o: unknown): SourceOrigin | null {
  if (!isRecord(o) || !isText(o.surveyId) || !isText(o.signature) || !isStringList(o.variables)) {
    return null;
  }
  return {
    surveyId: o.surveyId,
    editionId: isText(o.editionId) ? o.editionId : null,
    variables: o.variables,
    signature: o.signature,
  };
}

/**
 * Reads stored metadata: version 2 with only the properties it knows, version 1 converted to
 * version 2 (`fromVersion1`), or `null` when there is none (resources created before 2026-11-13)
 * or it does not have either shape. Unknown properties are ignored, not an error, so newer copies
 * can still be read; an unknown role is kept, since roles grow.
 */
export function parseSourceMetadata(value: unknown): SourceMetadata | null {
  if (!isRecord(value)) return null;
  if (value.version === 1) return fromVersion1(value);
  if (value.version !== 2) return null;
  if (!Array.isArray(value.editions) || !Array.isArray(value.columns)) return null;
  const design = value.design === null || isOneOf(SOURCE_DESIGNS, value.design) ? value.design : undefined;
  const unit = value.unit === null || isOneOf(ANALYSIS_UNITS, value.unit) ? value.unit : undefined;
  const total = readPlace(value.total ?? null);
  if (design === undefined || unit === undefined || total === undefined) return null;
  const editions: SourceMetadataEdition[] = [];
  for (const e of value.editions) {
    const edition = readEdition(e);
    if (!edition) return null;
    editions.push(edition);
  }
  const columns: SourceMetadataColumn[] = [];
  for (const c of value.columns) {
    const column = readColumn(c);
    if (!column) return null;
    columns.push(column);
  }
  return {
    version: 2,
    title: isText(value.title) ? value.title : null,
    source: isText(value.source) ? value.source : null,
    design,
    unit,
    unitPlural: isText(value.unitPlural) ? value.unitPlural : null,
    total,
    editions,
    columns,
    origin: readOrigin(value.origin),
  };
}
