import { BadRequestException } from '@nestjs/common';

/**
 * What the analysis templates need to know about each variable of a resource: its role, label,
 * categories, "not specified" codes and universe. It is stored in `Resource.variableMetadata`.
 *
 * For now it is loaded by hand (`PUT …/resources/:resourceId/variable-metadata`) for the template
 * demo; later the harmonizer will write it when a view is saved as a resource (plan
 * `planes-pendientes/plantillas-analisis.md`, phases 1 to 3). Labels and texts are in Spanish
 * because they are shown to the user as they are.
 */

/** What can be done with a variable (section 3.2 of the template proposal). */
export const VARIABLE_ROLES = [
  'category',
  'ordinal',
  'dichotomous',
  'geographic',
  'measure',
  'weight',
  'stratum',
  'psu',
  'identifier',
  'label',
  'temporal',
  'free_text',
] as const;
export type VariableRole = (typeof VARIABLE_ROLES)[number];

export const SOURCE_DESIGNS = ['census', 'sample'] as const;

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
   * "Not specified" codes: the question was asked and there was no answer. They are kept in the
   * data of categorical variables; in a measure they may already be null.
   */
  missingCodes?: string[];
  /** Who was asked, e.g. "población de 5 años y más". An empty cell is outside it ("no aplica"). */
  universe?: string;
  /** Label of an empty cell when the variable is a group, e.g. "No aplica (menores de 12 años)". */
  notApplicableLabel?: string;
  /** Dichotomous: the code that counts as "yes", and how to say it. */
  positiveValue?: string;
  positiveLabel?: string;
  /** Measure: its unit, e.g. "años". */
  unit?: string;
  /** Geographic: its level, e.g. "municipio". */
  geoLevel?: string;
}

