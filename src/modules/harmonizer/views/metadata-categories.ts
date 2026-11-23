import { codeKey } from '../codebook.js';
import type {
  CatalogCategory,
  ComparisonEdition,
  ComparisonEditionInput,
} from '../comparison.js';
import type { SourceMetadataCategory } from '../source-metadata.js';
import type { VariableRole } from '../variables/variable-role.js';

/** Roles whose values are categories with a label (not keys or record ids). */
const CATEGORY_ROLES: readonly VariableRole[] = [
  'category',
  'ordinal',
  'dichotomous',
  'geographic',
  'socioeconomic_stratum',
];

const byCode = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true });

/**
 * The categories of a variable for the source metadata (`SourceMetadataColumn.categories`), from
 * the editions of the view only:
 *
 * - Only variables of categories have them (`category`, `ordinal`, `dichotomous`, `geographic`,
 *   `socioeconomic_stratum`); others get `[]`.
 * - With a common catalog, its codes in its order (the recoding takes the data to them), then the
 *   kept "not specified" codes that are not in it.
 * - Without one, the categories of the editions' dictionaries (values and "not specified"), from
 *   the newest edition, each code written as it is in that edition's data (`1` for a dictionary
 *   `01`) and after its recoding; then, when no edition has more distinct values than its profile
 *   keeps, the codes of the data that no dictionary names, without a label, in code order.
 * - `kind` is `missing` for the codes in `missingCodes` (as the file has them), else `value`.
 *
 * `inputs` and `editions` are those of `compareVariable` for the editions of the view, in the
 * same order.
 */
export function variableCategories(
  role: VariableRole | null,
  catalog: CatalogCategory[],
  inputs: ComparisonEditionInput[],
  editions: ComparisonEdition[],
  missingCodes: string[],
): SourceMetadataCategory[] {
  if (role === null || !CATEGORY_ROLES.includes(role)) return [];
  const missing = new Set(missingCodes);
  const kind = (code: string): SourceMetadataCategory['kind'] =>
    missing.has(code) ? 'missing' : 'value';
  const out = new Map<string, SourceMetadataCategory>();
  const add = (code: string, label: string | null) => {
    if (code === '' || out.has(code)) return;
    out.set(code, { code, label: label || null, kind: kind(code) });
  };
  const dataLabel = (code: string) =>
    editions.flatMap((e) => e.values).find((v) => v.code === code && v.label)?.label ?? null;

  if (catalog.length > 0) {
    for (const c of catalog) add(c.code, c.label);
    for (const code of missingCodes) add(code, dataLabel(code));
    return [...out.values()];
  }

  const newestFirst = inputs
    .map((input, i) => ({ input, edition: editions[i] }))
    .sort((a, b) => b.input.year - a.input.year);
  for (const { input, edition } of newestFirst) {
    for (const c of input.codebook?.categories ?? []) {
      if ((c.kind !== 'value' && c.kind !== 'missing') || c.code === '') continue;
      const inData = edition?.values.find((v) => codeKey(v.value) === codeKey(c.code));
      add(inData?.code ?? c.code, c.label);
    }
  }
  if (!inputs.some((i) => i.profile.distinctCapped)) {
    const extra = editions
      .flatMap((e) => e.values)
      .filter((v) => v.count > 0 && !out.has(v.code))
      .sort((a, b) => byCode(a.code, b.code));
    for (const v of extra) add(v.code, v.label);
  }
  return [...out.values()];
}
