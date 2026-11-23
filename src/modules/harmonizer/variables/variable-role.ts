import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CodebookCategory } from '../codebook.js';
import type { ValueType } from '../harmonized-view.js';

/**
 * What can be done with a canonical variable in an analysis (template proposal §3.2, plan
 * `planes-pendientes/plantillas-analisis.md`, phase 1). The sample design roles (weight, stratum,
 * PSU) are not here: they belong to the mapping of each edition and win over these.
 */
export const VARIABLE_ROLES = [
  'category',
  'ordinal',
  'dichotomous',
  'geographic',
  'label',
  'temporal',
  'measure',
  'socioeconomic_stratum',
  'key',
  'identifier',
  'free_text',
] as const;
export type VariableRole = (typeof VARIABLE_ROLES)[number];

/** Roles whose values are codes: they stay text, so `001` is not turned into `1`. */
export const CODED_ROLES: readonly VariableRole[] = [
  'category',
  'ordinal',
  'dichotomous',
  'geographic',
  'socioeconomic_stratum',
  'key',
  'identifier',
];

/** Roles a result can be split by (disaggregations). */
const DISAGGREGABLE_ROLES: readonly VariableRole[] = [
  'category',
  'ordinal',
  'dichotomous',
  'geographic',
  'socioeconomic_stratum',
  'measure',
  'temporal',
];

/** Territorial levels, from the largest. The web shows them in Spanish. */
export const GEO_LEVELS = [
  'country',
  'state',
  'municipality',
  'locality',
  'ageb',
  'block',
] as const;
export type GeoLevel = (typeof GEO_LEVELS)[number];

export interface AgeCut {
  /** Inclusive bounds; `to: null` is open ("60 años y más"). */
  from: number;
  to: number | null;
  label: string;
}

export interface Disaggregation {
  /** Whether its categories add up to the whole (so "Todos" is their sum). */
  summable: boolean;
  /** Measure only: the groups it is cut into, in order and without overlap. */
  cuts?: AgeCut[];
  /** Label of an empty cell ("no aplica") when the variable is a group. */
  notApplicableLabel?: string;
  /** Geographic only: the most detailed level the source is representative at. */
  maxLevel?: GeoLevel;
}

/** How a canonical variable is used in analysis. Every field `null` = not described yet. */
export interface VariableAnalysis {
  role: VariableRole | null;
  universe: string | null;
  positiveValue: string | null;
  geoLevel: GeoLevel | null;
  unit: string | null;
  disaggregation: Disaggregation | null;
}

/** What is sent to save it; empty texts count as not given. */
export interface VariableAnalysisInput {
  role?: string | null;
  universe?: string | null;
  positiveValue?: string | null;
  geoLevel?: string | null;
  unit?: string | null;
  disaggregation?: {
    summable: boolean;
    cuts?: AgeCut[];
    notApplicableLabel?: string | null;
    maxLevel?: string | null;
  } | null;
}

export const isRole = (v: unknown): v is VariableRole =>
  (VARIABLE_ROLES as readonly unknown[]).includes(v);
const isGeoLevel = (v: unknown): v is GeoLevel =>
  (GEO_LEVELS as readonly unknown[]).includes(v);

/** Whether a variable with this role may have this confirmed type (`null` = unconfirmed). */
export function roleAllowsType(
  role: VariableRole,
  dataType: ValueType | null,
): boolean {
  if (role === 'measure')
    return dataType === 'integer' || dataType === 'decimal';
  if (CODED_ROLES.includes(role))
    return dataType === null || dataType === 'text';
  return true;
}

/** `409 variable_role_type_mismatch`: the role and the confirmed type do not go together. */
export function roleTypeMismatch(
  variable: string,
  role: VariableRole,
  dataType: ValueType | null,
): ConflictException {
  const message =
    role === 'measure'
      ? `Variable "${variable}" can only be a measure once its type is confirmed as a number (integer or decimal) in the mapping; it is ${dataType ?? 'not confirmed'}.`
      : `Variable "${variable}" has codes as values (role "${role}"), so its type must be text or unconfirmed, not ${dataType}. Change the role or the type first.`;
  return new ConflictException({
    code: 'variable_role_type_mismatch',
    message,
    params: { variable, role, dataType },
  });
}

