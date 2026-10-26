/**
 * Comparación de los códigos de una variable canónica entre las ediciones que la mapean, para
 * avisar cuando juntar años mezcla códigos distintos (por ejemplo, `CLAVIVP` = 2 es
 * «Departamento en edificio» en 2010 y «Casa que comparte terreno» en 2020).
 *
 * Trabaja sobre el perfil de valores de cada columna (valores distintos con su frecuencia), las
 * etiquetas del diccionario de cada edición y la recodificación guardada.
 */
import { createHash } from 'node:crypto';
import { codeKey, normalizeLabel, type CodebookCategory } from './codebook.js';
import type { ValueType } from './harmonized-view.js';

export interface ProfileValue {
  value: string;
  count: number;
}

export interface ColumnProfile {
  values: ProfileValue[];
  distinctCapped: boolean;
  empty: number;
}

export interface CatalogCategory {
  code: string;
  label: string;
}

export interface ComparisonEditionInput {
  datasetId: string;
  datasetName: string;
  year: number;
  column: string;
  missingCodes: string[];
  valueMap: Record<string, string>;
  profile: ColumnProfile;
  /** Categorías de la variable en el diccionario de la edición, o `null` si no tiene. */
  codebook: { label: string | null; categories: CodebookCategory[] } | null;
}

export interface ComparisonValue {
  /** Valor en el archivo. */
  value: string;
  /** Código en la vista armonizada: el recodificado o, si no hay, el mismo valor. */
  code: string;
  label: string | null;
  /** Etiqueta del valor en el diccionario de su edición, antes de recodificar. */
  sourceLabel: string | null;
  count: number;
  missing: boolean;
  recoded: boolean;
}

export interface ComparisonEdition {
  datasetId: string;
  datasetName: string;
  year: number;
  column: string;
  codebookLabel: string | null;
  values: ComparisonValue[];
  distinctCapped: boolean;
  empty: number;
}

export type IssueKind = 'label_conflict' | 'code_conflict' | 'format' | 'only_in_some' | 'not_in_catalog';

export interface IssueEdition {
  datasetName: string;
  year: number;
  /** Código o códigos (ya recodificados) de la edición. */
  codes: string[];
  label: string | null;
}

export interface ComparisonIssue {
  kind: IssueKind;
  /** Código del problema (`2`); en `code_conflict`, la etiqueta común. */
  subject: string;
  editions: IssueEdition[];
}

export type ComparisonStatus = 'single' | 'ok' | 'warning' | 'reviewed';

export interface VariableComparison {
  categorical: boolean;
  editions: ComparisonEdition[];
  issues: ComparisonIssue[];
  /** Hash de las diferencias: una revisión vale mientras no cambie. */
  signature: string;
}

/** Menos valores distintos que esto, sin diccionario, y la variable se trata como categórica. */
export const CATEGORICAL_MAX_DISTINCT = 30;
/** Como mucho se listan tantos problemas de cada tipo, para no inundar la pantalla. */
const MAX_ISSUES_PER_KIND = 50;

function hasValueCategories(categories: CodebookCategory[]): boolean {
  return categories.filter((c) => c.kind === 'value').length >= 2;
}

function codebookLabelFor(categories: CodebookCategory[], value: string): string | null {
  const key = codeKey(value);
  return (
    categories.find((c) => (c.kind === 'value' || c.kind === 'missing') && c.code !== '' && codeKey(c.code) === key)
      ?.label ?? null
  );
}

function editionValues(input: ComparisonEditionInput, catalog: CatalogCategory[]): ComparisonValue[] {
  const missing = new Set(input.missingCodes.map((c) => c.trim()));
  const catalogLabel = new Map(catalog.map((c) => [c.code, c.label]));
  const categories = input.codebook?.categories ?? [];
  return input.profile.values.map(({ value, count }) => {
    const isMissing = missing.has(value);
    const recoded = !isMissing && Object.hasOwn(input.valueMap, value);
    const code = recoded ? input.valueMap[value] : value;
    const sourceLabel = codebookLabelFor(categories, value);
    const label =
      (recoded ? catalogLabel.get(code) : undefined) ?? sourceLabel ?? catalogLabel.get(code) ?? null;
    return { value, code, label, sourceLabel, count, missing: isMissing, recoded };
  });
}

