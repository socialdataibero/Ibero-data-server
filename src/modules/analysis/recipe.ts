import { BadRequestException } from '@nestjs/common';
export const ALLOWED_AGG_FUNCS = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'MEDIAN']);
export const ALLOWED_OPERATORS = new Set(['=', '!=', '<', '<=', '>', '>=']);
export const ALLOWED_SORT_DIRS = new Set(['asc', 'desc']);
export const ALLOWED_JOIN_TYPES = new Set(['inner', 'left']);
export const OP_CATALOG = {
  join: {
    kind: 'join',
    description:
      'Joins this dataset with another resource on a shared column (e.g. households + people by folio). The other resource must belong to the same dataset.',
    params: ['resourceId', 'alias', 'type', 'onLeft', 'onRight'],
  },
  group_by: {
    kind: 'group',
    description: 'Groups rows by one or more columns. Use it with aggregates to summarize per group.',
    params: ['columns'],
  },
  aggregate: {
    kind: 'agg',
    description: 'Computes one value per group: sum, average, count, minimum, maximum or median.',
    params: ['func', 'column', 'as', 'distinct'],
  },
  compute: {
    kind: 'compute',
    description:
      'Creates a new column by multiplying two columns (or a column by a number). Useful to apply a survey expansion factor.',
    params: ['left', 'right', 'as'],
  },
  percentage: {
    kind: 'post',
    description: 'Turns an aggregate into its percentage of the total.',
    params: ['of', 'as'],
  },
  filter: {
    kind: 'row',
    description: 'Keeps only the rows that match a condition (before grouping).',
    params: ['column', 'operator', 'value'],
  },
  sort: {
    kind: 'post',
    description: 'Sorts the result by a column, ascending or descending.',
    params: ['column', 'dir'],
  },
  limit: {
    kind: 'post',
    description: 'Returns only the first N rows (top N).',
    params: ['n'],
  },
} as const;

export type OpName = keyof typeof OP_CATALOG;

export interface Step {
  op: string;
  params?: Record<string, unknown>;
}

export interface JoinSpec {
  resourceId: string;
  alias: string;
  type: string;
  onLeft: string;
  onRight: string;
}

export interface Recipe {
  joins: JoinSpec[];
  computes: { left: string | number; right: string | number; as: string }[];
  filters: { column: string; operator: string; value: string | number }[];
  groupBy: string[];
  aggregates: { func: string; column: string; as: string; distinct?: boolean }[];
  percentage: { of: string; as: string } | null;
  sort: { column: string; dir: string }[];
  limit: number | null;
  roundDecimals: number | null;
}

export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function requireField(value: unknown, code: string, message: string): string {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (s === '') {
    throw new BadRequestException({ code, message });
  }
  return s;
}

function requireOperand(value: unknown, code: string, message: string): string | number {
  if (typeof value === 'number') {
    return value;
  }
  return requireField(value, code, message);
}

