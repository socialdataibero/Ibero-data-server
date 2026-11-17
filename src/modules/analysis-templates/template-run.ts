import { BadRequestException, NotFoundException } from '@nestjs/common';
import { quoteIdent } from '../analysis/recipe.js';
import {
  ratioEstimatesSql,
  readRatioEstimates,
  type RatioEstimate,
  type RatioQuery,
} from '../analysis/standard-error.js';
import {
  columnOf,
  columnWithRole,
  type VariableMetadata,
  type VariableMetadataColumn,
} from '../analysis/variable-metadata.js';
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
  missing?: MissingChoice;
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
  inputs: {
    variable: string | null;
    conditions: string[];
    measure: string | null;
    group: string | null;
    missing: MissingChoice | null;
  };
  /** Which result columns are what, so a chart can be built without reading the template. */
  dimensions: {
    group: { column: 'nombre' | 'grupo'; codeColumn: 'cve' | 'grupo_codigo'; label: string; role: string } | null;
    series: { column: 'criterio' | 'corte'; codeColumn: 'criterio' | 'corte_codigo'; label: string } | null;
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
const code = (column: string) => `CAST(${quoteIdent(column)} AS VARCHAR)`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
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
  return include || codes.length === 0 ? '' : ` AND ${code(column.name)} NOT IN (${codes.map(lit).join(', ')})`;
}

function inUniverse(column: VariableMetadataColumn): string {
  return `${quoteIdent(column.name)} IS NOT NULL`;
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
  include: boolean;
  missing: MissingChoice | null;
  design: Pick<RatioQuery, 'weight' | 'stratum' | 'psu'>;
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
    bad('template_no_metadata', 'This resource has no variable metadata yet, so no template can use it.');
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
  if (group && main.some((c) => c.name === group.name)) {
    bad(
      'template_variable_in_two_roles',
      `"${group.label}" is already being measured and cannot also split the result.`,
      { variable: group.name },
    );
  }

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
    include: missing === 'include',
    missing,
    design: {
      weight: sample ? quoteIdent(weight!.name) : null,
      stratum: withDesign ? quoteIdent(stratum!.name) : null,
      psu: withDesign ? quoteIdent(psu!.name) : null,
    },
  };
}

/** The ratio queries of a plan, each with the domain sets it needs (by group, and the total). */
interface RatioSet {
  id: string;
  byGroup: RatioQuery | null;
  total: RatioQuery;
}