/** Una edición vista por clave de código (`codeKey`), solo con valores que no faltan. */
interface KeyedCode {
  spellings: Set<string>;
  labels: Set<string>;
  /** La primera etiqueta tal como se escribe, para mostrarla. */
  label: string | null;
}

function keyed(values: ComparisonValue[]): Map<string, KeyedCode> {
  const out = new Map<string, KeyedCode>();
  for (const v of values) {
    if (v.missing || v.count === 0) continue;
    const key = codeKey(v.code);
    const entry = out.get(key) ?? { spellings: new Set(), labels: new Set(), label: null };
    entry.spellings.add(v.code);
    if (v.label) {
      entry.labels.add(normalizeLabel(v.label));
      entry.label ??= v.label;
    }
    out.set(key, entry);
  }
  return out;
}

function isCategorical(inputs: ComparisonEditionInput[], catalog: CatalogCategory[]): boolean {
  if (catalog.length > 0) return true;
  if (inputs.some((e) => e.codebook && hasValueCategories(e.codebook.categories))) return true;
  return inputs.every((e) => {
    const missing = new Set(e.missingCodes);
    const distinct = e.profile.values.filter((v) => !missing.has(v.value)).length;
    return !e.profile.distinctCapped && distinct <= CATEGORICAL_MAX_DISTINCT;
  });
}

function issueEdition(edition: ComparisonEdition, codes: Iterable<string>, label: string | null): IssueEdition {
  return { datasetName: edition.datasetName, year: edition.year, codes: [...codes].sort(), label };
}

/**
 * Compara una variable entre ediciones. Las diferencias que se buscan:
 *
 * - `label_conflict`: el mismo código significa cosas distintas (`2` = «Departamento» y `2` =
 *   «Casa que comparte terreno»). Necesita etiquetas en al menos dos ediciones.
 * - `code_conflict`: la misma etiqueta tiene códigos distintos («Mujer» = `2` y `M`).
 * - `format`: el mismo código escrito distinto (`040` y `40`). En variables no categóricas solo se
 *   avisa si la variable se exporta como texto, porque como número la diferencia desaparece.
 * - `only_in_some`: un código que aparece en los datos de unas ediciones y no en otras.
 * - `not_in_catalog`: con catálogo, un valor que no se recodificó a uno de sus códigos.
 *
 * Los códigos de «No especificado» de cada edición no se comparan.
 */