/**
 * Whether a variable keeps its «No especificado» codes in the views and downloads (D1 of the
 * templates plan): variables of codes do, so «no especificado» (the code) and «no aplica» (an
 * empty cell, `null`) stay apart. Measures and variables without a role turn the code into
 * `null`, so nobody averages a `999` (D13). Those roles are always text (`roleAllowsType`), so a
 * kept code never breaks the column's type.
 */
export function keepsMissingCodes(role: string | null): boolean {
  return isRole(role) && CODED_ROLES.includes(role);
}

/** The type a variable is downloaded with when nobody confirmed one: codes stay text. */
export function unconfirmedTypeOf(role: string | null): ValueType | null {
  return isRole(role) && CODED_ROLES.includes(role) ? 'text' : null;
}

function invalid(field: string, problem: string, message: string): never {
  throw new BadRequestException({
    code: 'variable_analysis_invalid',
    message,
    params: { field, problem },
  });
}

const text = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? '';
  return t === '' ? null : t;
};

/**
 * Checks and normalizes what is sent for a variable. Each field must fit the role (a "yes"
 * code only on a dichotomous variable, a level only on a geographic one, cuts only on a
 * measure), the role must fit the confirmed type, and the "yes" code must be one of `known`:
 * the common catalog of the variable or, without one, the values seen in its editions.
 */
export function checkAnalysis(
  input: VariableAnalysisInput,
  variable: { name: string; dataType: ValueType | null; known: string[] },
): VariableAnalysis {
  const roleText = text(input.role ?? null);
  if (roleText !== null && !isRole(roleText)) {
    invalid(
      'role',
      'unknown',
      `Role must be one of: ${VARIABLE_ROLES.join(', ')}.`,
    );
  }
  const role = roleText as VariableRole | null;
  const out: VariableAnalysis = {
    role,
    universe: text(input.universe),
    positiveValue: text(input.positiveValue),
    geoLevel: null,
    unit: text(input.unit),
    disaggregation: null,
  };
  const geoText = text(input.geoLevel);
  if (geoText !== null && !isGeoLevel(geoText)) {
    invalid(
      'geoLevel',
      'unknown',
      `The level must be one of: ${GEO_LEVELS.join(', ')}.`,
    );
  }
  out.geoLevel = geoText as GeoLevel | null;

  if (role === null) {
    for (const field of [
      'universe',
      'positiveValue',
      'geoLevel',
      'unit',
    ] as const) {
      if (out[field] !== null) {
        invalid(
          field,
          'role_required',
          `Choose a role before setting "${field}".`,
        );
      }
    }
    if (input.disaggregation) {
      invalid(
        'disaggregation',
        'role_required',
        'Choose a role before setting "disaggregation".',
      );
    }
    return out;
  }

  if (!roleAllowsType(role, variable.dataType)) {
    throw roleTypeMismatch(variable.name, role, variable.dataType);
  }
  if (role === 'dichotomous') {
    if (out.positiveValue === null) {
      invalid(
        'positiveValue',
        'required',
        'A yes/no variable needs the code that counts as "yes".',
      );
    }
    if (!variable.known.includes(out.positiveValue)) {
      throw new BadRequestException({
        code: 'variable_positive_value_unknown',
        message: `"${out.positiveValue}" is not a code of variable "${variable.name}".`,
        params: {
          value: out.positiveValue,
          known: variable.known.slice(0, 20),
        },
      });
    }
  } else if (out.positiveValue !== null) {
    invalid(
      'positiveValue',
      'not_for_role',
      'Only a yes/no (dichotomous) variable has a "yes" code.',
    );
  }
  if (role === 'geographic') {
    if (out.geoLevel === null) {
      invalid('geoLevel', 'required', 'A geographic variable needs its level.');
    }
  } else if (out.geoLevel !== null) {
    invalid(
      'geoLevel',
      'not_for_role',
      'Only a geographic variable has a level.',
    );
  }
  if (role !== 'measure' && out.unit !== null) {
    invalid('unit', 'not_for_role', 'Only a measure has a unit.');
  }

  const d = input.disaggregation;
  if (d) {
    if (!DISAGGREGABLE_ROLES.includes(role)) {
      invalid(
        'disaggregation',
        'not_for_role',
        `A variable with role "${role}" cannot split a result.`,
      );
    }
    const disaggregation: Disaggregation = { summable: d.summable };
    if (d.cuts && d.cuts.length > 0) {
      if (role !== 'measure') {
        invalid(
          'disaggregation.cuts',
          'not_for_role',
          'Only a measure is cut into groups.',
        );
      }
      disaggregation.cuts = checkCuts(d.cuts);
    }
    const notApplicable = text(d.notApplicableLabel);
    if (notApplicable !== null)
      disaggregation.notApplicableLabel = notApplicable;
    const maxLevel = text(d.maxLevel);
    if (maxLevel !== null) {
      if (role !== 'geographic') {
        invalid(
          'disaggregation.maxLevel',
          'not_for_role',
          'Only a geographic variable has a most detailed level.',
        );
      }
      if (!isGeoLevel(maxLevel)) {
        invalid(
          'disaggregation.maxLevel',
          'unknown',
          `The level must be one of: ${GEO_LEVELS.join(', ')}.`,
        );
      }
      disaggregation.maxLevel = maxLevel;
    }
    out.disaggregation = disaggregation;
  }
  return out;
}

