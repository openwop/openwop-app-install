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
    // ADR 0882 D2 — the org the fan-in was read from; the service checks it
    // against the account's crmRef, and the run's person must be a writer there.
    orgId: typeof i.orgId === 'string' ? i.orgId : '',
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
  // ADR 0882 D4 (pre-code review HIGH-1) — a PLAY's own tasks are not evidence
  // about the customer. Counting them let a renewal ladder pull an account under
  // the at-risk line, which fired the rescue play, whose tasks pulled it further:
  // the intervention corrupting the measurement it reacts to. They are reported
  // (weight 0) so a reader still sees them, and never scored.
  const isPlayTask = (t) => typeof t?.taskId === 'string' && t.taskId.startsWith('task:play:');
  const openTasks = tasks.filter((t) => t?.companyId === companyId && t?.status !== 'done' && !isPlayTask(t)).length;
  const playTasksOpen = tasks.filter((t) => t?.companyId === companyId && t?.status !== 'done' && isPlayTask(t)).length;
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
      { factor: 'playTasksOpen', weight: 0, value: playTasksOpen },
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
    if (i.orgId) args.orgId = i.orgId;
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
    // ADR 0882 D2 — absent on a frozen pre-0882 copy; the service then records
    // why it stopped measuring and refuses, rather than accepting an org-less set.
    if (i.orgId) args.orgId = i.orgId;
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

/* ─── ADR 0882 D6 — playbooks (absorbs ADR 0568 §1) ─────────────────────── */

const DEFAULT_AT_RISK_THRESHOLD = 70;

function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * `at-risk-check` — does a health change START a rescue play? The crossing is
 * judged on the EVENT (previous ≥ T or absent, new < T); the account is also read
 * NOW and must still be below T. The live read is a guard only: it can turn a
 * crossing off, never on. Judging on live state would let a late run of an
 * earlier non-crossing event (75→72, read live at 50) qualify alongside the event
 * that really crossed, and the account would get two ladders. An unscored account
 * never qualifies (unscored ≠ low, ADR 0582 §4).
 */
export async function atRiskCheck(ctx) {
  const csm = ensureCsm(ctx);
  const m = merged(ctx);
  const hasEvent = !!(m.event && typeof m.event === 'object');
  const payload = hasEvent ? (m.event.payload && typeof m.event.payload === 'object' ? m.event.payload : m.event) : {};
  const accountId = (typeof payload.accountId === 'string' && payload.accountId) || (typeof m.accountId === 'string' ? m.accountId : '');
  if (!accountId) {
    throw Object.assign(new Error('feature.csm.nodes.at-risk-check requires an `accountId` (or an event payload carrying one)'), { code: 'validation_error' });
  }
  const threshold = numberOr(m.threshold, DEFAULT_AT_RISK_THRESHOLD);
  const prev = typeof payload.previousScore === 'number' ? payload.previousScore : undefined;
  const next = typeof payload.healthScore === 'number' ? payload.healthScore : undefined;
  const out = await csm.getAccount({ accountId });
  if (!out.account) {
    throw Object.assign(new Error('CSM account not found for this tenant'), { code: 'not_found' });
  }
  const live = typeof out.account.healthScore === 'number' ? out.account.healthScore : undefined;
  let reason;
  if (live === undefined) reason = 'unscored';
  else if (live >= threshold) reason = 'recovered';
  else if (!hasEvent) reason = 'below-threshold';
  else if (next === undefined) reason = 'event-unscored';
  else if (next >= threshold) reason = 'no-crossing';
  else if (prev !== undefined && prev < threshold) reason = 'already-at-risk';
  else reason = 'crossed';
  const qualifies = reason === 'crossed' || reason === 'below-threshold';
  const transitionKey = typeof payload.changedAt === 'string' ? payload.changedAt : '';
  return { status: 'success', outputs: { accountId, qualifies, reason, threshold, transitionKey } };
}