function ratioSets(plan: Plan): RatioSet[] {
  const groupKey = plan.group ? [quoteIdent(plan.group.name)] : [];
  const both = (id: string, q: Omit<RatioQuery, 'keys' | 'weight' | 'stratum' | 'psu'>, extraKeys: string[] = []) => ({
    id,
    byGroup: plan.group ? { ...plan.design, ...q, keys: [...groupKey, ...extraKeys] } : null,
    total: { ...plan.design, ...q, keys: extraKeys },
  });

  if (plan.template.id === 'proportion') {
    return plan.conditions.flatMap((c) => {
      const y = `${code(c.name)} = ${lit(c.positiveValue!)}`;
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
  const y = `${den} AND ${code(v.name)} = _c._cat`;
  return [
    both(
      'distribution',
      {
        source: `data CROSS JOIN (SELECT DISTINCT ${code(v.name)} AS _cat FROM data WHERE ${den}) AS _c`,
        y,
        x: den,
        cases: y,
      },
      ['_c._cat'],
    ),
  ];
}

/** How many records of `column` have a "not specified" code. */
function missingCountSql(column: VariableMetadataColumn): string {
  const codes = column.missingCodes ?? [];
  return codes.length === 0
    ? 'SELECT 0'
    : `SELECT (count(*) FILTER (WHERE ${code(column.name)} IN (${codes.map(lit).join(', ')})))::INTEGER FROM data`;
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
  return { sets, queries };
}

const cv = (se: number | null, value: number) => (se === null || value === 0 ? null : se / value);

/** Turns the answers of `planQueries(plan)` (in the same order) into the result. */
export function assembleResult(plan: Plan, answers: unknown[]): TemplateResult {
  const { metadata, group, template } = plan;
  const { sets } = planQueries(plan);
  const estimates = new Map<string, { byGroup: RatioEstimate[]; total: RatioEstimate[] }>();
  let i = 0;
  for (const set of sets) {
    const byGroup = set.byGroup ? (answers[i++] as RatioEstimate[]) : [];
    const total = answers[i++] as RatioEstimate[];
    estimates.set(set.id, { byGroup, total });
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
      const build = (o: RatioEstimate, t: RatioEstimate | undefined, groupCode: string | null): ResultRow => ({
        ...base,
        indicador: indicator,
        criterio,
        ...place(groupCode),
        ...groupColumns(groupCode),
        corte_codigo: null,
        corte: null,
        num: o.y,
        den: o.x,
        den_total: t?.x ?? null,
        ee: o.se,
        ee_total: t?.se ?? null,
        casos: o.cases,
        es_total: groupCode === null,
      });
      const totalsByKey = new Map(total.byGroup.map((t) => [t.keys[0], t]));
      const part = [
        ...own.byGroup.map((o) => build(o, totalsByKey.get(o.keys[0]), o.keys[0])),
        build(own.total[0], total.total[0], null),
      ];
      rows.push(...part.sort((a, b) => groupOrder(a) - groupOrder(b)));
    }
  } else if (template.id === 'weighted_mean') {
    const m = plan.measure!;
    indicator = `${m.label} promedio${m.unit ? ` (${m.unit})` : ''}`;
    const { byGroup, total } = estimates.get('mean')!;
    meanExcluded = total[0].rows - total[0].cases;
    const build = (e: RatioEstimate, groupCode: string | null): ResultRow => ({
      ...base,
      indicador: indicator,
      criterio: null,
      ...place(groupCode),
      ...groupColumns(groupCode),
      corte_codigo: null,
      corte: null,
      num: e.y,
      den: e.x,
      den_total: null,
      ee: e.se,
      ee_total: null,
      casos: e.cases,
      es_total: groupCode === null,
    });
    rows = [...byGroup.map((e) => build(e, e.keys[0])), build(total[0], null)].sort(
      (a, b) => groupOrder(a) - groupOrder(b),
    );
  } else {
    const v = plan.variable!;
    indicator = `${v.label}, ${v.universe ?? 'toda la población'}`;
    const { byGroup, total } = estimates.get('distribution')!;
    const build = (e: RatioEstimate, groupCode: string | null, category: string): ResultRow => ({
      ...base,
      indicador: indicator,
      criterio: null,
      ...place(groupCode),
      ...groupColumns(groupCode),
      corte_codigo: category,
      corte: labelOf(v, category),
      num: e.y,
      den: e.x,
      den_total: null,
      ee: e.se,
      ee_total: null,
      casos: e.cases,
      es_total: groupCode === null,
    });
    rows = [
      ...byGroup.map((e) => build(e, e.keys[0], e.keys[1])),
      ...total.map((e) => build(e, null, e.keys[0])),
    ]
      // A group with nobody in the universe of the variable has no distribution.
      .filter((r) => r.den > 0)
      .sort(
        (a, b) =>
          groupOrder(a) - groupOrder(b) ||
          a.cve.localeCompare(b.cve) ||
          (a.grupo_codigo ?? '').localeCompare(b.grupo_codigo ?? '') ||
          orderOf(v, a.corte_codigo!) - orderOf(v, b.corte_codigo!),
      );
  }

  return {
    template: { id: template.id, version: template.version, contract: template.contract, name: template.name },
    source: { title: metadata.title, design: metadata.design, unitPlural: metadata.unitPlural },
    inputs: {
      variable: plan.variable?.name ?? null,
      conditions: plan.conditions.map((c) => c.name),
      measure: plan.measure?.name ?? null,
      group: group?.name ?? null,
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
  const byGroup = group ? ` por ${lowerFirst(group.label)}` : '';
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
    return {
      title: `${m.label} promedio${byGroup}`,
      question: `¿Cuál es la ${lowerFirst(m.label)} promedio de las ${people}${inEach}?`,
      note: sample
        ? 'Promedio ponderado con factor de expansión, calculado sólo con quienes tienen dato.'
        : 'Promedio calculado sólo con quienes tienen dato.',
      missing:
        excluded > 0
          ? `Se excluyen ${count(excluded)} registros sin dato de ${lowerFirst(m.label)}. El promedio se calcula sólo con quienes tienen dato.`
          : null,
    };
  }
  const v = plan.variable!;
  const universe = v.universe ?? 'toda la población';
  const missing = missingCounts[0] ?? 0;
  return {
    title: upperFirst(`${people} según ${lowerFirst(v.label)}${byGroup}`),
    question: `¿Cómo se reparten las ${people}${inEach} según ${lowerFirst(v.label)}?`,
    note: `${sample ? 'Estimación con factor de expansión.' : `Conteo de ${people}.`} Porcentaje respecto a la ${universe}.`,
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
  run: (sql: string[]) => Promise<unknown[][][]>,
): Promise<TemplateResult> {
  const plan = planTemplate(request, metadata);
  const { queries } = planQueries(plan);
  const raw = await run(queries.map((q) => q.sql));
  return assembleResult(
    plan,
    queries.map((q, i) => q.read(raw[i])),
  );
}
