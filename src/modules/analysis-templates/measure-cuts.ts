import { quoteIdent } from '../analysis/recipe.js';
import type { AgeCut } from '../harmonizer/variables/variable-role.js';
import type { VariableMetadataColumn } from './template-metadata.js';

/** Code of a value that no group covers, so the groups still add up to the whole. */
const OUTSIDE = '_out';
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * A measure cut into the groups declared in the harmonizer ("0 a 14 años"), as one more ordinal
 * variable read from an SQL expression: the file does not change. An empty cell stays empty.
 */
export function cutColumn(
  measure: VariableMetadataColumn,
  cuts: AgeCut[],
  names: string[],
): VariableMetadataColumn {
  let name = `${measure.name}__grupos`;
  while (names.includes(name)) name += '_';
  const value = `CAST(${quoteIdent(measure.name)} AS DOUBLE)`;
  const whens = cuts.map(
    (c, i) => `WHEN ${value} >= ${Number(c.from)}${c.to === null ? '' : ` AND ${value} <= ${Number(c.to)}`} THEN ${lit(String(i))}`,
  );
  return {
    name,
    role: 'ordinal',
    label: `${measure.label} (grupos)`,
    cutFrom: measure.name,
    expression: `(CASE WHEN ${quoteIdent(measure.name)} IS NULL THEN NULL ${whens.join(' ')} ELSE ${lit(OUTSIDE)} END)`,
    categories: [
      ...cuts.map((c, i) => ({ code: String(i), label: c.label })),
      { code: OUTSIDE, label: 'Fuera de los grupos' },
    ],
    // A measure keeps "not specified" and "not asked" as the same empty cell.
    notApplicableLabel:
      measure.notApplicableLabel ?? (measure.missingCount && !measure.universe ? 'No especificado' : 'Sin dato'),
    ...(measure.universe ? { universe: measure.universe } : {}),
  };
}