export function stepsToInternal(steps: Step[]): Recipe {
  const recipe: Recipe = {
    joins: [],
    computes: [],
    filters: [],
    groupBy: [],
    aggregates: [],
    percentage: null,
    sort: [],
    limit: null,
    roundDecimals: null,
  };

  for (const step of steps) {
    const op = step.op as OpName;
    const p = step.params ?? {};
    if (!(op in OP_CATALOG)) {
      throw new BadRequestException({
        code: 'unknown_operation',
        message: `Unknown operation: ${step.op}`,
      });
    }
    switch (op) {
      case 'join':
        recipe.joins.push({
          resourceId: requireField(p.resourceId, 'join_resource_required', 'Missing resource to join in the "Join" step.'),
          alias: requireField(p.alias, 'join_alias_required', 'Missing alias for the joined resource in the "Join" step.'),
          type: requireField(p.type, 'join_type_required', 'Missing join type (inner/left) in the "Join" step.'),
          onLeft: requireField(p.onLeft, 'join_on_left_required', 'Missing column for this resource in the "Join" step.'),
          onRight: requireField(p.onRight, 'join_on_right_required', 'Missing column for the joined resource in the "Join" step.'),
        });
        break;
      case 'group_by': {
        const columns = Array.isArray(p.columns)
          ? (p.columns as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '')
          : [];
        if (columns.length === 0) {
          throw new BadRequestException({
            code: 'group_by_columns_required',
            message: 'The "Group by" step needs at least one selected column.',
          });
        }
        recipe.groupBy = columns;
        break;
      }
      case 'aggregate':
        recipe.aggregates.push({
          func: requireField(p.func, 'aggregate_function_required', 'Missing function in the "Aggregate" step.'),
          column: requireField(p.column, 'aggregate_column_required', 'Missing column in the "Aggregate" step.'),
          as: requireField(p.as, 'aggregate_result_name_required', 'Missing result name in the "Aggregate" step.'),
          distinct: Boolean(p.distinct),
        });
        break;
      case 'compute':
        recipe.computes.push({
          left: requireOperand(p.left, 'compute_left_required', 'Missing column A in the "Compute" step.'),
          right: requireOperand(p.right, 'compute_right_required', 'Missing column B (or number) in the "Compute" step.'),
          as: requireField(p.as, 'compute_result_name_required', 'Missing result name in the "Compute" step.'),
        });
        break;
      case 'filter':
        recipe.filters.push({
          column: requireField(p.column, 'filter_column_required', 'Missing column in the "Filter rows" step.'),
          operator: requireField(p.operator, 'filter_operator_required', 'Missing operator in the "Filter rows" step.'),
          value: p.value as string | number,
        });
        break;
      case 'percentage':
        recipe.percentage = {
          of: requireField(p.of, 'percentage_reference_required', 'Missing reference aggregate in the "Convert to percentage" step.'),
          as: requireField(p.as, 'percentage_result_name_required', 'Missing result name in the "Convert to percentage" step.'),
        };
        break;
      case 'sort':
        recipe.sort.push({
          column: requireField(p.column, 'sort_column_required', 'Missing column in the "Sort" step.'),
          dir: requireField(p.dir, 'sort_direction_required', 'Missing direction in the "Sort" step.'),
        });
        break;
      case 'limit': {
        if (p.n === undefined || p.n === null || String(p.n).trim() === '') {
          throw new BadRequestException({
            code: 'limit_rows_required',
            message: 'Missing row count in the "Limit rows" step.',
          });
        }
        const n = Number(p.n);
        if (!Number.isFinite(n) || n <= 0) {
          throw new BadRequestException({
            code: 'limit_rows_invalid',
            message: 'The row count in "Limit rows" must be greater than 0.',
          });
        }
        recipe.limit = n;
        break;
      }
    }
  }
  return recipe;
}

function computeOperand(operand: string | number): string {
  if (typeof operand === 'number') {
    return String(operand);
  }
  const s = String(operand).trim();
  if (s !== '' && !Number.isNaN(Number(s))) {
    return s;
  }
  return quoteIdent(s);
}

// Aggregate and percentage results only exist after grouping, so row-by-row steps cannot use them.
function assertRowColumns(recipe: Recipe): void {
  const results = new Set([...recipe.aggregates.map((a) => a.as), ...(recipe.percentage ? [recipe.percentage.as] : [])]);
  const uses: [string, unknown][] = [
    ...recipe.groupBy.map((c): [string, unknown] => ['group_by', c]),
    ...recipe.filters.map((f): [string, unknown] => ['filter', f.column]),
    ...recipe.aggregates.map((a): [string, unknown] => ['aggregate', a.column]),
    ...recipe.computes.flatMap((c): [string, unknown][] => [['compute', c.left], ['compute', c.right]]),
  ];
  for (const [op, column] of uses) {
    if (typeof column === 'string' && results.has(column)) {
      throw new BadRequestException({
        code: 'aggregate_result_not_allowed',
        message: `"${column}" is an aggregate result and cannot be used in a "${op}" step; use a file column or a computed column.`,
        params: { column, op },
      });
    }
  }

  const star = recipe.aggregates.find((a) => a.column === '*' && a.func !== 'COUNT');
  if (star) {
    throw new BadRequestException({
      code: 'star_requires_count',
      message: `"*" (all rows) only works with COUNT, not ${star.func}.`,
      params: { func: star.func },
    });
  }

  // Grouped rows only have the grouped columns and the results, so sort can only use those.
  if (recipe.groupBy.length > 0 || recipe.aggregates.length > 0) {
    const sortable = new Set([...recipe.groupBy, ...results]);
    const bad = recipe.sort.find((s) => !sortable.has(s.column));
    if (bad) {
      throw new BadRequestException({
        code: 'sort_column_not_grouped',
        message: `Cannot sort by "${bad.column}": once the analysis groups or aggregates, sort only by a grouped column or an aggregate result.`,
        params: { column: bad.column },
      });
    }
  }
}

