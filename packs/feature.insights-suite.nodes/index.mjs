/**
 * feature.insights-suite.nodes (ADR 0078) — pure compute nodes for the Insights &
 * Drafting Agent Suite. No host surface, no egress: deterministic math, replay-safe.
 *
 *  - variance-compute: Actual-vs-Plan for a business unit's metrics, flags off-plan.
 *  - talent-score: 9-box performance×potential → readiness category.
 *
 * ── 1.1.0 (ADR 0599 §3) — THE FABRICATION GUARDS ────────────────────────────
 *
 * Both nodes used to answer an "I read nothing" call with a confident, defensible
 * verdict under `status:'success'`:
 *
 *   varianceCompute({}) → { verdict: 'on_plan' }                    // "we're fine"
 *   talentScore({subjectId}) → { box:1, 'Underperformer', not_ready } // about a NAMED PERSON
 *
 * Neither was reachable in production (every chain died upstream at `invalid_config`),
 * which is exactly why the wiring repair had to come SECOND: it would have converted
 * two silent no-ops into two confident fabrications, one of them confidential-PII
 * broadcast tenant-wide and re-reachable through the chat agent tool.
 *
 * The rule this file already knew and applied to one node and not the other:
 * **a missing input is a typed failure or an explicit skip, never a substituted
 * default that is indistinguishable from a real answer.** Out-of-range CLAMPING of a
 * value the caller actually supplied stays legitimate and is kept deliberately
 * distinct from absence.
 *
 * ── 1.2.0 (ADR 0599 §Correction 1) — THE GUARDS DID NOT SEE THE REAL ABSENCE ─
 *
 * 1.1.0 closed the class for `undefined` and left it wide open for every absence
 * shape a warehouse actually emits. The reader was `Number()`, and
 * `Number(null) === Number('') === Number('  ') === Number(false) === 0`. So:
 *
 *   variance rows `[{metric:'sales', actual:null, plan:null}]` → verdict 'on_plan'
 *   talent  rows `[{…, performanceRating:'', potentialRating:''}]` → box 1, 'Underperformer'
 *
 * — the exact two fabrications 1.1.0 exists to prevent, under `status:'success'`,
 * reached through a guard that could not fire because a bag of coerced zeros is
 * not an empty bag. `mapBigQueryRows` (`bootstrap/nodes.ts`) writes the REST cell
 * value straight through, so a SQL NULL arrives here as literal `null`: a
 * warehouse of NULLs said "we're fine" and carried a human red-team signature.
 *
 * Two things changed. (1) `measure()` replaces `num()` — absence is rejected
 * BEFORE any numeric coercion. (2) A metric whose PLAN is 0 yields no variance
 * percentage at all, so a whole read of zero-plans is `insufficient_data`, not
 * "checked and clean" (a `SUM(plan)` over no rows returns 0, not NULL — this is a
 * production shape, not a contrived one).
 *
 * And `talent-score` no longer takes the FIRST row it finds (a review pull returns
 * one row per cycle, in collection order, with no recency field) nor clamps a
 * scraped column onto 1-3 (on a 1-5 scale a mid 3 would become the TOP band).
 * §3's clamp rationale covers "a value the caller actually supplied"; it does not
 * transfer to a column whose scale the node cannot know.
 */

const METRICS = ['sales', 'margin', 'labor', 'shrink'];

/**
 * The ONLY numeric reader on the data path — absence-strict, and the reason this
 * pack went 1.1.0 → 1.2.0.
 *
 * `Number()` is the wrong instrument here: it maps `null`, `''`, `'   '` and
 * `false` all to **0**, i.e. it converts every absence shape a warehouse emits
 * into a real measurement of zero. That is the 1.1.0 fabrication class one layer
 * down, and it defeated both aggregate guards from BELOW — they test for an EMPTY
 * bag, and a bag full of coerced zeros is not empty.
 *
 * Numeric STRINGS must still parse: the BigQuery `jobs.query` REST wire returns
 * every cell as a string (`{v:"95"}`), so rejecting strings outright would starve
 * the one source the variance chain actually has.
 *
 * Returns `null` for every non-measurement, which is what the fail-closed guards
 * read.
 */
