import type { ParquetColumnType } from '../analysis/analysis.service.js';
import type { ResultRow, TemplateResult } from './template-run.js';

export interface TemplateTable {
  columns: string[];
  rows: Record<string, unknown>[];
  types: Record<string, ParquetColumnType>;
}

const TEXT_COLUMNS = ['fuente', 'indicador', 'criterio', 'nivel', 'cve', 'nombre', 'grupo_codigo', 'grupo', 'corte_codigo', 'corte'] as const;
const NUMBER_COLUMNS = ['num', 'den', 'den_total', 'ee', 'ee_total'] as const;

function share(num: number, den: number | null, scale: number): number | null {
  if (den === null || den === 0) return null;
  return Math.round((num / den) * scale * 100) / 100;
}

/**
 * The table a published template result is saved as: the same columns as the CSV download (one
 * code and label column per breakdown, `*` and `Todos` for its total) plus the value itself, so the analysis reads
 * on its own without the template (a percentage for proportions, the mean for means; standard
 * errors of proportions in percentage points).
 */
export function templateTable(result: TemplateResult): TemplateTable {
  const has = (c: keyof ResultRow) => result.rows.some((r) => r[c] !== null);
  const text = TEXT_COLUMNS.filter(has);
  const numbers = NUMBER_COLUMNS.filter(has);
  const breakdowns = result.dimensions.breakdowns ?? [];
  const proportion = result.value.kind === 'proportion';
  const valueColumn = proportion ? 'porcentaje' : 'promedio';
  const withTotal = proportion && has('den_total');

  const columns = [
    ...text,
    'edicion',
    ...breakdowns.flatMap((b) => [`desag_${b.column.toLowerCase()}_codigo`, `desag_${b.column.toLowerCase()}`]),
    valueColumn,
    ...(withTotal ? ['porcentaje_total'] : []),
    ...numbers,
    'casos',
    'es_total',
  ];
  const types: Record<string, ParquetColumnType> = { edicion: 'BIGINT', casos: 'BIGINT', [valueColumn]: 'DOUBLE' };
  if (withTotal) types.porcentaje_total = 'DOUBLE';
  for (const c of numbers) types[c] = 'DOUBLE';

  const rows = result.rows.map((r) => {
    const row: Record<string, unknown> = {};
    for (const c of text) row[c] = r[c];
    row.edicion = r.edicion;
    for (const b of breakdowns) {
      const code = r.desagregaciones[b.column];
      // `*` marks the marginal total, so a real category called «Todos» stays distinguishable.
      row[`desag_${b.column.toLowerCase()}_codigo`] = code ?? '*';
      row[`desag_${b.column.toLowerCase()}`] =
        code === null ? 'Todos' : (b.categories.find((c) => c.code === code)?.label ?? code);
    }
    row[valueColumn] = share(r.num, r.den, proportion ? 100 : 1);
    if (withTotal) row.porcentaje_total = share(r.num, r.den_total, 100);
    for (const c of numbers) {
      // Errors in percentage points, like the percentage next to them.
      const scaled = proportion && (c === 'ee' || c === 'ee_total');
      row[c] = scaled && r[c] !== null ? (r[c] as number) * 100 : r[c];
    }
    row.casos = r.casos;
    row.es_total = r.es_total ? 'sí' : 'no';
    return row;
  });
  return { columns, rows, types };
}
