/**
 * Strategy cadence config (ADR 0231 §C2/§C3) — the insights-suite reconcile
 * pattern (ADR 0082): a small per-tenant config that (re)registers ONE
 * deterministic scheduler job per chain (`strategy.weekly-checkin`,
 * `strategy.metric-sync`) against the chain-expanded workflow, and removes it
 * when disabled. No auto-boot jobs — a clean install stays quiet until an
 * operator opts in; autonomous-run budgets bind exactly as schedule fires do.
 *
 * The chain expands to a DETERMINISTIC per-tenant workflow id (idempotent
 * re-register on re-save) — never the random `/workflows/from-chain` instance
 * id, so re-saving config can't leak workflow copies.
 */
import { createHash } from 'node:crypto';
import { STRATEGY_TOGGLE_ID } from './types.js';
import { ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { workflowRoomLive } from '../../host/collab/workflowCollabResource.js';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerJob, deleteJob, getJob } from '../../host/schedulingService.js';
import { getChain, expandChain, findUnfilledExpansionParams } from '../../host/workflowChainPackLoader.js';
import { registerWorkflow, getRegisteredWorkflow } from '../../host/workflowsRegistry.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { recordOwnership } from '../../host/workflowOwnership.js';
import { createLogger } from '../../observability/logger.js';
import { parseCron } from '../../host/cronSchedule.js';

const log = createLogger('strategy.cadence');

export interface CadenceEntry {
  enabled: boolean;
  /** RFC 0052 cron (5-field). */
  cron: string;
  timezone?: string;
  /**
   * ADR 0597 §5 (SPC-1 / SPWF-2) — the chain PARAMETERS this schedule fires
   * with. `applyCadenceConfig` used to call `expandChain(chain, {})` with no way
   * for any caller to supply one, so `strategy.board-pack` — which declares
   * `orgId` REQUIRED with no default — expanded with `config.orgId === undefined`
   * and errored `validation_error` at `create-board-memo` on EVERY scheduled
   * fire, after the PUT had returned 200 and registered a durable job.
   * Scalars only (they are frozen into node config, and a nested object is not
   * something a cron schedule should carry).
   */
  params?: Record<string, string | number | boolean>;
}

export interface StrategyCadenceConfig {
  tenantId: string;
  /** The human whose authority scheduled runs carry (the insights-suite shape). */
  ownerUserId: string;
  weeklyCheckin?: CadenceEntry;
  metricSync?: CadenceEntry;
  /** ADR 0233 §C5 — the MBR/QBR pre-read chain. */
  boardPack?: CadenceEntry;
  updatedAt: string;
}

const configs = new DurableCollection<StrategyCadenceConfig>('strategy:cadence', (c) => c.tenantId);

const CHAINS = {
  weeklyCheckin: 'strategy.weekly-checkin',
  metricSync: 'strategy.metric-sync',
  boardPack: 'strategy.board-pack',
} as const;
type CadenceKey = keyof typeof CHAINS;

const tenantSlug = (tenantId: string): string => createHash('sha256').update(tenantId).digest('hex').slice(0, 10);
const jobIdFor = (tenantId: string, key: CadenceKey): string => `strategy-cadence:${key}:${tenantSlug(tenantId)}`;
const workflowIdFor = (tenantId: string, key: CadenceKey): string => `wf.${CHAINS[key].replace(/\./g, '-')}.cadence-${tenantSlug(tenantId)}`;

export async function getCadenceConfig(tenantId: string): Promise<StrategyCadenceConfig | null> {
  return configs.get(tenantId);
}

function parseEntry(raw: unknown, field: string): CadenceEntry | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const enabled = o.enabled === true;
  const cron = typeof o.cron === 'string' ? o.cron.trim() : '';
  if (enabled) {
    if (!cron) throw new OpenwopError('validation_error', `\`${field}.cron\` is required when enabled.`, 400, { field });
    if (parseCron(cron) === null) {
      throw new OpenwopError('validation_error', `\`${field}.cron\` is not a valid cron expression.`, 400, { field, cron });
    }
  }
  const tz = typeof o.timezone === 'string' && o.timezone.trim() ? o.timezone.trim() : undefined;
  // ADR 0597 §Correction 8 — `parseParams` used to be called TWICE here (once
  // for the ternary's test, once for its value). Harmless while it is pure, and
  // exactly the trap a validator that later logs, counts or rejects walks into:
  // it would fire twice per entry with nothing at the call site saying so.
  const params = parseParams(o.params, field);
  return { enabled, cron, ...(tz ? { timezone: tz } : {}), ...(params ? { params } : {}) };
}