function measure(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // null / undefined / boolean / object / array — an absence or a non-measurement,
  // never a zero. `false` in particular is a warehouse's "no value here".
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A `{metric: number}` bag from either an explicit map or a tabular row set.
 *  Rows are the shape a `core.bigquery.query` / warehouse read actually returns —
 *  `[{metric:'sales', actual:95, plan:100}, …]` — so a chain can wire the source
 *  node straight into this node instead of needing a transform node that does not
 *  exist. Anything that is not a recognized shape yields an EMPTY bag, which the
 *  caller turns into a typed failure rather than an "on plan" verdict. */
function metricBag(explicit, rows, column) {
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return explicit;
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const metric = String(row.metric ?? row.name ?? '').trim();
    if (!METRICS.includes(metric)) continue;
    // `measure`, not `Number` — a NULL/blank/boolean cell must DROP OUT of the bag
    // so the aggregate guard below can see it as absent (ADR 0599 §Correction 1).
    const v = measure(row[column]);
    if (v !== null) out[metric] = v;
  }
  return out;
}

/** Actual-vs-Plan variance for sales/margin/labor/shrink. delta = actual − plan;
 *  pct = delta/plan (null when plan is 0). A metric is FLAGGED when |pct| exceeds
 *  `thresholdPct` (default 0.05).
 *
 *  Accepts either explicit `{actuals, plan}` maps or a tabular `rows` set carrying
 *  `metric` / `actual` / `plan` columns (the source-node shape).
 *
 *  FAILS CLOSED (`insufficient_data`) when NOT ONE metric could be evaluated — the
 *  1.1.0 guard. `flagged.length === 0` conflates "checked and clean" with "checked
 *  nothing", and the second reading is the one that suppresses action: a genuinely
 *  off-plan quarter completing green, with a human approval signature on it.
 *
 *  FAILS CLOSED A SECOND WAY (1.2.0) when every metric it did read has a PLAN of 0.
 *  `pct` is `null` there, so nothing can ever be flagged, so the verdict was
 *  `on_plan` — the same "checked and clean from nothing" one layer in. A
 *  `SUM(plan)` over a table with no plan rows returns 0, not NULL, so this is the
 *  shape an unloaded plan actually takes. */
export async function varianceCompute(ctx) {
  const cfg = ctx.config ?? {};
  const inputs = ctx.inputs ?? {};
  const businessUnit = String(cfg.businessUnit ?? inputs.businessUnit ?? '').trim();
  const rows = inputs.rows ?? cfg.rows;
  const actuals = metricBag(inputs.actuals ?? cfg.actuals, rows, 'actual');
  const plan = metricBag(inputs.plan ?? cfg.plan, rows, 'plan');
  const thresholdPct = measure(cfg.thresholdPct) ?? 0.05;

  const variances = {};
  const flagged = [];
  const missing = [];
  const uncomparable = [];
  for (const metric of METRICS) {
    const a = measure(actuals[metric]);
    const p = measure(plan[metric]);
    if (a === null || p === null) { missing.push(metric); continue; } // not provided — skip, don't fabricate
    const delta = a - p;
    const pct = p !== 0 ? delta / p : null;
    variances[metric] = { actual: a, plan: p, delta, pct };
    // A zero plan yields no percentage, so this metric can never be FLAGGED and
    // therefore contributes nothing but false reassurance to the verdict. Name it.
    if (pct === null) uncomparable.push(metric);
    else if (Math.abs(pct) >= thresholdPct) flagged.push({ metric, pct });
  }

  // The aggregate guard. The per-metric skip above says "don't fabricate"; without
  // this, the aggregate did exactly that — an empty variance set became `on_plan`.
  if (Object.keys(variances).length === 0) {
    return {
      status: 'failure',
      error: {
        code: 'insufficient_data',
        message:
          'variance-compute evaluated ZERO metrics: no actual/plan pair was supplied for any of '
          + `${METRICS.join('/')}. Supply inputs.actuals + inputs.plan (metric→number maps) or an `
          + 'inputs.rows set carrying metric/actual/plan columns. Refusing to report a verdict.',
      },
    };
  }

  // The SECOND aggregate guard (1.2.0). Reaching here with nothing comparable
  // means every plan read was 0: a delta with no denominator is not a variance,
  // and `flagged.length === 0` would report it as "on plan".
  if (uncomparable.length === Object.keys(variances).length) {
    return {
      status: 'failure',
      error: {
        code: 'insufficient_data',
        message:
          `variance-compute read ${uncomparable.join('/')} but every one has a PLAN of 0, so no `
          + 'variance percentage exists for any metric and nothing can be flagged. That is not an '
          + '"on plan" quarter — it is an unloaded plan. Refusing to report a verdict.',
      },
    };
  }

  return {
    status: 'success',
    outputs: {
      businessUnit,
      variances,
      flagged,
      thresholdPct,
      // The verdict is only ever as wide as the metrics behind it — surface that
      // rather than letting a 1-of-4 read present as a whole-BU "on plan".
      metricsEvaluated: Object.keys(variances),
      metricsMissing: missing,
      // Read, but with a zero plan — inside `variances` (the delta is real data)
      // and outside the verdict's reach (no percentage ⇒ never flaggable).
      metricsUncomparable: uncomparable,
      verdict: flagged.length === 0 ? 'on_plan' : 'off_plan',
    },
  };
}

