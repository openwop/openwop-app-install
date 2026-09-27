/**
 * feature.csm.nodes — Customer-Success nodes over the `ctx.features.csm` surface
 * (ADR 0014).
 *
 * CORRECTED (CSMWF-3 / ADR 0645 D3, 2026-09-09). This block used to read: "Both
 * are role:"action" (they read/write the tenant account store, a side-effect), so
 * the engine records their outputs and replay/fork read the recorded result
 * rather than re-executing." THAT WAS FALSE — the same false claim ADR 0587 §7
 * already caught elsewhere. MEASURED: `git grep -nE "role\s*===\s*'action'" --
 * src/executor src/host` returns NOTHING; the executor never reads that field,
 * and `sideEffects.ts:185-190` says so verbatim. `health-set` sat in the manifest
 * census ONLY — in neither the side-effect floor nor the fast-path served set —
 * so a `:fork` RE-EXECUTED it against live CRM state and re-stamped a different
 * score. The contrast was inside the same chain: `feature.crm.nodes.create-task`
 * declares role:"side-effect" + ["side-effectful"] and IS in both, so CSM's
 * WRITER was classified like CRM's READERS.
 *
 * `health-set` now declares role:"side-effect" + ["side-effectful"], so it is
 * genuinely floor-classified and replay-served (measured: floor 305 -> 306,
 * served 262 -> 263, undischarged unchanged at 43 — it reaches no host AI
 * capability, so nothing holds it back). `health-read` stays role:"action": it is
 * a pure read, and that is the honest label for it.
 *
 * health-set is idempotent by accountId
 * (update-only — a node-driven create would be non-deterministic, so it's rejected).
 * Pure-JS, Node-20 stdlib only.
 */

/** Resolve the CSM feature surface, or fail with the canonical capability error. */
function ensureCsm(ctx) {
  const csm = ctx.features && ctx.features.csm;
  if (!csm || typeof csm.listAccounts !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.csm — the CSM feature must be composed (ADR 0014)'),
      { code: 'host_capability_missing', capability: 'host.sample.csm' },
    );
  }
  return csm;
}

/** Merge chain-authored config with DAG-forwarded inputs (inputs win on
 *  conflict) — the same `core.openwop.ai`/`feature.crm.nodes` idiom, needed
 *  here now that health-set can be driven by a chain's `{{params.*}}`-templated
 *  config PLUS fan-in edges from CRM read nodes (ADR 0212 §3). */