/** `renewals-due` — the renewal window, soonest first (overdue included, flagged). */
export async function renewalsDue(ctx) {
  const csm = ensureCsm(ctx);
  const m = merged(ctx);
  // A literal key set (pack↔surface arg parity): `undefined` reads as absent ⇒ 90.
  const out = await csm.listRenewalsDue({ days: m.days });
  const accounts = Array.isArray(out.accounts) ? out.accounts : [];
  return {
    status: 'success',
    outputs: { asOf: out.asOf, days: out.days, accounts, accountIds: accounts.map((a) => a.accountId), count: accounts.length, any: accounts.length > 0 },
  };
}

/** A short, stable, non-cryptographic digest — the id SHAPE, not a secret. Two
 *  FNV-1a lanes with different offsets (64 bits): task ids share ONE global
 *  keyspace, and a 32-bit digest made a cross-account collision plausible at
 *  scale (CSM2CD-8). */
function digest(parts) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (const ch of parts.join('\u0000')) {
    const c = ch.codePointAt(0);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

const DAY_MS = 86_400_000;
/** The surface's per-call read size (`MAX_PLAY_ACCOUNTS`) and this node's per-run ceiling. */
const PLAY_TARGET_SLICE = 50;
const MAX_PLAY_ACCOUNTS_PER_RUN = 500;
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `create-play-tasks` — the play's effect: one CRM task per step per account,
 * written through `ctx.features.crm.createTask`, so CRM's org/tenant floors, link
 * validation and territory visibility all apply (never a parallel todo store).
 *
 * The id is deterministic: `task:play:<playId>:<digest(account, org, company)>:
 * <cycleKey>:<i>`. A weekly runway re-run re-ENSURES the same ladder (an existing
 * same-org row is returned unchanged and counts as ensured), and a relink to a
 * different org/company starts a fresh ladder instead of colliding with the old
 * one. A play task someone DELETED is re-created by the next run (stated, not a
 * tombstone). Accounts with no CRM link are `skipped`; a floor refusal PROPAGATES.
 * Nothing ensured ⇒ a typed failure, never success-with-empty. The output carries
 * task and account ids only: no names, no assignee.
 */
export async function createPlayTasks(ctx) {
  const csm = ensureCsm(ctx);
  const crm = ctx.features && ctx.features.crm;
  if (!crm || typeof crm.createTask !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.features.crm — a play writes CRM tasks'), { code: 'host_capability_missing', capability: 'host.sample.crm' });
  }
  const m = merged(ctx);
  const playId = typeof m.playId === 'string' && /^[a-z0-9-]{1,40}$/.test(m.playId) ? m.playId : '';
  if (!playId) throw Object.assign(new Error('feature.csm.nodes.create-play-tasks requires `playId` (lowercase, digits, dashes; ≤40)'), { code: 'validation_error' });
  const steps = Array.isArray(m.steps) ? m.steps : [];
  if (steps.length === 0 || steps.length > 10 || !steps.every((st) => st && typeof st.title === 'string' && st.title.trim())) {
    throw Object.assign(new Error('feature.csm.nodes.create-play-tasks requires 1–10 `steps`, each with a `title`'), { code: 'validation_error' });
  }
  const cycle = m.cycle === 'renewal' || m.cycle === 'transition' ? m.cycle : 'run';
  const ids = Array.isArray(m.accountIds) ? m.accountIds : (typeof m.accountId === 'string' && m.accountId ? [m.accountId] : []);
  if (ids.length === 0) throw Object.assign(new Error('feature.csm.nodes.create-play-tasks requires `accountId` or `accountIds`'), { code: 'validation_error' });
  const transitionKey = typeof m.transitionKey === 'string' ? m.transitionKey : '';
  if (cycle === 'transition' && !transitionKey) {
    throw Object.assign(new Error('feature.csm.nodes.create-play-tasks: cycle "transition" needs the event\'s `transitionKey`'), { code: 'validation_error' });
  }
  // CSM2CD-1 — the surface reads at most PLAY_TARGET_SLICE accounts per call; a
  // book with more renewals due than that used to fail the WHOLE run (and create
  // nothing) every week. Read in slices, under an overall ceiling that fails typed.
  if (ids.length > MAX_PLAY_ACCOUNTS_PER_RUN) {
    throw Object.assign(new Error(`feature.csm.nodes.create-play-tasks: ${ids.length} accounts exceeds the per-run ceiling of ${MAX_PLAY_ACCOUNTS_PER_RUN} — narrow the window`), { code: 'play_too_large' });
  }
  const targets = [];
  for (let i = 0; i < ids.length; i += PLAY_TARGET_SLICE) {
    const out = await csm.playTargets({ accountIds: ids.slice(i, i + PLAY_TARGET_SLICE) });
    targets.push(...(out.targets ?? []));
  }
  const now = Date.now();
  const tasks = [];
  const skipped = [];
  const refused = [];
  for (const tg of targets) {
    if (tg.missing) { skipped.push({ accountId: tg.accountId, reason: 'not-found' }); continue; }
    if (tg.linkGone) { skipped.push({ accountId: tg.accountId, reason: 'crm-link-gone' }); continue; }
    if (!tg.orgId || !tg.companyId) { skipped.push({ accountId: tg.accountId, reason: 'no-crm-link' }); continue; }
    let cycleKey;
    if (cycle === 'renewal') {
      if (!tg.renewalDate) { skipped.push({ accountId: tg.accountId, reason: 'no-renewal-date' }); continue; }
      cycleKey = String(tg.renewalDate).slice(0, 10);
    } else if (cycle === 'transition') {
      cycleKey = transitionKey;
    } else {
      cycleKey = String(ctx.runId ?? '');
    }
    const key = digest([tg.accountId, tg.orgId, tg.companyId]);
    const renewalMs = tg.renewalDate ? Date.parse(tg.renewalDate) : NaN;
    // CSM2CD-2 — ONE account's failure must not starve the rest. Accounts are
    // processed soonest-renewal first, so an unconditional throw let the same
    // broken account block every later one on every run. A record the person
    // cannot see or a link CRM refuses is skipped with its code; a missing
    // AUTHORITY is collected and fails the node after the loop (a floor refusal
    // is never folded into "skipped").
    try {
    for (let i = 0; i < steps.length; i += 1) {
      const st = steps[i];
      let dueMs;
      if (typeof st.daysBeforeRenewal === 'number' && Number.isFinite(renewalMs)) dueMs = Math.max(now, renewalMs - st.daysBeforeRenewal * DAY_MS);
      else if (typeof st.dueInDays === 'number') dueMs = now + Math.max(0, st.dueInDays) * DAY_MS;
      // A literal key set (pack↔surface arg parity); the surface reads an
      // `undefined` dueDate/assignee as absent.
      const out = await crm.createTask({
        orgId: tg.orgId,
        companyId: tg.companyId,
        title: `${st.title.trim()} — ${tg.name}`,
        taskId: `task:play:${playId}:${key}:${digest([cycleKey])}:${i}`,
        dueDate: dueMs !== undefined ? isoDay(dueMs) : undefined,
        assignee: tg.assignee || undefined,
      });
      tasks.push({ taskId: out.task && out.task.taskId, accountId: tg.accountId });
    }
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code === 'forbidden_scope') refused.push({ accountId: tg.accountId, code });
      else if (code === 'not_found' || code === 'validation_error') skipped.push({ accountId: tg.accountId, reason: code });
      else throw err;
    }
  }
  if (refused.length > 0) {
    throw Object.assign(new Error(`feature.csm.nodes.create-play-tasks was refused for ${refused.length} account(s) (${refused.map((r) => r.accountId).join(', ')}): the run's person may not write tasks in their CRM org. ${tasks.length} task(s) were ensured for the others.`), { code: 'forbidden_scope' });
  }
  if (tasks.length === 0) {
    throw Object.assign(new Error(`feature.csm.nodes.create-play-tasks ensured no task: ${skipped.map((x) => `${x.accountId} (${x.reason})`).join(', ')}`), { code: 'no_play_targets' });
  }
  return { status: 'success', outputs: { playId, tasks, skipped } };
}

export const nodes = {
  'feature.csm.nodes.health-read': healthRead,
  'feature.csm.nodes.health-set': healthSet,
  'feature.csm.nodes.at-risk-check': atRiskCheck,
  'feature.csm.nodes.renewals-due': renewalsDue,
  'feature.csm.nodes.create-play-tasks': createPlayTasks,
};

export default nodes;