const NINE_BOX = {
  // performance(1-3) × potential(1-3) → { box (1-9), label, readiness }
  '1,1': { box: 1, label: 'Underperformer', readiness: 'not_ready' },
  '2,1': { box: 2, label: 'Effective', readiness: 'not_ready' },
  '3,1': { box: 3, label: 'Trusted Professional', readiness: 'ready_in_role' },
  '1,2': { box: 4, label: 'Inconsistent Player', readiness: 'not_ready' },
  '2,2': { box: 5, label: 'Core Player', readiness: 'developing' },
  '3,2': { box: 6, label: 'High Performer', readiness: 'ready_1_2_years' },
  '1,3': { box: 7, label: 'Rough Diamond', readiness: 'developing' },
  '2,3': { box: 8, label: 'High Potential', readiness: 'ready_1_2_years' },
  '3,3': { box: 9, label: 'Star', readiness: 'ready_now' },
};

/** The node's declared rating domain. A rating outside it is not clamped when it
 *  came out of a data source — see {@link readRating}. */
const RATING_MIN = 1;
const RATING_MAX = 3;

/** Clamp a value the caller ACTUALLY SUPPLIED into 1-3.
 *
 *  This used to be `Math.round(num(v) ?? 0)` then `Math.max(1, …)`, i.e.
 *  `undefined → 0 → 1`. Absence and "the worst possible rating" were the same
 *  value, so every unscored person came back box 1 / Underperformer / not_ready.
 *  Clamping 9 → 3 and 0 → 1 is still correct: those are answers, not absences —
 *  the caller asserted this node's 1-3 contract and overshot it. */
function clampSupplied(n) {
  return Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(n)));
}

/** EVERY distinct value this subject carries for a rating, in row order.
 *
 *  1.1.0 returned the FIRST row that carried any rating key. A
 *  `performanceReviews` pull returns **one row per review cycle**, in collection
 *  order, with no recency field this node is entitled to trust — so "first" placed
 *  a named person from an arbitrary cycle and called it their current rating. Two
 *  different values is an ambiguity this node cannot resolve and must not guess;
 *  the caller sees `ambiguous_data` (ADR 0599 §Correction 4). */
function ratingsFromRows(rows, subjectId, keys) {
  const seen = [];
  if (!Array.isArray(rows)) return seen;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.subjectId ?? row.workerId ?? row.employeeId ?? row.id ?? '').trim();
    if (id !== subjectId) continue;
    for (const k of keys) {
      const v = row[k];
      if (v === undefined || v === null) continue;
      // The key list is a SYNONYM list, not a merge: one rating per row.
      if (!seen.some((s) => Object.is(s, v))) seen.push(v);
      break;
    }
  }
  return seen;
}

/**
 * Resolve ONE rating to `{value}` (usable), `{absent:true}`, or `{code, detail}`
 * (a typed refusal). Never returns a guess.
 *
 *  - A value the CALLER supplied is clamped into 1-3 — legitimate per §3.
 *  - A value that is not a measurement (`null`, `''`, a boolean, or an unfilled
 *    `{{params.x}}` frozen to the empty string — the ADR 0507 class) does NOT
 *    shadow the rows; it falls through, so a chain that has the data is not
 *    starved by a decorative parameter.
 *  - A ROW-derived value is **not clamped**. The node cannot know the source
 *    scale: on a 1-5 scale a mid `3` would clamp to the TOP band and read as a
 *    high performer. Outside 1-3 is `unknown_scale`, not a coerced 3.
 */
