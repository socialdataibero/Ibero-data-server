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
 *   5. Extreme proportions have zero linearized variance; means of 0 or 1 can still vary.
 *   6. A domain with X = 0 (nobody in the universe) has no ratio and no error (`NULL`).
 *   7. Only when the source declares which strata were enumerated completely (`certainty`, e.g.
 *      the municipalities interviewed in full with the long questionnaire): such a stratum adds 0
 *      to the variance, whatever its number of PSUs, because nothing in it was sampled. It is one
 *      where a record has one of the declared codes, or where every record has a weight of 1.
 *      Without a declaration no stratum is of certainty (the 2000 cases of the proposal).
 *   8. With that declaration, a domain whose whole denominator comes from certainty strata has no
 *      sampling error to report: `NULL`, as in a census.
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
  /**
   * With a stratum and a PSU: whether a row says its stratum was enumerated completely (boolean
   * SQL, rules 7 and 8), or `null` when the source declares no such column.
   */
  certainty?: string | null;
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
  /** Missing identifiers invalidate the design, including PSUs outside a domain. */
  missingDesign?: boolean;
}

/** Number of key columns `ratioEstimatesSql` returns for `query`. */
function keyExprs(query: RatioQuery): string[] {
  return query.keys.length > 0 ? query.keys : ["'*'"];
}

/**
 * The SELECT for `query`. Its columns are `_k0 … _kN` (text, `''` when the value is missing),
 * `_y`, `_x` (DOUBLE), `_cases`, `_rows` (INTEGER), `_se` (DOUBLE or `NULL`), and, with a design,
 * `_missing_design` (BOOLEAN), ordered by the keys.
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
  const finalSe = (variance: string, sampledX?: string) =>
    `CASE WHEN t._X = 0 OR d._missing_design OR ${variance} IS NULL THEN NULL${sampledX ? ` WHEN ${sampledX} = 0 THEN NULL` : ''} ELSE sqrt(greatest(${variance}, 0)) END`;

  if (!design) {
    return `WITH b AS (SELECT ${base.join(', ')} FROM ${query.source}),
  t AS (${totals})
SELECT ${kList}, _Y AS _y, _X AS _x, _cases, _rows, CAST(NULL AS DOUBLE) AS _se
FROM t ORDER BY ${kList}`;
  }

  // Rule 7: with a declaration, a stratum is of certainty when a record says so or when every
  // weight is 1.
  const certain = query.certainty ? `bool_or(_cert)${query.weight ? ' OR bool_and(_w = 1)' : ''}` : 'false';
  // Rule 8: the part of the denominator that comes from sampled strata.
  const designTotals = `SELECT ${k.map((c) => `b.${c}`).join(', ')}, SUM(b._w * COALESCE(b._yv, 0)) AS _Y,
      SUM(b._w * COALESCE(b._xv, 0)) AS _X,
      SUM(CASE WHEN COALESCE(nh._certain, false) THEN 0 ELSE b._w * COALESCE(b._xv, 0) END) AS _Xs,
      (count(*) FILTER (WHERE b._cv))::INTEGER AS _cases, count(*)::INTEGER AS _rows
    FROM b LEFT JOIN nh ON b._h IS NOT DISTINCT FROM nh._h GROUP BY ${k.map((c) => `b.${c}`).join(', ')}`;

  return `WITH b AS (SELECT ${base.join(', ')}${query.certainty ? `, COALESCE((${query.certainty}), false) AS _cert` : ''} FROM ${query.source}),
  d AS (SELECT EXISTS(SELECT 1 FROM b WHERE _h IS NULL OR _u IS NULL) AS _missing_design),
  nh AS (SELECT _h, count(DISTINCT _u)::DOUBLE AS _nh, (${certain}) AS _certain FROM b GROUP BY _h),
  t AS (${designTotals}),
  z AS (
    SELECT ${k.map((c) => `b.${c}`).join(', ')}, b._h, b._u,
      SUM(CASE WHEN t._X > 0
        THEN b._w * (COALESCE(b._yv, 0) - t._Y / t._X * COALESCE(b._xv, 0)) / t._X
        ELSE 0 END) AS _z
    FROM b JOIN t ON ${k.map((c) => `b.${c} = t.${c}`).join(' AND ')}
    GROUP BY ${k.map((c) => `b.${c}`).join(', ')}, b._h, b._u
  ),
  s AS (
    SELECT ${k.map((c) => `z.${c}`).join(', ')}, z._h, nh._nh, nh._certain, SUM(z._z) AS _s1, SUM(z._z * z._z) AS _s2
    FROM z JOIN nh ON z._h = nh._h
    GROUP BY ${k.map((c) => `z.${c}`).join(', ')}, z._h, nh._nh, nh._certain
  ),
  v AS (
    SELECT ${kList},
      SUM(CASE WHEN _certain THEN 0 WHEN _nh > 1 THEN _nh / (_nh - 1) * (_s2 - _s1 * _s1 / _nh) ELSE _s2 END) AS _var
    FROM s GROUP BY ${kList}
  )
SELECT ${k.map((c) => `t.${c}`).join(', ')}, t._Y AS _y, t._X AS _x, t._cases, t._rows, ${finalSe('v._var', query.certainty ? 't._Xs' : undefined)} AS _se, d._missing_design
FROM t CROSS JOIN d LEFT JOIN v ON ${k.map((c) => `t.${c} = v.${c}`).join(' AND ')}
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
    ...(row[n + 5] === true ? { missingDesign: true } : {}),
  }));
}
