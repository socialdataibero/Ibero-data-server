export interface CanonicalCandidate {
  id: string;
  name: string;
}

const COMBINING_MARKS = /\p{M}/gu;

export function normalize(name: string): string {
  return name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function asciiFold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^\x20-\x7e]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchByName(
  column: string,
  canonicals: CanonicalCandidate[],
): string | null {
  const col = normalize(column);
  if (col === '') return null;

  let best: { score: number; length: number; id: string } | null = null;
  for (const cv of canonicals) {
    const canon = normalize(cv.name);
    if (canon === '') continue;

    let score: number;
    if (col === canon) {
      score = 2;
    } else if (
      new RegExp(`(?:^|_)${escapeRegExp(canon)}(?:\\d+)?(?:_|$)`).test(col)
    ) {
      score = 1;
    } else {
      continue;
    }

    const candidate = { score, length: canon.length, id: cv.id };
    if (best === null || isBetter(candidate, best)) best = candidate;
  }
  return best ? best.id : null;
}

function isBetter(
  a: { score: number; length: number; id: string },
  b: { score: number; length: number; id: string },
): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.length !== b.length) return a.length > b.length;
  return a.id > b.id;
}

/**
 * Variables pedidas en `?variables=`. Solo se aceptan repetidas (`?variables=a&variables=b`):
 * no se parte por comas porque un nombre canónico puede contener comas (H-13).
 */
export function parseVariables(raw: string | string[] | undefined): string[] {
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const v = String(item).trim();
    if (v !== '' && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