export interface VariableMetadata {
  version: 1;
  /** Name of the source, for notes and downloads. */
  title: string;
  /** Source and edition columns of the result table (`fuente`, `edicion`). */
  source: string;
  edition: number | null;
  design: (typeof SOURCE_DESIGNS)[number];
  /** Unit of analysis and its plural for texts: `person`, "personas". */
  unit: string;
  unitPlural: string;
  /** The place the whole file covers, for the total row: level, code and name. */
  total: { level: string; code: string; label: string };
  columns: VariableMetadataColumn[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

class Invalid extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path}: ${problem}`);
  }
}

function text(obj: Record<string, unknown>, key: string, path: string, optional = false): string | undefined {
  const v = obj[key];
  if (v === undefined && optional) return undefined;
  if (!isText(v)) throw new Invalid(`${path}.${key}`, 'must be a non-empty string');
  return v;
}

function codes(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((c) => typeof c === 'string')) {
    throw new Invalid(path, 'must be a list of strings');
  }
  return v;
}

function column(v: unknown, path: string): VariableMetadataColumn {
  if (!isRecord(v)) throw new Invalid(path, 'must be an object');
  const role = v.role;
  if (!(VARIABLE_ROLES as readonly unknown[]).includes(role)) {
    throw new Invalid(`${path}.role`, `must be one of ${VARIABLE_ROLES.join(', ')}`);
  }
  let categories: VariableCategory[] | undefined;
  if (v.categories !== undefined) {
    if (!Array.isArray(v.categories)) throw new Invalid(`${path}.categories`, 'must be a list');
    categories = v.categories.map((c, i) => {
      const p = `${path}.categories[${i}]`;
      if (!isRecord(c) || typeof c.code !== 'string') throw new Invalid(p, 'must have a string code');
      return { code: c.code, label: text(c, 'label', p)! };
    });
  }
  const out: VariableMetadataColumn = {
    name: text(v, 'name', path)!,
    role: role as VariableRole,
    label: text(v, 'label', path)!,
  };
  const optional = ['universe', 'notApplicableLabel', 'positiveValue', 'positiveLabel', 'unit', 'geoLevel'] as const;
  for (const key of optional) {
    const value = text(v, key, path, true);
    if (value !== undefined) out[key] = value;
  }
  if (categories) out.categories = categories;
  const missing = codes(v.missingCodes, `${path}.missingCodes`);
  if (missing) out.missingCodes = missing;
  if (out.role === 'dichotomous' && out.positiveValue === undefined) {
    throw new Invalid(`${path}.positiveValue`, 'a dichotomous variable needs the code that counts as "yes"');
  }
  return out;
}

function metadata(v: unknown): VariableMetadata {
  if (!isRecord(v)) throw new Invalid('metadata', 'must be an object');
  if (v.version !== 1) throw new Invalid('metadata.version', 'must be 1');
  if (!(SOURCE_DESIGNS as readonly unknown[]).includes(v.design)) {
    throw new Invalid('metadata.design', 'must be census or sample');
  }
  if (v.edition !== undefined && v.edition !== null && !Number.isInteger(v.edition)) {
    throw new Invalid('metadata.edition', 'must be a whole number or null');
  }
  if (!isRecord(v.total)) throw new Invalid('metadata.total', 'must be an object');
  if (!Array.isArray(v.columns) || v.columns.length === 0) {
    throw new Invalid('metadata.columns', 'must be a non-empty list');
  }
  const columns = v.columns.map((c, i) => column(c, `metadata.columns[${i}]`));
  const seen = new Set<string>();
  for (const [i, c] of columns.entries()) {
    if (seen.has(c.name)) throw new Invalid(`metadata.columns[${i}].name`, `"${c.name}" is repeated`);
    seen.add(c.name);
  }
  for (const role of ['weight', 'stratum', 'psu'] as const) {
    if (columns.filter((c) => c.role === role).length > 1) {
      throw new Invalid('metadata.columns', `only one column can have the role "${role}"`);
    }
  }
  return {
    version: 1,
    title: text(v, 'title', 'metadata')!,
    source: text(v, 'source', 'metadata')!,
    edition: (v.edition as number | null | undefined) ?? null,
    design: v.design as VariableMetadata['design'],
    unit: text(v, 'unit', 'metadata')!,
    unitPlural: text(v, 'unitPlural', 'metadata')!,
    total: {
      level: text(v.total, 'level', 'metadata.total')!,
      code: text(v.total, 'code', 'metadata.total')!,
      label: text(v.total, 'label', 'metadata.total')!,
    },
    columns,
  };
}

/**
 * Checks metadata before it is stored: its shape, and that every column it describes exists in
 * the file (`fileColumns`; skipped when the resource has no stored schema). Throws
 * `400 variable_metadata_invalid` with the path of the first problem.
 */
export function parseVariableMetadata(value: unknown, fileColumns: string[] | null): VariableMetadata {
  try {
    const parsed = metadata(value);
    if (fileColumns) {
      const known = new Set(fileColumns);
      const i = parsed.columns.findIndex((c) => !known.has(c.name));
      if (i >= 0) {
        throw new Invalid(`metadata.columns[${i}].name`, `the file has no column "${parsed.columns[i].name}"`);
      }
    }
    return parsed;
  } catch (err) {
    if (!(err instanceof Invalid)) throw err;
    throw new BadRequestException({
      code: 'variable_metadata_invalid',
      message: `Invalid variable metadata: ${err.message}.`,
      params: { path: err.path, problem: err.problem },
    });
  }
}

/** Stored metadata, or `null` when there is none or it no longer has a valid shape. */
export function readVariableMetadata(value: unknown): VariableMetadata | null {
  if (value === null || value === undefined) return null;
  try {
    return metadata(value);
  } catch {
    return null;
  }
}

export function columnOf(metadata: VariableMetadata, name: string): VariableMetadataColumn | null {
  return metadata.columns.find((c) => c.name === name) ?? null;
}

export function columnWithRole(metadata: VariableMetadata, role: VariableRole): VariableMetadataColumn | null {
  return metadata.columns.find((c) => c.role === role) ?? null;
}