export function buildRecipeSql(recipe: Recipe, previewLimit: number | null): { sql: string; params: (string | number)[] } {
  assertRowColumns(recipe);
  let fromClause = 'data';
  for (const j of recipe.joins) {
    if (!ALLOWED_JOIN_TYPES.has(j.type)) {
      throw new BadRequestException({
        code: 'join_type_not_allowed',
        message: `Join type not allowed: ${j.type}`,
      });
    }
    const alias = quoteIdent(j.alias);
    fromClause += ` ${j.type.toUpperCase()} JOIN ${alias} ON data.${quoteIdent(j.onLeft)} = ${alias}.${quoteIdent(j.onRight)}`;
  }

  if (recipe.computes.length > 0) {
    const parts = recipe.computes.map((c) => {
      const left = computeOperand(c.left);
      const right = computeOperand(c.right);
      return `(${left} * ${right}) AS ${quoteIdent(c.as)}`;
    });
    fromClause = `(SELECT *, ${parts.join(', ')} FROM ${fromClause}) AS data`;
  }

  const params: (string | number)[] = [];
  const where: string[] = [];
  for (const f of recipe.filters) {
    if (!ALLOWED_OPERATORS.has(f.operator)) {
      throw new BadRequestException({
        code: 'operator_not_allowed',
        message: `Operator not allowed: ${f.operator}`,
      });
    }
    params.push(f.value);
    where.push(`${quoteIdent(f.column)} ${f.operator} $${params.length}`);
  }

  const selectParts = recipe.groupBy.map((c) => quoteIdent(c));
  const aggAliases: string[] = [];
  for (const a of recipe.aggregates) {
    if (!ALLOWED_AGG_FUNCS.has(a.func)) {
      throw new BadRequestException({
        code: 'aggregate_function_not_allowed',
        message: `Function not allowed: ${a.func}`,
      });
    }
    let inner = a.column === '*' ? '*' : quoteIdent(a.column);
    if (a.distinct) {
      if (a.column === '*') {
        throw new BadRequestException({
          code: 'count_distinct_requires_column',
          message: 'count_distinct requires a specific column.',
        });
      }
      inner = `DISTINCT ${quoteIdent(a.column)}`;
    }
    selectParts.push(`${a.func}(${inner}) AS ${quoteIdent(a.as)}`);
    aggAliases.push(a.as);
  }

  if (recipe.percentage) {
    const { of: ofAlias, as } = recipe.percentage;
    const aggFor = recipe.aggregates.find((a) => a.as === ofAlias);
    if (!aggFor) {
      throw new BadRequestException({
        code: 'percentage_reference_not_found',
        message: `percentage.of must reference an aggregate: ${ofAlias}`,
      });
    }
    let inner = aggFor.column === '*' ? '*' : quoteIdent(aggFor.column);
    if (aggFor.distinct) inner = `DISTINCT ${inner}`;
    const expr = `${aggFor.func}(${inner})`;
    selectParts.push(`100.0 * ${expr} / SUM(${expr}) OVER () AS ${quoteIdent(as)}`);
  }

  const selectList = selectParts.length > 0 ? selectParts.join(', ') : '*';
  let sql = `SELECT ${selectList} FROM ${fromClause}`;
  if (where.length > 0) {
    sql += ` WHERE ${where.join(' AND ')}`;
  }
  if (recipe.groupBy.length > 0) {
    sql += ` GROUP BY ${recipe.groupBy.map((c) => quoteIdent(c)).join(', ')}`;
  }
  if (recipe.sort.length > 0) {
    const orderParts = recipe.sort.map((s) => {
      if (!ALLOWED_SORT_DIRS.has(s.dir)) {
        throw new BadRequestException({
          code: 'sort_direction_not_allowed',
          message: `Sort direction not allowed: ${s.dir}`,
        });
      }
      return `${quoteIdent(s.column)} ${s.dir.toUpperCase()}`;
    });
    sql += ` ORDER BY ${orderParts.join(', ')}`;
  }

  const effectiveLimit =
    previewLimit !== null && (recipe.limit === null || recipe.limit > previewLimit)
      ? previewLimit
      : recipe.limit;
  if (effectiveLimit !== null) {
    sql += ` LIMIT ${Math.trunc(effectiveLimit)}`;
  }

  return { sql, params };
}

export function toVizCanvasRecipe(recipe: Recipe): Record<string, unknown> {
  return {
    joins: recipe.joins,
    filters: recipe.filters,
    computes: recipe.computes,
    group_by: recipe.groupBy,
    aggregates: recipe.aggregates,
    percentage: recipe.percentage,
    sort: recipe.sort,
    limit: recipe.limit,
  };
}

export function roundRows(rows: Record<string, unknown>[], decimals: number | null): Record<string, unknown>[] {
  if (decimals === null) {
    return rows;
  }
  const factor = 10 ** decimals;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === 'number' ? Math.round(value * factor) / factor : value;
    }
    return out;
  });
}