/** Chain params for a cadence entry: a flat scalar bag, validated at SAVE time
 *  (the human act with a caller to fail loudly at). */
function parseParams(raw: unknown, field: string): Record<string, string | number | boolean> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', `\`${field}.params\` must be an object of scalar chain parameters.`, 400, { field });
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new OpenwopError('validation_error', `\`${field}.params.${k}\` must be a string, number or boolean.`, 400, { field, param: k });
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One enabled entry, fully resolved and fully VALIDATED, awaiting the write
 *  phase. Nothing in here has touched durable state. */
interface CadencePlanStep {
  key: CadenceKey;
  entry: CadenceEntry;
  jobId: string;
  workflowId: string;
  label: string;
  cadenceDef: ReturnType<typeof expandChain> & { workflowId: string };
  nodeCount: number;
}

/**
 * Persist + reconcile. For each enabled entry: ensure the deterministic
 * chain-expanded workflow exists, then (re)register the deterministic job.
 * Disabled/absent ⇒ the job is deleted (the workflow row is left — harmless,
 * deterministic id, replay-referenced).
 *
 * ── ADR 0597 §Correction 2: VALIDATE EVERYTHING, THEN WRITE ──────────────────
 *
 * This function used to `configs.put` FIRST and reconcile entries one at a time
 * after it, throwing from inside that loop. §5 set out to close the family
 * "a save that returns OK and fails forever afterwards" and MOVED it instead:
 * post-§5, `PUT {weeklyCheckin, boardPack}` with no `boardPack.params`
 * answered **400** and still left behind
 *
 *   - a persisted config claiming `boardPack {enabled:true, cron:'0 8 * * 1'}`
 *     with no job and no workflow — strictly LESS observable than the bug it
 *     replaced, which at least left a run row to find; and
 *   - for `weeklyCheckin`, which `CHAINS` processes FIRST: a registered
 *     workflow, a `recordOwnership` row (so it appears in the builder gallery)
 *     and a live cron job — all from a request the caller was told had failed.
 *
 * So the refusal is hoisted out of the write path entirely. PHASE 1 is a pure
 * pass — parse, resolve the chain, expand, check unfilled params, and check the
 * deterministic jobId is ours — that writes nothing and owns EVERY refusal.
 * PHASE 2 writes what phase 1 proved.
 *
 * HONEST BOUND (do not upgrade this sentence into "atomic"): there is no
 * transaction across `configs`, `workflowOwnership`, `workflowRevisions` and
 * `schedulingService`. The guarantee is that **every VALIDATION failure — the
 * whole reachable refusal surface — happens before any write**, not that a
 * store outage mid-phase-2 rolls back. That residual is recorded in ADR 0597
 * rather than papered over here.
 */
