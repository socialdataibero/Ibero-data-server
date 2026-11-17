/**
 * Estimates of a ratio Y/X per domain, with their standard error, as one DuckDB SELECT built by
 * the server (never user SQL). A proportion is a ratio (people who meet a condition over people
 * in its universe) and so is a weighted mean (sum of value × weight over sum of weight), so the
 * analysis templates use this for both.
 *
 * Method: Taylor linearization with the ultimate cluster estimator (with replacement), the usual
 * method for INEGI samples. It is the reference query of the template proposal (annex C,
 * `funcion_error_estandar/error_estandar_taylor.sql`), written so it does not cross every domain
 * with every PSU: a PSU without rows of a domain adds a zero to the sums of its stratum, so it only
 * needs to be counted in `n_h`, which comes from the whole file. The two forms give the same
 * number. Rules that must not be "optimized" away:
 *
 *   1. Every row of the file is used. A row outside the numerator or the denominator adds zero,
 *      but its PSU still counts in `n_h`. Filtering rows first changes `n_h` and the error.
 *   2. A PSU is its stratum plus its own code: the same PSU code in two strata is two PSUs.
 *   3. Stratum variance: n_h / (n_h - 1) × Σ (z - mean of z)², with z the linearized value of a PSU.
 *   4. A stratum with a single PSU has no variance of its own. Centering rule: the PSU is compared
 *      with the overall mean of the z, which is 0 for a ratio, so it adds z² (`adjust` in R's
 *      `survey`, `singleunit(centered)` in Stata).
 *   5. A ratio of 0 or 1 (Y = 0 or Y = X) has a standard error of exactly 0. That is not perfect
 *      precision: its coefficient of variation is undefined and the figure must be flagged.
 *   6. A domain with X = 0 (nobody in the universe) has no ratio and no error (`NULL`).
 *
 * Without a stratum and a PSU (a census, or a sample that does not declare them) the error is
 * `NULL`, never 0: there is no sampling error to report.
 */

export interface RatioQuery {
  /** FROM clause: `data`, or `data CROSS JOIN (…) AS _c` to give every row one copy per category. */
  source: string;
  /** SQL expressions over `source` that define a domain. None: one domain, the whole file. */
  keys: string[];
  /** Expansion factor column (SQL), or `null` when every row counts once. */
  weight: string | null;
  /** Design stratum and PSU columns (SQL); both or neither. */
  stratum: string | null;
  psu: string | null;
  /** Numerator contribution of a row, before the weight (number or boolean SQL). */
  y: string;
  /** Denominator contribution of a row, before the weight (number or boolean SQL). */
  x: string;
  /** Rows counted in `cases`, the real records behind the estimate (boolean SQL). */
  cases: string;
}

/** One output row of `ratioEstimatesSql`, in column order. */
export interface RatioEstimate {
  /** Domain key values as text; `''` is a missing value. With no keys, one key `'*'`. */
  keys: string[];
  /** Σ weight × y. */
  y: number;
  /** Σ weight × x. */
  x: number;
  cases: number;
  /** Rows of the domain, whatever their y and x. */
  rows: number;
  se: number | null;
}

/** Number of key columns `ratioEstimatesSql` returns for `query`. */
function keyExprs(query: RatioQuery): string[] {
  return query.keys.length > 0 ? query.keys : ["'*'"];
}

/**
 * The SELECT for `query`. Its columns are `_k0 … _kN` (text, `''` when the value is missing),
 * `_y`, `_x` (DOUBLE), `_cases`, `_rows` (INTEGER) and `_se` (DOUBLE or `NULL`), ordered by the keys.
 * Read its rows with `readRatioEstimates`.
 */