function merged(ctx) {
  return { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
}

function inputs(ctx) {
  const i = merged(ctx);
  // ADR 0582 §4 (CSM-11) — a PRESENT-but-non-numeric healthScore is a typed
  // failure, not a silent drop to `undefined`. A chain carrying an embedded
  // `{{params.healthScore}}` freezes it to a STRING (the recorded RFC 0013
  // Path-A behaviour); dropping it meant `health-set` wrote NOTHING and still
  // returned `status:'success'` — success-with-empty on a durable write.
  if (i.healthScore !== undefined && i.healthScore !== null && typeof i.healthScore !== 'number') {
    throw Object.assign(
      new Error('feature.csm.nodes.health-set: `healthScore` MUST be a number (an embedded {{params.*}} token freezes to a string — bind it as a whole-value input instead)'),
      { code: 'validation_error' },
    );
  }
  return {
    accountId: typeof i.accountId === 'string' ? i.accountId : '',
    companyId: typeof i.companyId === 'string' ? i.companyId : '',
    name: typeof i.name === 'string' ? i.name : undefined,
    healthScore: typeof i.healthScore === 'number' ? i.healthScore : undefined,
    factors: Array.isArray(i.factors) ? i.factors : undefined,
    // Kept UNCOERCED: `undefined` means the fan-in never arrived, `[]` means it
    // arrived and was empty. Collapsing the two is exactly the defect below.
    deals: i.deals,
    tasks: i.tasks,
    weights: i.weights && typeof i.weights === 'object' ? i.weights : undefined,
  };
}

/** Record a REFUSAL to score on the account, then fail typed. Writing first is
 *  deliberate: the run failing is not visible from the CSM console, so without
 *  the durable marker the page would keep showing whatever number was there and
 *  the operator would never learn the measurement had stopped working. */
async function refuseToScore(csm, accountId, reason) {
  // CSMCD-3 — the write is NOT best-effort. This used to be
  // `.catch(() => undefined)`, which defeated the very guarantee the docblock
  // above states: two failures were erased silently — (a) the write threw, and
  // (b) `setHealth` returned `{account: null}` (a cross-tenant or deleted
  // accountId), which is not an exception at all, so the catch was not even the
  // only hole. In both cases the node threw its typed error and the account kept
  // its stale green score forever — the exact outcome this machinery exists to
  // prevent. A failure to record the refusal is now itself a typed failure, and
  // it names which half went wrong.
  let wrote;
  try {
    wrote = await csm.setHealth({ accountId, measureFailedReason: reason });
  } catch (err) {
    throw Object.assign(
      new Error(`feature.csm.nodes.health-set refused to score (${reason}) AND could not record the refusal: ${err && err.message ? err.message : String(err)}`),
      { code: 'internal_error' },
    );
  }
  if (!wrote || !wrote.account) {
    throw Object.assign(
      new Error(`feature.csm.nodes.health-set refused to score (${reason}) AND could not record it: no such account for this tenant`),
      { code: 'not_found' },
    );
  }
  throw Object.assign(new Error(`feature.csm.nodes.health-set refused to score: ${reason}`), { code: 'validation_error' });
}

export async function healthRead(ctx) {
  const csm = ensureCsm(ctx);
  const { accountId } = inputs(ctx);
  if (accountId) {
    const out = await csm.getAccount({ accountId });
    return { status: 'success', outputs: { account: out.account ?? null, accounts: out.account ? [out.account] : [] } };
  }
  const out = await csm.listAccounts({});
  return { status: 'success', outputs: { accounts: out.accounts ?? [] } };
}

/** ADR 0212 §3 — the default health-from-CRM formula, kept deliberately
 *  simple and INSPECTABLE rather than a black-box model: start at 100, then
 *  subtract `weights.deals` points per open deal and `weights.tasks` points
 *  per open (non-`done`) task, clamped to [0, 100]. `deals`/`tasks` are the
 *  fan-in from `feature.crm.nodes.list-deals`/`list-tasks` (the
 *  `csm-ops.health-from-crm` chain); both are re-filtered to `companyId` here
 *  (list-deals is already company-scoped via its own `companyId` config, but
 *  list-tasks has no company filter server-side, so tasks are filtered
 *  locally by `task.companyId`). Tune the recipe per-tenant by editing the
 *  chain's health-write node `weights` config — no code change needed.
 *
 *  ADR 0582 §5 names this arithmetic `penalty-sum` on the stored row, because
 *  the in-tree demo seed emits the SAME `{factor, weight, value}` header shape
 *  from a weighted MEAN — under identical columns the two contradict each other
 *  and the breakdown was uninterpretable.
 *
 *  ADR 0582 §4 (CSM-8) also tightened the company filter to a STRICT match.
 *  `(!d?.companyId || d.companyId === companyId)` counted every UNATTRIBUTED
 *  row against EVERY account, so one org-wide untagged task deflated the whole
 *  book at once — while the pack description claimed the node "re-filters
 *  locally by task.companyId". It now filters by exactly that. */
const DEFAULT_WEIGHTS = { deals: 8, tasks: 3 };

function computeHealthFromCrm(deals, tasks, companyId, weights) {
  const w = {
    deals: typeof weights?.deals === 'number' && Number.isFinite(weights.deals) ? weights.deals : DEFAULT_WEIGHTS.deals,
    tasks: typeof weights?.tasks === 'number' && Number.isFinite(weights.tasks) ? weights.tasks : DEFAULT_WEIGHTS.tasks,
  };
  const openDeals = deals.filter((d) => d?.companyId === companyId && (d?.status ?? 'open') === 'open').length;
  const openTasks = tasks.filter((t) => t?.companyId === companyId && t?.status !== 'done').length;
  const healthScore = Math.max(0, Math.min(100, Math.round(100 - openDeals * w.deals - openTasks * w.tasks)));
  // ADR 0582 §16 — ATTRIBUTION COVERAGE, so a measured zero is distinguishable
  // from an unattributable one. `Task.companyId` is OPTIONAL and the sibling
  // chain's own `create-task` never sets it, so the strict `=== companyId`
  // filter above (correct — it replaced an over-count that charged every
  // account for every unattributed row) yields `openTasks: 0` for most tenants.
  // Zero-because-none-open and zero-because-nothing-is-attributable are
  // opposite facts about an account, and without this they render identically.
  // Reported, never scored — `weight: 0`, so they are denominators and can
  // never move the score. Emitted as plain `{factor, weight, value}` entries
  // because `validateHealthFactors` (accountsService.ts) KEEPS only those three
  // keys: an `of:`/`total:` side-channel would be silently dropped on write and
  // the node would be advertising provenance the store never kept.
  const tasksWithCompany = tasks.filter((t) => typeof t?.companyId === 'string' && t.companyId !== '').length;
  const dealsWithCompany = deals.filter((d) => typeof d?.companyId === 'string' && d.companyId !== '').length;
  return {
    healthScore,
    // 6 entries, within the service's MAX_FACTORS of 12.
    factors: [
      { factor: 'openDeals', weight: w.deals, value: openDeals },
      { factor: 'openTasks', weight: w.tasks, value: openTasks },
      { factor: 'dealsAttributed', weight: 0, value: dealsWithCompany },
      { factor: 'dealsSeen', weight: 0, value: deals.length },
      { factor: 'tasksAttributed', weight: 0, value: tasksWithCompany },
      { factor: 'tasksSeen', weight: 0, value: tasks.length },
    ],
  };
}

/**
 * Three ways to drive a write (ADR 0212 §2/§3), tried in this order:
 *   1. explicit `factors` (an upstream compute step already produced them) —
 *      passed through as-is. `healthScore` is REQUIRED alongside (R2 CS-SP-4:
 *      the service fails closed — factors without the score they computed
 *      would stamp `healthComputedAt` beside a score that was not recomputed),
 *      as are `companyId` and `method` (ADR 0582 §4/§5).
 *   2. `deals`/`tasks` fan-in (the `csm-ops.health-from-crm` chain) —
 *      `computeHealthFromCrm` derives both healthScore + factors.
 *   3. a bare `healthScore` — the manual/override path; the surface clears
 *      any prior factors/stamp (hand-typed ≠ computed).
 *
 * ADR 0582 §4 — THE COMPUTED PATH REFUSES RATHER THAN DEFAULTS. Previously
 * branch 2 fired when EITHER fan-in was present and defaulted the missing side
 * to `[]`, so a partial fan-in (which is exactly what the pre-2026 edge-wiring
 * bug produced, and what a skipped upstream node produces today) scored the
 * unmeasured side as ZERO OPEN ROWS — the maximum contribution — and the
 * service then stamped `healthComputedAt` over a breakdown asserting counts
 * nobody observed. Worse in the aggregate: the console's `ARR at risk` figure
 * counts `< 70`, so a fan-in failure *removed* that account's ARR from the
 * at-risk number. The exec summary got QUIETER when measurement broke.
 *
 * Both fan-ins must therefore be present, and `companyId` must be non-empty (a
 * blank one used to mean "scope to nothing", which with the old permissive
 * filter yielded a clean 100 out of an empty measurement). A refusal is
 * recorded on the account and then fails the node typed.
 */
export async function healthSet(ctx) {
  const csm = ensureCsm(ctx);
  const i = inputs(ctx);
  if (!i.accountId) {
    throw Object.assign(new Error('feature.csm.nodes.health-set requires `accountId` (update-only)'), { code: 'validation_error' });
  }
  const args = { accountId: i.accountId };
  if (i.name !== undefined) args.name = i.name;

  const dealsIn = Array.isArray(i.deals) ? i.deals : undefined;
  const tasksIn = Array.isArray(i.tasks) ? i.tasks : undefined;
  const anyFanIn = i.deals !== undefined || i.tasks !== undefined;

  if (i.factors !== undefined) {
    args.factors = i.factors;
    if (i.healthScore !== undefined) args.healthScore = i.healthScore;
    if (i.companyId) args.companyId = i.companyId;
    // ADR 0582 §15 — REFUSE, do not invent. This used to default a missing
    // `method` to `'penalty-sum'`, which satisfied the service's "a breakdown
    // with no stated arithmetic is not interpretable" check by FABRICATING the
    // arithmetic: an upstream weighted-mean breakdown got stamped
    // `penalty-sum`, the SPA rendered that as a sentence, and the agent prompt
    // tells the model to trust it. Only the branch below may hardcode
    // `'penalty-sum'`, because that branch actually runs it
    // (`computeHealthFromCrm`). Same "invent rather than refuse" shape removed
    // from `clampScore`.
    const declaredMethod = merged(ctx).method;
    if (typeof declaredMethod !== 'string' || declaredMethod.trim() === '') {
      await refuseToScore(
        csm,
        i.accountId,
        'a factors breakdown was supplied without a `method` naming the arithmetic that produced it, so the stored score could not be labelled honestly',
      );
    }
    args.method = declaredMethod;
  } else if (anyFanIn) {
    if (dealsIn === undefined || tasksIn === undefined) {
      const missing = [dealsIn === undefined ? 'deals' : null, tasksIn === undefined ? 'tasks' : null].filter(Boolean).join(' and ');
      await refuseToScore(csm, i.accountId, `the CRM fan-in was incomplete (${missing} never arrived), so an unmeasured side would have scored as zero open rows`);
    }
    if (!i.companyId) {
      await refuseToScore(csm, i.accountId, 'no companyId was supplied, so the deals and tasks could not be scoped to this account');
    }
    const computed = computeHealthFromCrm(dealsIn, tasksIn, i.companyId, i.weights);
    args.healthScore = computed.healthScore;
    args.factors = computed.factors;
    args.companyId = i.companyId;
    args.method = 'penalty-sum';
  } else if (i.healthScore !== undefined) {
    args.healthScore = i.healthScore;
  } else {
    // Nothing to write. Previously this returned `status:'success'` having
    // touched nothing — success-with-empty on a durable write path.
    throw Object.assign(
      new Error('feature.csm.nodes.health-set had nothing to write: supply `healthScore`, `factors`, or a deals+tasks fan-in'),
      { code: 'validation_error' },
    );
  }

  const out = await csm.setHealth(args);
  if (!out.account) {
    throw Object.assign(new Error('CSM account not found for this tenant'), { code: 'not_found' });
  }
  return { status: 'success', outputs: { account: out.account } };
}

export const nodes = {
  'feature.csm.nodes.health-read': healthRead,
  'feature.csm.nodes.health-set': healthSet,
};

export default nodes;