/** Cuts in order, each with a label, `from <= to`, without overlap; only the last may be open. */
function checkCuts(cuts: AgeCut[]): AgeCut[] {
  const out = cuts.map((c, i) => {
    const label = text(c.label);
    const field = `disaggregation.cuts[${i}]`;
    if (label === null)
      invalid(field, 'label_required', `Group ${i + 1} needs a label.`);
    if (!Number.isFinite(c.from) || (c.to !== null && !Number.isFinite(c.to))) {
      invalid(
        field,
        'not_a_number',
        `The bounds of group ${i + 1} must be numbers.`,
      );
    }
    if (c.to !== null && c.to < c.from) {
      invalid(field, 'bounds', `Group ${i + 1} ends before it starts.`);
    }
    if (c.to === null && i !== cuts.length - 1) {
      invalid(
        field,
        'open_not_last',
        'Only the last group can be open ("y más").',
      );
    }
    if (i > 0) {
      const prev = cuts[i - 1];
      if (prev.to === null || c.from <= prev.to) {
        invalid(
          field,
          'overlap',
          `Group ${i + 1} overlaps the previous one or is out of order.`,
        );
      }
    }
    return { from: c.from, to: c.to, label };
  });
  return out;
}

/** The stored analysis of a variable, or every field null; a stored value of another shape reads as null. */
export function readAnalysis(v: {
  role: string | null;
  universe: string | null;
  positiveValue: string | null;
  geoLevel: string | null;
  unit: string | null;
  disaggregation: unknown;
}): VariableAnalysis {
  const d = v.disaggregation;
  const disaggregation =
    d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    typeof (d as Disaggregation).summable === 'boolean'
      ? (d as Disaggregation)
      : null;
  return {
    role: isRole(v.role) ? v.role : null,
    universe: v.universe,
    positiveValue: v.positiveValue,
    geoLevel: isGeoLevel(v.geoLevel) ? v.geoLevel : null,
    unit: v.unit,
    disaggregation,
  };
}

/**
 * The role the data suggest (proposal §4.4); the user confirms it. From the dictionary: a
 * catalog (such as the states') is geographic, a range of values a measure, two coded values
 * yes/no, more a category. Without a dictionary, from the common catalog (two codes yes/no,
 * more a category) or a confirmed numeric type (a measure). `null`: nothing to go on.
 */
export function suggestRole(
  dictionary: CodebookCategory[] | null,
  catalog: { code: string }[],
  dataType: ValueType | null,
): VariableRole | null {
  if (dictionary && dictionary.length > 0) {
    if (dictionary.some((c) => c.kind === 'catalog')) return 'geographic';
    const values = dictionary.filter((c) => c.kind === 'value').length;
    if (values === 2) return 'dichotomous';
    if (values > 2) return 'category';
    if (dictionary.some((c) => c.kind === 'range')) return 'measure';
  }
  if (catalog.length === 2) return 'dichotomous';
  if (catalog.length > 2) return 'category';
  if (dataType === 'integer' || dataType === 'decimal') return 'measure';
  return null;
}