function readRating(which, explicit, rows, subjectId, keys) {
  const supplied = measure(explicit);
  if (supplied !== null) return { value: clampSupplied(supplied), raw: explicit, source: 'supplied' };

  const seen = ratingsFromRows(rows, subjectId, keys);
  if (seen.length === 0) return { absent: true };
  if (seen.length > 1) {
    return {
      code: 'ambiguous_data',
      detail:
        `subject ${subjectId} carries ${seen.length} different ${which} ratings across the review `
        + `rows (${seen.map((v) => JSON.stringify(v)).join(', ')}) and the rows carry no recency `
        + 'field this node can order them by, so "the first one" would be an arbitrary cycle',
    };
  }
  const n = measure(seen[0]);
  if (n === null) return { absent: true };
  if (n < RATING_MIN || n > RATING_MAX) {
    return {
      code: 'unknown_scale',
      detail:
        `the review rows give subject ${subjectId} a ${which} of ${JSON.stringify(seen[0])}, outside `
        + `this node's declared ${RATING_MIN}-${RATING_MAX} scale. The source scale is not declared `
        + 'anywhere this node can read it, and mapping it by guess would place a named person in the '
        + `wrong 9-box band — supply inputs.${which} on the ${RATING_MIN}-${RATING_MAX} scale instead`,
    };
  }
  return { value: Math.round(n), raw: seen[0], source: 'rows' };
}

/** 9-box readiness: performance (1-3) × potential (1-3) → cell + readiness.
 *
 *  Ratings come from explicit `inputs.performance`/`inputs.potential`, or are read
 *  out of an `inputs.rows` review set for this subject. FAILS CLOSED
 *  (`insufficient_data`) when either is absent — the 1.1.0 guard. The output is
 *  declared confidential-pii and is broadcast tenant-wide by the chain that calls
 *  it, and the node is also projected as a live chat agent tool, so a substituted
 *  default here is a fabricated HR assessment of a named human being on two
 *  independent surfaces. */
export async function talentScore(ctx) {
  const inputs = ctx.inputs ?? {};
  const cfg = ctx.config ?? {};
  const subjectId = String(inputs.subjectId ?? cfg.subjectId ?? '').trim();
  if (!subjectId) return { status: 'failure', error: { code: 'subject_required', message: 'talent-score requires a subjectId.' } };

  const rows = inputs.rows ?? cfg.rows;
  const perf = readRating('performance', inputs.performance ?? cfg.performance, rows, subjectId,
    ['performance', 'performanceRating', 'performanceScore']);
  const pot = readRating('potential', inputs.potential ?? cfg.potential, rows, subjectId,
    ['potential', 'potentialRating', 'potentialScore']);

  // A typed refusal outranks absence: "I found two conflicting answers" and "I
  // found one on a scale I cannot read" are different failures from "I found
  // none", and collapsing them would hide WHY the node would not answer.
  const refusals = [perf, pot].filter((r) => r.code);
  if (refusals.length > 0) {
    return {
      status: 'failure',
      error: {
        code: refusals[0].code,
        message:
          `talent-score refuses to score subject ${subjectId}: ${refusals.map((r) => r.detail).join('; and ')}. `
          + 'Refusing to place a named person in a 9-box cell from data this node cannot read honestly.',
      },
    };
  }

  const absent = [];
  if (perf.absent) absent.push('performance');
  if (pot.absent) absent.push('potential');
  if (absent.length > 0) {
    return {
      status: 'failure',
      error: {
        code: 'insufficient_data',
        message:
          `talent-score has no ${absent.join(' and ')} rating for subject ${subjectId}. `
          + 'Supply inputs.performance/inputs.potential (1-3), or an inputs.rows review set '
          + 'carrying this subject with performance/potential columns. Refusing to place a '
          + 'named person in a 9-box cell from absent data.',
      },
    };
  }

  const cell = NINE_BOX[`${perf.value},${pot.value}`];
  return {
    status: 'success',
    outputs: {
      subjectId,
      performance: perf.value,
      potential: pot.value,
      // The value BEFORE this node touched it, beside the value it scored, so a
      // reader can see whether a clamp happened and what the source actually said.
      performanceRaw: perf.raw,
      potentialRaw: pot.raw,
      ratingSource: { performance: perf.source, potential: pot.source },
      ...cell,
    },
  };
}

export const nodes = {
  'feature.insights-suite.nodes.variance-compute': varianceCompute,
  'feature.insights-suite.nodes.talent-score': talentScore,
};

export default nodes;
