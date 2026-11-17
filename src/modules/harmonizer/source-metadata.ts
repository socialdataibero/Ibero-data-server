import { BadRequestException } from '@nestjs/common';

/** How a source was collected: every unit enumerated, or a sample where each record stands for several. */
export const SOURCE_DESIGNS = ['census', 'sample'] as const;
export type SourceDesign = (typeof SOURCE_DESIGNS)[number];

/** What each record of a source is. */
export const ANALYSIS_UNITS = ['person', 'dwelling', 'household'] as const;
export type AnalysisUnit = (typeof ANALYSIS_UNITS)[number];

/** Sample design role of a column: expansion factor, stratum, primary sampling unit. */
export const SOURCE_ROLES = ['weight', 'stratum', 'psu'] as const;
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
}

/**
 * Role rules of a mapping, checked before it is saved:
 * - Only sample editions take roles (census ones and those without a design do not).
 * - A role needs a mapped column: unmapped columns are not in the harmonized view.
 * - At most one column per role.
 * - A sample edition needs a column marked as `weight`.
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
 * ("Usar en un dataset"). It is a snapshot: later changes to the editions or their mappings do
 * not change it. Every per-column property except `name` and `type` is optional, `version` says
 * which shape this is, and readers ignore properties they do not know, so it can grow without
 * breaking stored copies.
 */
export interface SourceMetadata {
  version: 1;
  design: SourceDesign;
  unit: AnalysisUnit;
  /** Editions the data comes from, for traceability only: nothing is computed from them. */
  sourceEditionIds: string[];
  /** Values listed in `missingCodes`, and empty cells, are already `NULL` in the data. */
  missingCodesAreNull: true;
  /** Every column of the file, in its order. */
  columns: SourceMetadataColumn[];
}

export interface SourceMetadataColumn {
  name: string;
  /** Parquet type, e.g. `VARCHAR`, `BIGINT`, `DOUBLE`. */
  type: string;
  /** Codes that meant "not specified" in the source; omitted when there are none. */
  missingCodes?: string[];
  /** Sample design role; omitted when the column has none. */
  role?: SourceRole;
}

/** One edition of a harmonized view, as the metadata needs it. */
export interface MetadataEdition {
  id: string;
  design: string | null;
  unit: string | null;
  /** The edition's columns in the view: canonical name, missing codes and role. */
  columns: { canon: string; missingCodes: string[]; role: string | null }[];
}

/**
 * The metadata of a harmonized view made of `editions` (one for an edition view, the included
 * ones for a survey view), whose file has `headers` with the Parquet `types`.
 *
 * It is `null` when it would not be true of every row: an edition without design or unit,
 * editions with different designs or units, or editions whose expansion factor is a different
 * variable. A canonical gets a role only in sample sources and when every edition gives it that
 * role; `missingCodes` joins the codes of every edition.
 */
export function buildSourceMetadata(
  editions: MetadataEdition[],
  headers: string[],
  types: Record<string, string>,
): SourceMetadata | null {
  const first = editions[0];
  if (!first) return null;
  const design = first.design as SourceDesign | null;
  const unit = first.unit as AnalysisUnit | null;
  if (!design || !unit) return null;
  if (editions.some((e) => e.design !== design || e.unit !== unit)) return null;

  const weights = new Set(
    editions.flatMap((e) => e.columns.filter((c) => c.role === 'weight').map((c) => c.canon)),
  );
  if (weights.size > 1) return null;

  const roleOf = (canon: string): SourceRole | undefined => {
    if (design !== 'sample') return undefined;
    const roles = editions.map((e) => e.columns.find((c) => c.canon === canon)?.role ?? null);
    const role = roles[0];
    return role && roles.every((r) => r === role) ? (role as SourceRole) : undefined;
  };
  const codesOf = (canon: string): string[] => [
    ...new Set(editions.flatMap((e) => e.columns.find((c) => c.canon === canon)?.missingCodes ?? [])),
  ];

  return {
    version: 1,
    design,
    unit,
    sourceEditionIds: editions.map((e) => e.id),
    missingCodesAreNull: true,
    columns: headers.map((name) => {
      const missingCodes = codesOf(name);
      const role = roleOf(name);
      return {
        name,
        type: types[name] ?? 'VARCHAR',
        ...(missingCodes.length > 0 ? { missingCodes } : {}),
        ...(role ? { role } : {}),
      };
    }),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/**
 * Reads stored metadata: the object with only the properties this version knows, or `null` when
 * there is none (resources created before it existed) or it does not have the shape of version 1.
 * Unknown properties are ignored, not an error, so newer copies can still be read.
 */
export function parseSourceMetadata(value: unknown): SourceMetadata | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isOneOf(SOURCE_DESIGNS, value.design) || !isOneOf(ANALYSIS_UNITS, value.unit)) return null;
  if (!isStringList(value.sourceEditionIds) || !Array.isArray(value.columns)) return null;
  const columns: SourceMetadataColumn[] = [];
  for (const c of value.columns) {
    if (!isRecord(c) || typeof c.name !== 'string' || typeof c.type !== 'string') return null;
    if (c.missingCodes !== undefined && !isStringList(c.missingCodes)) return null;
    columns.push({
      name: c.name,
      type: c.type,
      ...(c.missingCodes !== undefined ? { missingCodes: c.missingCodes } : {}),
      // A role this version does not know (added later) is skipped like an unknown property.
      ...(isOneOf(SOURCE_ROLES, c.role) ? { role: c.role } : {}),
    });
  }
  return {
    version: 1,
    design: value.design,
    unit: value.unit,
    sourceEditionIds: value.sourceEditionIds,
    missingCodesAreNull: true,
    columns,
  };
}