export function ratioEstimatesSql(query: RatioQuery): string {
  const keys = keyExprs(query);
  const k = keys.map((_, i) => `_k${i}`);
  const kList = k.join(', ');
  const weight = query.weight ? `CAST(${query.weight} AS DOUBLE)` : '1.0';
  const design = query.stratum !== null && query.psu !== null;
  if ((query.stratum === null) !== (query.psu === null)) {
    throw new Error('ratioEstimatesSql: give both the stratum and the PSU, or neither.');
  }

  const base = [
    ...keys.map((e, i) => `COALESCE(CAST(${e} AS VARCHAR), '') AS _k${i}`),
    `${weight} AS _w`,
    `CAST((${query.y}) AS DOUBLE) AS _yv`,
    `CAST((${query.x}) AS DOUBLE) AS _xv`,
    `COALESCE((${query.cases}), false) AS _cv`,
    ...(design
      ? [
          `CAST(${query.stratum} AS VARCHAR) AS _h`,
          `CAST(${query.stratum} AS VARCHAR) || '|' || CAST(${query.psu} AS VARCHAR) AS _u`,
        ]
      : []),
  ];
  const totals = `SELECT ${kList}, SUM(_w * COALESCE(_yv, 0)) AS _Y, SUM(_w * COALESCE(_xv, 0)) AS _X,
      (count(*) FILTER (WHERE _cv))::INTEGER AS _cases, count(*)::INTEGER AS _rows
    FROM b GROUP BY ${kList}`;
  const finalSe = (variance: string) =>
    `CASE WHEN t._X = 0 THEN NULL WHEN t._Y = 0 OR t._Y = t._X THEN 0.0 ELSE sqrt(greatest(${variance}, 0)) END`;

  if (!design) {
    return `WITH b AS (SELECT ${base.join(', ')} FROM ${query.source}),
  t AS (${totals})
SELECT ${kList}, _Y AS _y, _X AS _x, _cases, _rows, CAST(NULL AS DOUBLE) AS _se
FROM t ORDER BY ${kList}`;
  }

  return `WITH b AS (SELECT ${base.join(', ')} FROM ${query.source}),
  t AS (${totals}),
  nh AS (SELECT _h, count(DISTINCT _u)::DOUBLE AS _nh FROM b GROUP BY _h),
  z AS (
    SELECT ${k.map((c) => `b.${c}`).join(', ')}, b._h, b._u,
      SUM(CASE WHEN t._X > 0
        THEN b._w * (COALESCE(b._yv, 0) - t._Y / t._X * COALESCE(b._xv, 0)) / t._X
        ELSE 0 END) AS _z
    FROM b JOIN t ON ${k.map((c) => `b.${c} = t.${c}`).join(' AND ')}
    GROUP BY ${k.map((c) => `b.${c}`).join(', ')}, b._h, b._u
  ),
  s AS (
    SELECT ${k.map((c) => `z.${c}`).join(', ')}, z._h, nh._nh, SUM(z._z) AS _s1, SUM(z._z * z._z) AS _s2
    FROM z JOIN nh ON z._h = nh._h
    GROUP BY ${k.map((c) => `z.${c}`).join(', ')}, z._h, nh._nh
  ),
  v AS (
    SELECT ${kList},
      SUM(CASE WHEN _nh > 1 THEN _nh / (_nh - 1) * (_s2 - _s1 * _s1 / _nh) ELSE _s2 END) AS _var
    FROM s GROUP BY ${kList}
  )
SELECT ${k.map((c) => `t.${c}`).join(', ')}, t._Y AS _y, t._X AS _x, t._cases, t._rows, ${finalSe('v._var')} AS _se
FROM t LEFT JOIN v ON ${k.map((c) => `t.${c} = v.${c}`).join(' AND ')}
ORDER BY ${k.map((c) => `t.${c}`).join(', ')}`;
}

/** The rows of `ratioEstimatesSql(query)` as returned by DuckDB's `getRowsJson`. */
export function readRatioEstimates(query: RatioQuery, rows: unknown[][]): RatioEstimate[] {
  const n = keyExprs(query).length;
  return rows.map((row) => ({
    keys: row.slice(0, n).map((v) => String(v ?? '')),
    y: Number(row[n]),
    x: Number(row[n + 1]),
    cases: Number(row[n + 2]),
    rows: Number(row[n + 3]),
    se: row[n + 4] === null || row[n + 4] === undefined ? null : Number(row[n + 4]),
  }));
}