export function compareVariable(
  inputs: ComparisonEditionInput[],
  catalog: CatalogCategory[],
  dataType: ValueType | null,
): VariableComparison {
  const editions: ComparisonEdition[] = inputs.map((input) => ({
    datasetId: input.datasetId,
    datasetName: input.datasetName,
    year: input.year,
    column: input.column,
    codebookLabel: input.codebook?.label ?? null,
    values: editionValues(input, catalog),
    distinctCapped: input.profile.distinctCapped,
    empty: input.profile.empty,
  }));
  const categorical = isCategorical(inputs, catalog);
  const issues: ComparisonIssue[] = [];

  if (editions.length >= 2) {
    const perEdition = editions.map((e) => keyed(e.values));
    const allKeys = [...new Set(perEdition.flatMap((m) => [...m.keys()]))].sort((a, b) =>
      a.localeCompare(b, 'es', { numeric: true }),
    );
    const reported = new Set<string>();
    const push = (issue: ComparisonIssue) => {
      if (issues.filter((i) => i.kind === issue.kind).length < MAX_ISSUES_PER_KIND) issues.push(issue);
    };

    if (categorical) {
      for (const key of allKeys) {
        const present = editions
          .map((edition, i) => ({ edition, entry: perEdition[i].get(key) }))
          .filter((p): p is { edition: ComparisonEdition; entry: KeyedCode } => p.entry !== undefined);
        const labelled = present.filter((p) => p.entry.labels.size > 0);
        const labels = new Set(labelled.flatMap((p) => [...p.entry.labels]));
        if (labelled.length >= 2 && labels.size > 1) {
          reported.add(key);
          push({
            kind: 'label_conflict',
            subject: key,
            editions: labelled.map((p) => issueEdition(p.edition, p.entry.spellings, p.entry.label)),
          });
        }
      }

      const byLabel = new Map<string, { edition: ComparisonEdition; key: string; entry: KeyedCode }[]>();
      editions.forEach((edition, i) => {
        for (const [key, entry] of perEdition[i]) {
          for (const label of entry.labels) {
            byLabel.set(label, [...(byLabel.get(label) ?? []), { edition, key, entry }]);
          }
        }
      });
      for (const [, uses] of byLabel) {
        const keys = new Set(uses.map((u) => u.key));
        const inEditions = new Set(uses.map((u) => u.edition.datasetId));
        if (keys.size < 2 || inEditions.size < 2) continue;
        uses.forEach((u) => reported.add(u.key));
        push({
          kind: 'code_conflict',
          subject: uses[0].entry.label ?? '',
          editions: editions
            .map((edition) => {
              const own = uses.filter((u) => u.edition.datasetId === edition.datasetId);
              return own.length === 0
                ? null
                : issueEdition(edition, own.flatMap((u) => [...u.entry.spellings]), own[0].entry.label);
            })
            .filter((e): e is IssueEdition => e !== null),
        });
      }
    }

    const textual = dataType === null || dataType === 'text';
    if (categorical || textual) {
      const spelledDifferently = allKeys.filter((key) => {
        if (reported.has(key)) return false;
        const spellings = new Set(perEdition.flatMap((m) => [...(m.get(key)?.spellings ?? [])]));
        const inEditions = perEdition.filter((m) => m.has(key)).length;
        return spellings.size > 1 && inEditions >= 2;
      });
      if (categorical) {
        for (const key of spelledDifferently) {
          reported.add(key);
          push({
            kind: 'format',
            subject: key,
            editions: editions
              .map((edition, i) => {
                const entry = perEdition[i].get(key);
                return entry ? issueEdition(edition, entry.spellings, entry.label) : null;
              })
              .filter((e): e is IssueEdition => e !== null),
          });
        }
      } else if (spelledDifferently.length > 0) {
        // Una variable numérica guardada como texto (`EDAD` = `040` y `40`): un solo aviso con ejemplos.
        const sample = spelledDifferently.slice(0, 5);
        push({
          kind: 'format',
          subject: sample.join(', '),
          editions: editions.map((edition, i) =>
            issueEdition(
              edition,
              sample.flatMap((key) => [...(perEdition[i].get(key)?.spellings ?? [])]),
              null,
            ),
          ),
        });
      }
    }

    if (categorical) {
      for (const key of allKeys) {
        if (reported.has(key)) continue;
        const present = editions.filter((_, i) => perEdition[i].has(key));
        if (present.length === editions.length) continue;
        push({
          kind: 'only_in_some',
          subject: key,
          editions: present.map((edition) => {
            const entry = perEdition[editions.indexOf(edition)].get(key)!;
            return issueEdition(edition, entry.spellings, entry.label);
          }),
        });
      }
    }
  }

  if (catalog.length > 0) {
    const codes = new Set(catalog.map((c) => c.code));
    const outside = new Map<string, Map<ComparisonEdition, ComparisonValue>>();
    for (const edition of editions) {
      for (const v of edition.values) {
        if (v.missing || codes.has(v.code)) continue;
        const byEdition = outside.get(v.code) ?? new Map();
        byEdition.set(edition, v);
        outside.set(v.code, byEdition);
      }
    }
    for (const [code, byEdition] of outside) {
      if (issues.filter((i) => i.kind === 'not_in_catalog').length >= MAX_ISSUES_PER_KIND) break;
      issues.push({
        kind: 'not_in_catalog',
        subject: code,
        editions: [...byEdition].map(([edition, v]) => issueEdition(edition, [v.value], v.label)),
      });
    }
  }

  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        editions: editions.map((e) => [e.datasetId, e.column]),
        issues: issues.map((i) => [i.kind, i.subject, i.editions.map((e) => [e.datasetName, e.codes, e.label])]),
      }),
    )
    .digest('hex');

  return { categorical, editions, issues, signature };
}

