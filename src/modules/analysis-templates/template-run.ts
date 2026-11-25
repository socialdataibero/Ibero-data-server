import { BadRequestException, NotFoundException } from '@nestjs/common';
import { quoteIdent } from '../analysis/recipe.js';
import {
  ratioEstimatesSql,
  readRatioEstimates,
  type RatioEstimate,
  type RatioQuery,
} from '../analysis/standard-error.js';
import { checkCells, combinations, origin, resolveBreakdowns } from './breakdowns.js';
import {
  columnOf,
  columnWithRole,
  type TemplateEdition,
  type VariableMetadata,
  type VariableMetadataColumn,
} from './template-metadata.js';
import {
  findTemplate,
  type InputSpec,
  type MissingChoice,
  type TemplateDefinition,
} from './template-catalog.js';

/**
 * Runs one template over one resource: checks the choices against the variable metadata, builds
 * the DuckDB queries (one ratio estimate per domain set, with its standard error) and turns their
 * rows into the result table of the proposal (section 3.6) with its roles, texts and warnings
 * (section 5.4). The orchestrator of the full plan will replace the hand-written SQL of each
 * template with recipes generated from JSON contracts; the shape of the answer stays.
 */

export interface TemplateRequest {
  templateId: string;
  variable?: string;
  conditions?: string[];
  measure?: string;
  group?: string | null;
  /** Variables that split every figure further; the result has each combination and its «Todos». */
  breakdowns?: string[];
  missing?: MissingChoice;
  /** The edition of the analysis, when the resource has several (`template_edition_required`). */
  edition?: string | null;
}

/** One row of the result table. Column names are those of the proposal (section 3.6). */
export interface ResultRow {
  fuente: string;
  edicion: number | null;
  indicador: string;
  criterio: string | null;
  nivel: string;
  cve: string;
  nombre: string;
  grupo_codigo: string | null;
  grupo: string | null;
  corte_codigo: string | null;
  corte: string | null;
  /** Category code of each breakdown (by column); `null` is «Todos» and `''` an empty cell. */
  desagregaciones: Record<string, string | null>;
  num: number;
  den: number;
  den_total: number | null;
  ee: number | null;
  ee_total: number | null;
  casos: number;
  /** The row of the whole file ("Todo el país"; here, the place in `metadata.total`). */
  es_total: boolean;
}

export type Base = 'own' | 'total';

export interface TemplateWarning {
  code: string;
  message: string;
  /** Only true of this base of a proportion; absent when it is true of every view. */
  base?: Base;
}

export interface TemplateResult {
  template: { id: string; version: number; contract: string; name: string };
  source: { title: string; design: string; unitPlural: string };
  /** The edition the figures are about. */
  edition: TemplateEdition;
  inputs: {
    variable: string | null;
    conditions: string[];
    measure: string | null;
    group: string | null;
    breakdowns: string[];
    missing: MissingChoice | null;
  };
  /** Which result columns are what, so a chart can be built without reading the template. */
  dimensions: {
    group: { column: 'nombre' | 'grupo'; codeColumn: 'cve' | 'grupo_codigo'; label: string; role: string } | null;
    series: { column: 'criterio' | 'corte'; codeColumn: 'criterio' | 'corte_codigo'; label: string } | null;
    breakdowns: { column: string; label: string; categories: { code: string; label: string }[] }[];
  };
  value: { kind: 'proportion' | 'mean'; label: string; unit: string | null };
  bases: { id: Base | 'both'; label: string; note: string; description: string }[] | null;
  texts: { title: string; question: string; note: string; missing: string | null };
  warnings: TemplateWarning[];
  charts: { recommended: string; compatible: string[] };
  rows: ResultRow[];
}

/** A query to run, and how to read its rows. */
export interface PlannedQuery {
  sql: string;
  read(rows: unknown[][]): unknown;
}