export async function applyCadenceConfig(input: {
  tenantId: string;
  ownerUserId: string;
  weeklyCheckin?: unknown;
  metricSync?: unknown;
  boardPack?: unknown;
}): Promise<StrategyCadenceConfig> {
  // ── PHASE 1 — VALIDATE. No durable write happens anywhere below this point
  //    until the phase-2 banner. Every `throw` in this function lives here.
  //
  // Each entry is parsed EXACTLY ONCE (ADR 0597 §Correction 8): the old
  // spread-with-a-ternary called `parseEntry` twice per key — six calls for
  // three entries, each re-running `parseParams` twice more. Harmless while
  // both are pure, and a trap the moment a validator stops being.
  const parsed: Partial<Record<CadenceKey, CadenceEntry>> = {
    weeklyCheckin: parseEntry(input.weeklyCheckin, 'weeklyCheckin'),
    metricSync: parseEntry(input.metricSync, 'metricSync'),
    boardPack: parseEntry(input.boardPack, 'boardPack'),
  };
  const config: StrategyCadenceConfig = {
    tenantId: input.tenantId,
    ownerUserId: input.ownerUserId,
    ...(parsed.weeklyCheckin ? { weeklyCheckin: parsed.weeklyCheckin } : {}),
    ...(parsed.metricSync ? { metricSync: parsed.metricSync } : {}),
    ...(parsed.boardPack ? { boardPack: parsed.boardPack } : {}),
    updatedAt: new Date().toISOString(),
  };

  const plan: CadencePlanStep[] = [];
  const retire: string[] = [];
  for (const key of Object.keys(CHAINS) as CadenceKey[]) {
    const entry = config[key];
    const jobId = jobIdFor(config.tenantId, key);
    if (!entry?.enabled) {
      retire.push(jobId);
      continue;
    }
    const found = getChain(CHAINS[key]);
    if (!found) {
      throw new OpenwopError('conflict', `Workflow chain '${CHAINS[key]}' is not loaded on this host (install the strategy chain pack).`, 409, { chainId: CHAINS[key] });
    }
    const workflowId = workflowIdFor(config.tenantId, key);
    const expanded = expandChain(found.chain, { params: entry.params ?? {} });
    const cadenceDef = { ...expanded, workflowId, metadata: { ...expanded.metadata, name: found.chain.label } };
    // ADR 0597 §5 — REFUSE AT SAVE TIME. `expandChain` records the params that
    // did NOT freeze in `metadata.unresolvedParams` and returns happily
    // (deliberately — ADR 0504 measured that refusing at expansion breaks
    // "use template = just copy"). Nothing on the cadence path read that
    // metadata, so `PUT /strategy/cadence` answered 200, `recordOwnership`
    // published the workflow into the builder gallery, a durable job was
    // registered, and the chain then failed at its first node every single
    // fire, forever, with the only trace being the run row.
    //
    // A cadence PUT is a HUMAN ACT WITH A CALLER TO FAIL LOUDLY AT — precisely
    // the boundary ADR 0504 said seeding could not use. `/workflows/from-chain`
    // already surfaces the same finding (`routes/workflows.ts:903`); this lane
    // was the one that swallowed it.
    //
    // FALSIFIED PRESCRIPTION (recorded in ADR 0597 §5): the workflows-grader
    // prescribed `expandChain(chain, { deferred: true })` "matching the
    // seeder". That is a NO-OP for this failure. Deferred mode materializes
    // `orgId` as a run-overridable VARIABLE with no default; a cron fire
    // supplies no `configurable`, so the bag is still empty, the config still
    // resolves to `undefined`, and `create-board-memo` still returns
    // `validation_error` — it only moves the failure from "frozen undefined"
    // to "unfilled variable". Deferral makes a workflow FILLABLE; it does not
    // make an unfilled one RUN.
    const unfilled = findUnfilledExpansionParams(cadenceDef);
    if (unfilled.length > 0) {
      throw new OpenwopError(
        'validation_error',
        `The ${key} chain needs ${unfilled.map((u) => `\`${u.param}\``).join(', ')} before it can be scheduled — a run of it would fail at the first node. Supply them under \`${key}.params\`.`,
        400,
        { field: `${key}.params`, chainId: CHAINS[key], missing: [...new Set(unfilled.map((u) => u.param))] },
      );
    }
    // The ONE way `registerJob` can refuse a cadence write, hoisted into phase 1
    // so the write phase has no reachable refusal left. `jobIdFor` derives the
    // id from `sha256(tenantId)[0..10]`, so this needs a 40-bit tenant-slug
    // collision — rare, and the reason to catch it here rather than shrug:
    // `deleteJob` below is jobId-keyed, so on a collision a DISABLE would have
    // reached into the colliding tenant's job. (`schedule_horizon_exceeded`,
    // the other refusal, needs a `firstFireAtMs` this lane never sends.)
    const prior = await getJob(jobId);
    if (prior && prior.tenantId !== config.tenantId) {
      throw new OpenwopError('conflict', `The cadence schedule id for '${key}' is not available on this host.`, 409, { field: key });
    }
    plan.push({ key, entry, jobId, workflowId, label: found.chain.label, cadenceDef, nodeCount: expanded.nodes.length });
  }

  // ── PHASE 2 — WRITE. Everything below is proved reachable-and-valid by
  //    phase 1; nothing below may refuse the caller's request.
  await configs.put(config);

  for (const jobId of retire) {
    await deleteJob(jobId).catch(() => undefined);
  }

  for (const step of plan) {
    // ADR 0481 (code-review H3) — a live collab room owns the head; skip the
    // re-register (the schedule below still updates; the def refreshes on the
    // next config save after the session ends). Loud, never silent.
    if (await workflowRoomLive(step.workflowId)) {
      // ADR 0676 `SPWF-9a` — the skip is correct for a RE-register (the def refreshes on
      // the next save), but it must not arm a schedule against a workflow id that nothing
      // has registered. A first-time enable during a live collab room previously fell
      // through to `registerJob` below, and the daemon's due-filter only requires
      // `j.workflowId` to be PRESENT (`scheduleDaemon.ts:71`), not resolvable — so the job
      // fired forever against an id with no definition. `SPWF-9b` (whether to skip, or to
      // register durably first) stays open; this closes only the arming.
      if (!getRegisteredWorkflow(step.workflowId)) {
        log.error('cadence job NOT armed — workflow is in a live collab session and has never been registered', {
          workflowId: step.workflowId, jobId: step.jobId,
        });
        continue;
      }
      log.warn('cadence re-register skipped — workflow is in a live collab session', { workflowId: step.workflowId });
    } else {
      registerWorkflow(step.cadenceDef);
      // ADR 0474 — instantiation is the first revision.
      await recordRevision(config.tenantId, step.cadenceDef);
      await recordOwnership(config.tenantId, step.workflowId, { name: step.label, nodeCount: step.nodeCount });
    }
    const res = await registerJob({
      jobId: step.jobId,
      tenantId: config.tenantId,
      cronExpr: step.entry.cron,
      workflowId: step.workflowId,
      ownerUserId: config.ownerUserId,
      enabled: true,
      // ADR 0676 D3 — gate the FIRE, not just the route. `requireFeatureEnabled` runs only
      // on GET/PUT /strategy/cadence, so before this a tenant could disable `strategy` and
      // the cadence would keep running its chains — billing a BYOK LLM call per entry. The
      // per-tenant fire-time gate already existed (`scheduleDaemon.ts:109-127`) and is
      // opt-in by design ("Absent featureId ⇒ ungated"); strategy simply never opted in,
      // while `insights-suite` and `knowledge-sync` both did. So the row's filed cause
      // ("no fire-time re-check exists") was FALSE — the gate existed and this lane
      // declined it. Safe: `strategy` is status:'on' (feature.ts) and `getEffectiveConfig`
      // returns the code-registered default when no override row exists, so a tenant that
      // has never touched the toggle still fires.
      featureId: STRATEGY_TOGGLE_ID,
      ...(step.entry.timezone ? { timezone: step.entry.timezone } : {}),
    });
    if (!res.ok) {
      // Unreachable by construction (see the phase-1 pre-check). Kept because
      // "unreachable" is a claim about today's `registerJob`, and a silent
      // `ok:false` would be a schedule that does not exist wearing a 200.
      log.error('cadence job registration refused after validation', { jobId: step.jobId, error: res.error });
      throw new OpenwopError('conflict', 'The cadence cron could not be scheduled.', 409, { jobId: step.jobId, error: res.error });
    }
  }
  return config;
}

/** R2 STR2-M7 — the cadence config's owner. The schedule survives; the person does not. */
export async function eraseCadenceSubject(tenantId: string, forms: ReadonlySet<string>): Promise<void> {
  const c = await configs.get(tenantId);
  if (!c || !forms.has(c.ownerUserId)) return;
  await configs.put({ ...c, ownerUserId: ERASED_USER_REF });
}