export function comparisonStatus(
  comparison: Pick<VariableComparison, 'editions' | 'issues' | 'signature'>,
  reviewedSignature: string | null,
): ComparisonStatus {
  if (comparison.editions.length < 2 && comparison.issues.length === 0) return 'single';
  if (comparison.issues.length === 0) return 'ok';
  return reviewedSignature === comparison.signature ? 'reviewed' : 'warning';
}

export interface RecodingSuggestion {
  categories: CatalogCategory[];
  /** Por edición: `{ valor del archivo: código del catálogo }`. */
  valueMaps: Record<string, Record<string, string>>;
}

/** Busca en el catálogo una categoría con la misma etiqueta o, si es única, una que empiece igual. */
function matchByLabel(label: string, catalog: CatalogCategory[]): CatalogCategory | null {
  const wanted = normalizeLabel(label);
  if (!wanted) return null;
  const exact = catalog.find((c) => normalizeLabel(c.label) === wanted);
  if (exact) return exact;
  const prefixed = catalog.filter((c) => {
    const other = normalizeLabel(c.label);
    return other !== '' && (other.startsWith(`${wanted} `) || wanted.startsWith(`${other} `));
  });
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Propuesta de recodificación. El catálogo es el guardado o, si no hay, las categorías del
 * diccionario de la edición más reciente que las tenga (o sus valores, si ninguna tiene
 * diccionario). Cada valor de cada edición se propone hacia la categoría con la misma etiqueta,
 * o hacia el mismo código escrito distinto (`1` → `01`) si las etiquetas no se contradicen. Lo
 * que no se reconoce se deja sin proponer para que lo decida el usuario.
 */
export function suggestRecoding(
  inputs: ComparisonEditionInput[],
  catalog: CatalogCategory[],
): RecodingSuggestion {
  let categories = catalog;
  if (categories.length === 0) {
    const newest = [...inputs]
      .sort((a, b) => b.year - a.year)
      .find((e) => e.codebook && hasValueCategories(e.codebook.categories));
    if (newest?.codebook) {
      categories = newest.codebook.categories
        .filter((c) => c.kind === 'value' && c.code !== '')
        .map((c) => ({ code: c.code, label: c.label }));
    } else {
      const latest = [...inputs].sort((a, b) => b.year - a.year)[0];
      const missing = new Set(latest?.missingCodes ?? []);
      categories = (latest?.profile.values ?? [])
        .filter((v) => !missing.has(v.value))
        .map((v) => ({ code: v.value, label: '' }))
        .sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }));
    }
  }
  const codes = new Set(categories.map((c) => c.code));
  const valueMaps: Record<string, Record<string, string>> = {};
  for (const input of inputs) {
    const missing = new Set(input.missingCodes);
    const map: Record<string, string> = {};
    for (const { value } of input.profile.values) {
      if (missing.has(value)) continue;
      const label = codebookLabelFor(input.codebook?.categories ?? [], value);
      let target: string | null = null;
      if (label) target = matchByLabel(label, categories)?.code ?? null;
      if (target === null && !codes.has(value)) {
        const sameKey = categories.filter((c) => codeKey(c.code) === codeKey(value));
        const catalogLabel = sameKey[0]?.label ?? '';
        // Solo si las etiquetas no se contradicen: `2` no se propone a `02` si significan otra cosa.
        if (sameKey.length === 1 && (!label || !catalogLabel || normalizeLabel(label) === normalizeLabel(catalogLabel))) {
          target = sameKey[0].code;
        }
      }
      // También `01` → `01`: deja constancia de que el valor corresponde a esa categoría.
      if (target !== null) map[value] = target;
    }
    valueMaps[input.datasetId] = map;
  }
  return { categories, valueMaps };
}