const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** SQL of the value of a column: the column itself, or its expression (groups of a measure). */
const valueSql = (column: VariableMetadataColumn) => column.expression ?? quoteIdent(column.name);
const code = (column: VariableMetadataColumn) => `CAST(${valueSql(column)} AS VARCHAR)`;
/** Leaves names in capitals (a variable without a description, e.g. "HLENGUA") as they are. */
const lowerFirst = (s: string) => (/^.[A-ZÁÉÍÓÚÑ0-9_]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const count = (n: number) => new Intl.NumberFormat('es-MX').format(n);

/** Provisional thresholds of the interactive preview: cv above 30% is low precision. */
export const LOW_PRECISION_CV = 0.3;
/** Provisional: a figure based on fewer records than this is flagged (section 8.2 is pending). */
export const FEW_CASES = 3;

function bad(code: string, message: string, params?: Record<string, unknown>): never {
  throw new BadRequestException({ code, message, ...(params ? { params } : {}) });
}

/** `col NOT IN (missing codes)`, or nothing when there are none or they are included. */
function notMissing(column: VariableMetadataColumn, include: boolean): string {
  const codes = column.missingCodes ?? [];
  return include || codes.length === 0 ? '' : ` AND ${code(column)} NOT IN (${codes.map(lit).join(', ')})`;
}

/** The universe rule of `column` as SQL (`EDAD >= 15`, false without a value), or `null`. */
function ruleSql(column: VariableMetadataColumn): string | null {
  const rule = column.universeRule;
  return rule ? `COALESCE(TRY_CAST(${quoteIdent(rule.column)} AS DOUBLE) >= ${Number(rule.min)}, false)` : null;
}

/** In the universe of `column`: it was asked (not empty) and, with a rule, the rule holds. */
function inUniverse(column: VariableMetadataColumn): string {
  const rule = ruleSql(column);
  return `${valueSql(column)} IS NOT NULL${rule ? ` AND ${rule}` : ''}`;
}

/** A group's key: its value, or empty ("no aplica") outside its universe rule. */
function groupKeySql(column: VariableMetadataColumn): string {
  const rule = ruleSql(column);
  return rule ? `CASE WHEN ${rule} THEN ${valueSql(column)} END` : valueSql(column);
}

/** Label of a code of `column`: its category label, "No aplica" for an empty cell, or the code. */
function labelOf(column: VariableMetadataColumn, value: string): string {
  if (value === '') return column.notApplicableLabel ?? 'No aplica';
  return column.categories?.find((c) => c.code === value)?.label ?? value;
}

/** Sort position of a code of `column`: catalog order, then unknown codes, then "no aplica". */
function orderOf(column: VariableMetadataColumn, value: string): number {
  if (value === '') return 1e9;
  const i = column.categories?.findIndex((c) => c.code === value) ?? -1;
  return i >= 0 ? i : 1e6;
}

interface Plan {
  template: TemplateDefinition;
  metadata: VariableMetadata;
  variable: VariableMetadataColumn | null;
  conditions: VariableMetadataColumn[];
  measure: VariableMetadataColumn | null;
  group: VariableMetadataColumn | null;
  breakdowns: VariableMetadataColumn[];
  include: boolean;
  missing: MissingChoice | null;
  design: Pick<RatioQuery, 'weight' | 'stratum' | 'psu' | 'certainty'>;
}

function resolveInput(
  spec: InputSpec,
  name: string | undefined | null,
  metadata: VariableMetadata,
): VariableMetadataColumn | null {
  if (name === undefined || name === null || name === '') {
    if (!spec.optional) bad('template_input_required', `Choose a variable for "${spec.name}".`, { input: spec.name });
    return null;
  }
  const column = columnOf(metadata, name);
  if (!column) {
    bad('template_input_unknown', `"${name}" is not a variable described in this resource's metadata.`, {
      input: spec.name,
      variable: name,
    });
  }
  if (!spec.roles.includes(column.role)) {
    bad(
      'template_input_role_mismatch',
      `"${column.label}" cannot be used as "${spec.name}": this template needs a variable with role ${spec.roles.join(' or ')}.`,
      { input: spec.name, variable: name, role: column.role, roles: spec.roles },
    );
  }
  const categories = column.categories?.length ?? 0;
  if (spec.maxCategories !== undefined && categories > spec.maxCategories) {
    bad(
      'template_too_many_categories',
      `"${column.label}" has ${categories} categories and "${spec.name}" takes at most ${spec.maxCategories}.`,
      { input: spec.name, variable: name, categories, max: spec.maxCategories },
    );
  }
  return column;
}

/** Checks the choices of `request` against the template and the metadata. */
export function planTemplate(request: TemplateRequest, metadata: VariableMetadata | null): Plan {
  const template = findTemplate(request.templateId);
  if (!template) {
    throw new NotFoundException({
      code: 'template_not_found',
      message: `There is no template "${request.templateId}".`,
      params: { templateId: request.templateId },
    });
  }
  if (!metadata) {
    bad(
      'template_no_metadata',
      'This resource has no source metadata from the harmonizer, so no template can use it. Save it again from the harmonizer.',
    );
  }
  const spec = (name: string) => template.inputs.find((i) => i.name === name);

  const conditionSpec = spec('conditions');
  let conditions: VariableMetadataColumn[] = [];
  if (conditionSpec) {
    const names = [...new Set(request.conditions ?? [])];
    const { min, max } = conditionSpec.multiple!;
    if (names.length < min || names.length > max) {
      bad('template_input_count', `Choose between ${min} and ${max} conditions.`, { input: 'conditions', min, max });
    }
    conditions = names.map((n) => resolveInput(conditionSpec, n, metadata)!);
  }
  const variableSpec = spec('variable');
  const variable = variableSpec ? resolveInput(variableSpec, request.variable, metadata) : null;
  const measureSpec = spec('measure');
  const measure = measureSpec ? resolveInput(measureSpec, request.measure, metadata) : null;
  const group = resolveInput(spec('group')!, request.group, metadata);

  const main = [...conditions, variable, measure].filter((c): c is VariableMetadataColumn => c !== null);
  for (const c of [...main, group]) {
    if (c?.universeRule && !metadata.fileColumns.includes(c.universeRule.column)) {
      bad(
        'template_universe_variable_missing',
        `The universe of "${c.label}" depends on "${c.universeRule.column}", which is not in this resource. Save the harmonized view again with that variable.`,
        { variable: c.name, universeVariable: c.universeRule.column },
      );
    }
  }
  if (group && main.some((c) => origin(c) === origin(group))) {
    bad(
      'template_variable_in_two_roles',
      `"${group.label}" is already being measured and cannot also split the result.`,
      { variable: group.name },
    );
  }

  const breakdowns = resolveBreakdowns(
    request.breakdowns ?? [],
    spec('breakdowns')!.roles,
    metadata,
    group ? [...main, group] : main,
  );
  checkCells(group, breakdowns, variable);

  const weight = columnWithRole(metadata, 'weight');
  const stratum = columnWithRole(metadata, 'stratum');
  const psu = columnWithRole(metadata, 'psu');
  if (metadata.design === 'sample' && !weight) {
    bad('template_factor_required', 'This source is a sample and has no expansion factor declared.');
  }
  const sample = metadata.design === 'sample';
  const withDesign = sample && stratum !== null && psu !== null;
  const missing = template.missingInput ? (request.missing ?? 'exclude') : null;

  return {
    template,
    metadata,
    variable,
    conditions,
    measure,
    group,
    breakdowns,
    include: missing === 'include',
    missing,
    design: {
      weight: sample ? quoteIdent(weight!.name) : null,
      stratum: withDesign ? quoteIdent(stratum!.name) : null,
      psu: withDesign ? quoteIdent(psu!.name) : null,
      // Strata enumerated completely add nothing to the variance (`standard-error.ts`, rule 7).
      certainty:
        withDesign && metadata.certainty
          ? `CAST(${quoteIdent(metadata.certainty.column)} AS VARCHAR) IN (${metadata.certainty.codes.map(lit).join(', ')})`
          : null,
    },
  };
}

/** The ratio queries of a plan, each with the domain sets it needs (by group, and the total). */
interface RatioSet {
  id: string;
  /** The breakdowns it is split by; the others are «Todos». */
  split: VariableMetadataColumn[];
  byGroup: RatioQuery | null;
  total: RatioQuery;
}

function ratioSets(plan: Plan): RatioSet[] {
  return combinations(plan.breakdowns).flatMap((split) => ratioSetsOf(plan, split));
}

/** The keys of a domain are the group (in `byGroup`), the breakdowns of `split` and `extraKeys`. */
function ratioSetsOf(plan: Plan, split: VariableMetadataColumn[]): RatioSet[] {
  const groupKey = plan.group ? [groupKeySql(plan.group)] : [];
  const splitKeys = split.map(valueSql);
  const both = (
    id: string,
    q: Omit<RatioQuery, 'keys' | 'weight' | 'stratum' | 'psu' | 'certainty'>,
    extraKeys: string[] = [],
  ) => ({
    id,
    split,
    byGroup: plan.group ? { ...plan.design, ...q, keys: [...groupKey, ...splitKeys, ...extraKeys] } : null,
    total: { ...plan.design, ...q, keys: [...splitKeys, ...extraKeys] },
  });

  if (plan.template.id === 'proportion') {
    return plan.conditions.flatMap((c) => {
      const rule = ruleSql(c);
      const y = `${rule ? `${rule} AND ` : ''}${code(c)} = ${lit(c.positiveValue!)}`;
      const den = `${inUniverse(c)}${notMissing(c, plan.include)}`;
      return [
        both(`own:${c.name}`, { source: 'data', y, x: den, cases: y }),
        both(`total:${c.name}`, { source: 'data', y, x: 'true', cases: y }),
      ];
    });
  }
  if (plan.template.id === 'weighted_mean') {
    const m = plan.measure!;
    const valid = `${inUniverse(m)}${notMissing(m, false)}`;
    return [
      both('mean', {
        source: 'data',
        y: `CASE WHEN ${valid} THEN CAST(${quoteIdent(m.name)} AS DOUBLE) ELSE 0 END`,
        x: valid,
        cases: valid,
      }),
    ];
  }
  // Distribution: every row once per category of the variable, so each category is a domain key.
  const v = plan.variable!;
  const den = `${inUniverse(v)}${notMissing(v, plan.include)}`;
  const y = `${den} AND ${code(v)} = _c._cat`;
  return [
    both(
      'distribution',
      {
        source: `data CROSS JOIN (SELECT DISTINCT ${code(v)} AS _cat FROM data WHERE ${den}) AS _c`,
        y,
        x: den,
        cases: y,
      },
      ['_c._cat'],
    ),
  ];
}

/** How many records of `column` (inside its universe rule) have a "not specified" code. */
function missingCountSql(column: VariableMetadataColumn): string {
  const codes = column.missingCodes ?? [];
  const rule = ruleSql(column);
  return codes.length === 0
    ? 'SELECT 0'
    : `SELECT (count(*) FILTER (WHERE ${code(column)} IN (${codes.map(lit).join(', ')})${rule ? ` AND ${rule}` : ''}))::INTEGER FROM data`;
}

/** The queries to run for a plan, in order (`AnalysisService.runInternalQueries`). */
export function planQueries(plan: Plan): { sets: RatioSet[]; queries: PlannedQuery[] } {
  const sets = ratioSets(plan);
  const queries: PlannedQuery[] = [];
  for (const set of sets) {
    for (const q of [set.byGroup, set.total]) {
      if (q) queries.push({ sql: ratioEstimatesSql(q), read: (rows) => readRatioEstimates(q, rows) });
    }
  }
  const counted = plan.template.missingInput ? [...plan.conditions, plan.variable].filter((c) => c !== null) : [];
  for (const c of counted) {
    queries.push({ sql: missingCountSql(c!), read: (rows) => Number(rows[0]?.[0] ?? 0) });
  }
  // A mean with a universe rule: the records inside it, to say how many had no value.
  const meanRule = plan.template.id === 'weighted_mean' ? ruleSql(plan.measure!) : null;
  if (meanRule) {
    queries.push({
      sql: `SELECT (count(*) FILTER (WHERE ${meanRule}))::INTEGER FROM data`,
      read: (rows) => Number(rows[0]?.[0] ?? 0),
    });
  }
  return { sets, queries };
}

/** One estimate with what its domain keys mean. */
interface Figure {
  estimate: RatioEstimate;
  groupCode: string | null;
  desagregaciones: Record<string, string | null>;
  /** The key after the breakdowns: the category of a distribution. */
  category: string;
}

function figure(plan: Plan, split: VariableMetadataColumn[], estimate: RatioEstimate, grouped: boolean): Figure {
  const start = grouped ? 1 : 0;
  return {
    estimate,
    groupCode: grouped ? estimate.keys[0] : null,
    desagregaciones: Object.fromEntries(
      plan.breakdowns.map((c) => {
        const i = split.indexOf(c);
        return [c.name, i < 0 ? null : estimate.keys[start + i]];
      }),
    ),
    category: estimate.keys[start + split.length] ?? '',
  };
}

const cv = (se: number | null, value: number) => (se === null || value === 0 ? null : se / value);

/** Turns the answers of `planQueries(plan)` (in the same order) into the result. */
export function assembleResult(plan: Plan, answers: unknown[]): TemplateResult {
  const { metadata, group, template } = plan;
  const { sets } = planQueries(plan);
  const estimates = new Map<string, Figure[]>();
  let i = 0;
  for (const set of sets) {
    const byGroup = set.byGroup ? (answers[i++] as RatioEstimate[]) : [];
    const total = answers[i++] as RatioEstimate[];
    const figures = estimates.get(set.id) ?? [];
    figures.push(...byGroup.map((e) => figure(plan, set.split, e, true)), ...total.map((e) => figure(plan, set.split, e, false)));
    estimates.set(set.id, figures);
  }
  const missingCounts = answers.slice(i) as number[];

  const geographic = group?.role === 'geographic';
  const place = (groupCode: string | null) =>
    group && geographic && groupCode !== null
      ? { nivel: group.geoLevel ?? lowerFirst(group.label), cve: groupCode, nombre: labelOf(group, groupCode) }
      : { nivel: metadata.total.level, cve: metadata.total.code, nombre: metadata.total.label };
  const groupColumns = (groupCode: string | null) =>
    group && !geographic
      ? groupCode === null
        ? { grupo_codigo: null, grupo: 'Todos' }
        : { grupo_codigo: groupCode, grupo: labelOf(group, groupCode) }
      : { grupo_codigo: null, grupo: null };
  const base = { fuente: metadata.source, edicion: metadata.edition };
  const groupOrder = (row: ResultRow) =>
    row.es_total ? 2e9 : group ? orderOf(group, geographic ? row.cve : (row.grupo_codigo ?? '')) : 0;
  // «Todos» first, then the categories in catalog order.
  const breakdownOrder = (a: ResultRow, b: ResultRow) => {
    for (const c of plan.breakdowns) {
      const at = (r: ResultRow) => {
        const value = r.desagregaciones[c.name];
        return value === null ? -1 : orderOf(c, value);
      };
      if (at(a) !== at(b)) return at(a) - at(b);
    }
    return 0;
  };
  const byRow = (a: ResultRow, b: ResultRow) => groupOrder(a) - groupOrder(b) || breakdownOrder(a, b);

  let rows: ResultRow[] = [];
  let indicator: string;
  // Records of the whole file left out of a mean for having no value of the measure.
  let meanExcluded = 0;
  if (template.id === 'proportion') {
    indicator = plan.conditions.map((c) => c.positiveLabel ?? c.label).join(' y ');
    for (const c of plan.conditions) {
      const own = estimates.get(`own:${c.name}`)!;
      const total = estimates.get(`total:${c.name}`)!;
      const criterio = `${c.positiveLabel ?? c.label}, ${c.universe ?? 'toda la población'}`;
      const build = ({ estimate: o, groupCode, desagregaciones }: Figure, t: RatioEstimate | undefined): ResultRow => ({
        ...base,
        indicador: indicator,
        criterio,
        ...place(groupCode),
        ...groupColumns(groupCode),
        corte_codigo: null,
        corte: null,
        desagregaciones,
        num: o.y,
        den: o.x,
        den_total: t?.x ?? null,
        ee: o.se,
        ee_total: t?.se ?? null,
        casos: o.cases,
        es_total: groupCode === null,
      });
      const keyOf = (e: Figure) => JSON.stringify([e.groupCode, Object.values(e.desagregaciones)]);
      const totalsByKey = new Map(total.map((t) => [keyOf(t), t.estimate]));
      rows.push(...own.map((o) => build(o, totalsByKey.get(keyOf(o)))).sort(byRow));
    }
  } else if (template.id === 'weighted_mean') {
    const m = plan.measure!;
    indicator = `${m.label} promedio${m.unit ? ` (${m.unit})` : ''}`;
    const figures = estimates.get('mean')!;
    const whole = figures.find((e) => e.groupCode === null && Object.values(e.desagregaciones).every((v) => v === null))!;
    // With a universe rule, only the records inside it that have no value are "left out".
    const inRule = m.universeRule ? (missingCounts[0] ?? whole.estimate.rows) : whole.estimate.rows;
    meanExcluded = inRule - whole.estimate.cases;
    const build = ({ estimate: e, groupCode, desagregaciones }: Figure): ResultRow => ({
      ...base,
      indicador: indicator,
      criterio: null,
      ...place(groupCode),
      ...groupColumns(groupCode),
      corte_codigo: null,
      corte: null,
      desagregaciones,
      num: e.y,
      den: e.x,
      den_total: null,
      ee: e.se,
      ee_total: null,
      casos: e.cases,
      es_total: groupCode === null,
    });
    rows = figures.map(build).sort(byRow);
  } else {
    const v = plan.variable!;
    indicator = `${v.label}, ${v.universe ?? 'toda la población'}`;
    const build = ({ estimate: e, groupCode, desagregaciones, category }: Figure): ResultRow => ({
      ...base,
      indicador: indicator,
      criterio: null,
      ...place(groupCode),
      ...groupColumns(groupCode),
      corte_codigo: category,
      corte: labelOf(v, category),
      desagregaciones,
      num: e.y,
      den: e.x,
      den_total: null,
      ee: e.se,
      ee_total: null,
      casos: e.cases,
      es_total: groupCode === null,
    });
    rows = estimates
      .get('distribution')!
      .map(build)
      // A group with nobody in the universe of the variable has no distribution.
      .filter((r) => r.den > 0)
      .sort(
        (a, b) =>
          groupOrder(a) - groupOrder(b) ||
          a.cve.localeCompare(b.cve) ||
          (a.grupo_codigo ?? '').localeCompare(b.grupo_codigo ?? '') ||
          breakdownOrder(a, b) ||
          orderOf(v, a.corte_codigo!) - orderOf(v, b.corte_codigo!),
      );
  }

  return {
    template: { id: template.id, version: template.version, contract: template.contract, name: template.name },
    source: { title: metadata.title, design: metadata.design, unitPlural: metadata.unitPlural },
    edition: metadata.editionInfo,
    inputs: {
      variable: plan.variable?.name ?? null,
      conditions: plan.conditions.map((c) => c.name),
      measure: plan.measure?.name ?? null,
      group: group?.name ?? null,
      breakdowns: plan.breakdowns.map((c) => c.name),
      missing: plan.missing,
    },
    dimensions: {
      group: group
        ? {
            column: geographic ? 'nombre' : 'grupo',
            codeColumn: geographic ? 'cve' : 'grupo_codigo',
            label: group.label,
            role: group.role,
          }
        : null,
      series:
        template.id === 'proportion'
          ? { column: 'criterio', codeColumn: 'criterio', label: 'Condición' }
          : template.id === 'distribution'
            ? { column: 'corte', codeColumn: 'corte_codigo', label: plan.variable!.label }
            : null,
      breakdowns: plan.breakdowns.map((c) => ({
        column: c.name,
        label: c.label,
        categories: [...new Set(rows.map((r) => r.desagregaciones[c.name]))]
          .filter((value) => value !== null)
          .sort((a, b) => orderOf(c, a) - orderOf(c, b))
          .map((value) => ({ code: value, label: labelOf(c, value) })),
      })),
    },
    value:
      template.id === 'weighted_mean'
        ? { kind: 'mean', label: `${plan.measure!.label} promedio`, unit: plan.measure!.unit ?? null }
        : { kind: 'proportion', label: 'Porcentaje', unit: null },
    bases: template.id === 'proportion' ? proportionBases(plan) : null,
    texts: texts(plan, indicator, missingCounts, meanExcluded),
    warnings: warnings(plan, rows),
    charts: charts(plan),
    rows,
  };
}

function methodNote(plan: Plan): string {
  return plan.metadata.design === 'sample'
    ? 'Estimación con factor de expansión.'
    : `Conteo de ${plan.metadata.unitPlural}.`;
}

function proportionBases(plan: Plan): TemplateResult['bases'] {
  const method = methodNote(plan);
  return [
    {
      id: 'own',
      label: 'Universo propio',
      note: `Cada criterio sobre su propio universo. ${method}`,
      description:
        'Cada porcentaje se calcula sobre la población a la que se le hizo esa pregunta. Son cifras correctas por separado, pero no se pueden sumar ni comparar como si se refirieran a la misma población.',
    },
    {
      id: 'total',
      label: 'Población total',
      note: `Todos los criterios sobre la población total. ${method}`,
      description:
        'Todos los porcentajes se calculan sobre la población total para que sean comparables. Las condiciones que sólo se preguntan a una parte de la población aparecen más bajas que sobre su propio universo.',
    },
    {
      id: 'both',
      label: 'Ambas',
      note: `Cada criterio sobre su propio universo y sobre la población total. ${method}`,
      description:
        'Cada condición aparece dos veces: sobre su propio universo y sobre la población total. La diferencia entre ambas indica cuánto pesa el universo de la pregunta.',
    },
  ];
}

function texts(
  plan: Plan,
  indicator: string,
  missingCounts: number[],
  meanExcluded: number,
): TemplateResult['texts'] {
  const { metadata, group, template } = plan;
  const people = metadata.unitPlural;
  const inEach = group ? ` en cada ${lowerFirst(group.label)}` : '';
  const crossed = plan.breakdowns.map((c) => lowerFirst(c.label)).join(' y ');
  const byGroup = `${group ? ` por ${lowerFirst(group.label)}` : ''}${crossed ? `, según ${crossed}` : ''}`;
  const sample = metadata.design === 'sample';

  if (template.id === 'proportion') {
    const labels = plan.conditions.map((c) => lowerFirst(c.positiveLabel ?? c.label));
    const missing = missingCounts.reduce((a, b) => a + b, 0);
    const names = plan.conditions.map((c) => lowerFirst(c.label)).join(' y ');
    return {
      title: `${indicator}${byGroup}`,
      question: `¿Qué proporción de las ${people}${inEach} cumple: ${labels.join(', ')}?`,
      note: proportionBases(plan)![0].note,
      missing:
        missing === 0
          ? null
          : plan.include
            ? `Los ${count(missing)} registros con «No especificado» en ${names} cuentan en el total. La proporción se calcula sobre todo el universo de la pregunta, por eso es menor.`
            : `Se excluyen del total ${count(missing)} registros con «No especificado» en ${names}. La proporción se calcula sólo sobre quienes respondieron.`,
    };
  }
  if (template.id === 'weighted_mean') {
    const m = plan.measure!;
    const excluded = meanExcluded;
    // In the data a measure's "not specified" codes are already null: the harmonizer counted them.
    const notSpecified = Math.min(m.missingCount ?? 0, excluded);
    return {
      title: `${m.label} promedio${byGroup}`,
      question: `¿Cuál es la ${lowerFirst(m.label)} promedio de las ${people}${inEach}?`,
      note: sample
        ? 'Promedio ponderado con factor de expansión, calculado sólo con quienes tienen dato.'
        : 'Promedio calculado sólo con quienes tienen dato.',
      missing:
        excluded > 0
          ? `${
              notSpecified === excluded
                ? `Se excluyen ${count(excluded)} registros con «No especificado» en ${lowerFirst(m.label)}`
                : `Se excluyen ${count(excluded)} registros sin dato de ${lowerFirst(m.label)}${notSpecified > 0 ? `, ${count(notSpecified)} de ellos con «No especificado»` : ''}`
            }. El promedio se calcula sólo con quienes tienen dato.`
          : null,
    };
  }
  const v = plan.variable!;
  const universe = v.universe ?? 'toda la población';
  const missing = missingCounts[0] ?? 0;
  return {
    title: upperFirst(`${people} según ${lowerFirst(v.label)}${byGroup}`),
    question: `¿Cómo se reparten las ${people}${inEach} según ${lowerFirst(v.label)}?`,
    note: `${sample ? 'Estimación con factor de expansión.' : `Conteo de ${people}.`} Porcentaje respecto a ${universe.startsWith('toda') ? '' : 'la '}${universe}.`,
    missing:
      missing === 0
        ? null
        : plan.include
          ? `Se muestra «No especificado» como una categoría más. El porcentaje se calcula sobre todo el universo: ${universe}.`
          : `Se excluyen ${count(missing)} registros con «No especificado». El porcentaje se calcula sólo sobre quienes respondieron, por eso es mayor que si se incluyeran.`,
  };
}

function warnings(plan: Plan, rows: ResultRow[]): TemplateWarning[] {
  const out: TemplateWarning[] = [];
  const { metadata, template } = plan;
  const sample = metadata.design === 'sample';
  if (!sample) {
    out.push({ code: 'census_source', message: 'Fuente censal: las cifras no tienen error de muestreo.' });
  } else if (plan.design.stratum === null) {
    out.push({
      code: 'precision_not_available',
      message: 'La fuente no declara estrato y UPM: no se puede calcular la precisión de las cifras.',
    });
  }

  const ratio = (num: number, den: number | null) => (den ? num / den : null);
  const low = (pick: (r: ResultRow) => { se: number | null; value: number | null }) =>
    rows.some((r) => {
      const { se, value } = pick(r);
      const c = value === null ? null : cv(se, value);
      return c !== null && c > LOW_PRECISION_CV && value !== 0 && value !== 1;
    });

  if (template.id === 'proportion') {
    const universes = new Set(plan.conditions.map((c) => c.universe ?? ''));
    if (universes.size > 1) {
      out.push({
        code: 'different_universes',
        base: 'own',
        message: 'Las condiciones tienen universos distintos: sus porcentajes no son directamente comparables.',
      });
    }
    out.push({ code: 'missing_no_effect', base: 'total', message: 'El botón de no especificados no cambia la cifra con esta base.' });
    if (rows.some((r) => r.den === 0 && (r.den_total ?? 0) > 0)) {
      out.push({
        code: 'empty_universe',
        base: 'own',
        message: 'En algunos grupos nadie pertenece al universo de la pregunta: se muestran como «sin población en el universo», no como 0%.',
      });
    }
    for (const [b, den] of [
      ['own', (r: ResultRow) => r.den],
      ['total', (r: ResultRow) => r.den_total ?? 0],
    ] as const) {
      if (sample && rows.some((r) => !r.es_total && den(r) > 0 && (r.num === 0 || r.num === den(r)))) {
        out.push({
          code: 'extreme_proportions',
          base: b,
          message: 'En algunos grupos la proporción es 0% o 100%; su precisión no se puede calcular.',
        });
      }
      const se = (r: ResultRow) => (b === 'own' ? r.ee : r.ee_total);
      if (low((r) => ({ se: se(r), value: ratio(r.num, den(r)) }))) {
        out.push({ code: 'low_precision', base: b, message: 'Algunas estimaciones tienen precisión baja.' });
      }
    }
  } else if (low((r) => ({ se: r.ee, value: ratio(r.num, r.den) }))) {
    out.push({
      code: 'low_precision',
      message: template.id === 'weighted_mean' ? 'Algunos promedios tienen precisión baja.' : 'Algunas estimaciones tienen precisión baja.',
    });
  }

  if (sample && rows.some((r) => r.casos > 0 && r.casos < FEW_CASES)) {
    out.push({
      code: 'few_cases',
      message: 'Algunas cifras se apoyan en uno o dos registros de la muestra: tómalas con cautela.',
    });
  }
  return out;
}

function charts(plan: Plan): TemplateResult['charts'] {
  const grouped = plan.group !== null;
  if (plan.template.id === 'proportion') {
    return grouped
      ? { recommended: 'barras_horizontales', compatible: ['barras_horizontales', 'lollipop', 'tabla'] }
      : plan.conditions.length === 1
        ? { recommended: 'numero_destacado', compatible: ['numero_destacado', 'barras_horizontales', 'tabla'] }
        : { recommended: 'barras_horizontales', compatible: ['barras_horizontales', 'tabla'] };
  }
  if (plan.template.id === 'weighted_mean') {
    return grouped
      ? { recommended: 'lollipop', compatible: ['lollipop', 'barras_horizontales', 'tabla'] }
      : { recommended: 'numero_destacado', compatible: ['numero_destacado', 'tabla'] };
  }
  return grouped
    ? { recommended: 'barras_apiladas_100', compatible: ['barras_apiladas_100', 'barras_horizontales', 'tabla'] }
    : { recommended: 'barras_horizontales', compatible: ['barras_horizontales', 'tabla'] };
}

/** Runs a template: plan, queries (through `run`), result. */
export async function runTemplate(
  request: TemplateRequest,
  metadata: VariableMetadata | null,
  /** Runs the queries over the view `data`, keeping only the rows of `filter` (the edition). */
  run: (sql: string[], filter: string | null) => Promise<unknown[][][]>,
): Promise<TemplateResult> {
  const plan = planTemplate(request, metadata);
  const { queries } = planQueries(plan);
  const raw = await run(queries.map((q) => q.sql), plan.metadata.rowFilter);
  return assembleResult(
    plan,
    queries.map((q, i) => q.read(raw[i])),
  );
}
