/**
 * ADR 0418 P1 — the computer-use control loop. The invariants (each is an
 * acceptance criterion from the ADR's §Decision):
 *  - SUBMIT-once: a requestHash CAS claim gates provider submission — a re-run/
 *    fork resolves the existing session, never re-drives a browser.
 *  - Risk-tiered HITL: observe/interact auto-advance (recorded); EVERY
 *    commit-tier action halts the session `awaiting_approval` — the decision
 *    rides the existing approval primitives (chain: task → approvalGate →
 *    decide), never a new approval flow.
 *  - Fail-closed origin allowlist: a provider-reported URL outside the task's
 *    https allowlist DENIES the action and fails the session — no override.
 *  - Ceilings: per-session step cap + per-call poll budget (runaway backstop).
 *  - Budget: a feature-local KV daily session counter (the imagegen:budget
 *    precedent — mediaBudget-kind absorption deferred, recorded in the ADR).
 */
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
// ADR 0541 — the grant is a HOST authority object, so the gate can consult it
// without importing a feature.
import { consultApplyGrant, consumeSubmit, claimSubmission, type CommitClass } from '../../host/applyGrant.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { tierOf, type ComputerUseAdapter, type CuAction } from './adapter.js';
import {
  claimSession, getSession, putSession, requestHashFor, sessionIdFor,
  type CuSession, type CuStep,
} from './sessionStore.js';

const log = createLogger('computer-use');

/** Hard per-session step ceiling (recorded steps, all tiers). */
const MAX_STEPS = 40;
/** Auto-advanced steps per advance() call — the loop yields regularly so a
 *  single node invocation never pins a worker. */
const MAX_STEPS_PER_ADVANCE = 10;

function dailyCap(): number {
  const raw = Number(process.env.OPENWOP_COMPUTER_USE_DAILY_SESSIONS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 20;
}

// Feature-local daily session counter (KV, UTC day) — the imagegen precedent.
interface DayCount { key: string; tenantId: string; count: number }
const dayCounts = new DurableCollection<DayCount>('computer-use:budget', (c) => c.key, undefined, (c) => c.tenantId);

async function chargeDailyBudget(tenantId: string): Promise<void> {
  const cap = dailyCap();
  if (cap <= 0) return; // 0 = uncapped (operator's explicit choice)
  const key = `${tenantId}:${new Date().toISOString().slice(0, 10)}`;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const existing = await dayCounts.get(key);
    const used = existing?.count ?? 0;
    if (used >= cap) {
      throw new OpenwopError('rate_limited', `Daily computer-use session budget reached (${used}/${cap}).`, 429, { used, cap });
    }
    if (await dayCounts.compareAndSwap(existing ?? null, { key, tenantId, count: used + 1 })) return;
  }
  throw new OpenwopError('conflict', 'Budget counter contention — retry.', 409, {});
}

/** Best-effort decrement when a charged session never reached the provider. */
async function refundDailyBudget(tenantId: string): Promise<void> {
  const key = `${tenantId}:${new Date().toISOString().slice(0, 10)}`;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const existing = await dayCounts.get(key);
    if (!existing || existing.count <= 0) return;
    if (await dayCounts.compareAndSwap(existing, { ...existing, count: existing.count - 1 })) return;
  }
}

/** Parse + validate the fail-closed origin allowlist: non-empty, https, real
 *  hosts. Stored on the session at start; immutable afterwards. */
export function parseAllowedOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpenwopError('validation_error', 'Field `allowedOrigins` must be a non-empty array of https origins (fail-closed — an empty list would allow nothing).', 422, { field: 'allowedOrigins' });
  }
  return raw.map((v, i) => {
    if (typeof v !== 'string') throw new OpenwopError('validation_error', `allowedOrigins[${i}] must be a string.`, 422, { field: 'allowedOrigins' });
    let url: URL;
    try { url = new URL(v); } catch {
      throw new OpenwopError('validation_error', `allowedOrigins[${i}] is not a valid origin URL.`, 422, { field: 'allowedOrigins' });
    }
    if (url.protocol !== 'https:') throw new OpenwopError('validation_error', `allowedOrigins[${i}] must be https.`, 422, { field: 'allowedOrigins' });
    return url.origin;
  });
}

function originAllowed(session: CuSession, action: CuAction): boolean {
  if (!action.url) return true; // non-URL actions are constrained by tier, not origin
  try {
    return session.allowedOrigins.includes(new URL(action.url).origin);
  } catch {
    return false; // unparseable provider URL — fail closed
  }
}

export interface StartTaskInput {
  tenantId: string;
  orgId: string;
  task: string;
  startUrl: string;
  allowedOrigins: unknown;
  createdBy: string;
  /**
   * ADR 0541 D2 — the apply-grant context, set ONLY by a job-search campaign.
   *
   * Threaded here because it was previously READ by the commit gate and SET by
   * nothing: the grant integration existed in code and could not be reached by
   * any caller. The P2 tests passed because they built a session object
   * directly, which proved the gate worked and never proved the field could be
   * populated — the mechanism was tested, its reachability was not.
   *
   * Absent (every caller that is not a campaign) ⇒ nothing to consult ⇒ the
   * commit tier halts for a human exactly as before.
   */
  applyContext?: CuSession['applyContext'];
}

export interface SessionView {
  sessionId: string;
  status: CuSession['status'];
  steps: number;
  pendingAction?: CuAction;
  resultSummary?: string;
  error?: string;
}

const view = (s: CuSession): SessionView => ({
  sessionId: s.sessionId,
  status: s.status,
  steps: s.steps.length,
  ...(s.pendingAction ? { pendingAction: s.pendingAction } : {}),
  ...(s.resultSummary ? { resultSummary: s.resultSummary } : {}),
  ...(s.error ? { error: s.error } : {}),
});

/** Start (or resolve) a task session, then advance it. Identical inputs land on
 *  the SAME session (submit-once); only a fresh claim charges budget/provider. */
export async function startTask(adapter: ComputerUseAdapter, input: StartTaskInput): Promise<SessionView> {
  const task = input.task.trim();
  if (!task) throw new OpenwopError('validation_error', 'Field `task` is required.', 422, { field: 'task' });
  const allowedOrigins = parseAllowedOrigins(input.allowedOrigins);
  let startUrl: URL;
  try { startUrl = new URL(input.startUrl); } catch {
    throw new OpenwopError('validation_error', 'Field `startUrl` must be a valid https URL.', 422, { field: 'startUrl' });
  }
  if (startUrl.protocol !== 'https:' || !allowedOrigins.includes(startUrl.origin)) {
    throw new OpenwopError('validation_error', 'Field `startUrl` must be https and inside `allowedOrigins`.', 422, { field: 'startUrl' });
  }

  const requestHash = requestHashFor({ orgId: input.orgId, task, startUrl: startUrl.href, allowedOrigins });
  const sessionId = sessionIdFor(input.tenantId, requestHash);
  const now = new Date().toISOString();
  const claim = await claimSession({
    sessionId, tenantId: input.tenantId, orgId: input.orgId, requestHash,
    status: 'starting', task, startUrl: startUrl.href, allowedOrigins,
    ...(input.applyContext ? { applyContext: input.applyContext } : {}),
    steps: [], createdBy: input.createdBy, createdAt: now, updatedAt: now,
  });
  if (claim.outcome === 'exists') {
    // Replay/re-run: the recorded session is the truth — advance only if live.
    const s = claim.session;
    return s.status === 'running' || s.status === 'starting' ? advance(adapter, s) : view(s);
  }

  // Fresh claim: budget-gate BEFORE the provider spend; a budget denial
  // releases the claim (no tombstone — the exact inputs stay startable later).
  const session = claim.session;
  const releaseClaim = async (): Promise<void> => {
    // Pre-submit failure leaves NO tombstone (the creative-video CV-1 lesson):
    // the exact inputs stay startable once the cap resets / provider recovers.
    const { sessions } = await import('./sessionStore.js');
    await sessions.delete(`${session.tenantId}:${session.sessionId}`);
  };
  try {
    await chargeDailyBudget(input.tenantId);
  } catch (err) {
    await releaseClaim();
    throw err;
  }
  const started = await adapter.startSession({ task, startUrl: startUrl.href });
  if (!started.ok) {
    await refundDailyBudget(input.tenantId);
    await releaseClaim();
    return { sessionId: session.sessionId, status: 'failed', steps: 0, error: started.error };
  }
  const live: CuSession = { ...session, status: 'running', providerSessionId: started.value.providerSessionId };
  await putSession(live);
  return advance(adapter, live);
}

/** Drive the poll→tier→decide loop: auto-advance observe/interact (recording
 *  each step), HALT on commit-tier (awaiting_approval), enforce the origin
 *  allowlist + step ceilings. Bounded per call. */
export async function advance(adapter: ComputerUseAdapter, session: CuSession): Promise<SessionView> {
  let s = session;
  const psid = s.providerSessionId;
  if (!psid || (s.status !== 'running' && s.status !== 'starting')) return view(s);
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
    if (s.steps.length >= MAX_STEPS) {
      await adapter.abortSession(psid);
      s = { ...s, status: 'failed', error: 'step_ceiling_reached' };
      await putSession(s);
      return view(s);
    }
    const polled = await adapter.pollSession(psid);
    if (!polled.ok) return view(s); // transient — a re-invoke resumes
    const p = polled.value;
    if (p.status === 'completed') {
      s = { ...s, status: 'completed', ...(p.resultSummary ? { resultSummary: p.resultSummary } : {}) };
      const { pendingAction: _pa, ...rest } = s;
      await putSession(rest);
      return view(rest);
    }
    if (p.status === 'failed') {
      s = { ...s, status: 'failed', error: p.error ?? 'provider_failed' };
      await putSession(s);
      return view(s);
    }
    const action = p.pendingAction;
    if (!action) return view(s); // provider still thinking — yield
    if (!originAllowed(s, action)) {
      // Fail closed: deny the action AND end the session — an off-allowlist
      // navigation is never silently skipped.
      await adapter.submitDecision(psid, action.actionId, false);
      await adapter.abortSession(psid);
      log.warn('computer-use origin denied', { sessionId: s.sessionId, url: action.url });
      s = { ...s, status: 'failed', error: `origin_denied:${action.url ?? 'unknown'}` };
      await putSession(s);
      return view(s);
    }
    const tier = tierOf(action);
    if (tier === 'commit') {
      // ADR 0541 D2 — the gate CONSULTS an apply grant; it does not defer to one.
      //
      // Everything below is additive: with no `applyContext` (every caller that
      // is not a job-search campaign) `consultCommit` returns null and the halt
      // below is byte-for-byte the pre-0541 behaviour. The gate is never
      // weakened for anything else — that is the property, not a side effect.
      const granted = await consultCommit(s, action);
      if (granted) {
        const decided = await adapter.submitDecision(psid, action.actionId, true);
        if (!decided.ok) return view(s);
        const step: CuStep = { action, tier, decidedBy: 'grant', at: new Date().toISOString() };
        s = { ...s, steps: [...s.steps, step] };
        await putSession(s);
        continue;
      }
      s = { ...s, status: 'awaiting_approval', pendingAction: action };
      await putSession(s);
      return view(s);
    }
    // observe/interact — auto-approve, record the step.
    const decided = await adapter.submitDecision(psid, action.actionId, true);
    if (!decided.ok) return view(s); // stale/contended — a re-invoke re-polls
    const step: CuStep = { action, tier, decidedBy: 'auto', at: new Date().toISOString() };
    s = { ...s, steps: [...s.steps, step] };
    await putSession(s);
  }
  return view(s); // per-call budget spent — still running; re-invoke resumes
}

/** Record a human decision on the pending commit-tier action, then resume
 *  (approve) or end the session (deny). The chain composes this AFTER the
 *  approval-gate node — this function trusts its caller's recorded verdict. */
export async function decide(adapter: ComputerUseAdapter, tenantId: string, sessionId: string, approve: boolean): Promise<SessionView> {
  const s = await getSession(tenantId, sessionId);
  if (!s) throw new OpenwopError('not_found', 'Session not found.', 404, { sessionId });
  if (s.status !== 'awaiting_approval' || !s.pendingAction || !s.providerSessionId) {
    throw new OpenwopError('conflict', `Session is ${s.status} — nothing awaiting approval.`, 409, { sessionId, status: s.status });
  }
  const action = s.pendingAction;
  await adapter.submitDecision(s.providerSessionId, action.actionId, approve);
  if (!approve) {
    await adapter.abortSession(s.providerSessionId);
    const denied: CuSession = { ...s, status: 'denied', error: `denied:${action.actionId}` };
    const { pendingAction: _pa, ...rest } = denied;
    await putSession(rest);
    return view(rest);
  }
  const step: CuStep = { action, tier: 'commit', decidedBy: 'human', at: new Date().toISOString() };
  const resumed: CuSession = { ...s, status: 'running', steps: [...s.steps, step] };
  const { pendingAction: _pa, ...rest } = resumed;
  await putSession(rest);
  return advance(adapter, rest);
}

export async function sessionStatus(tenantId: string, sessionId: string): Promise<SessionView | null> {
  const s = await getSession(tenantId, sessionId);
  return s ? view(s) : null;
}

/**
 * ADR 0541 D2 — may a grant auto-approve this commit action?
 *
 * Returns false for EVERY reason a grant does not apply — absent, revoked,
 * expired, exhausted, out-of-scope, wrong class, wrong tier — because the caller
 * must not branch on which. All of them mean the same thing here: fall back to
 * per-action human approval.
 *
 * The order is load-bearing (D3): CLAIM the submission and CONSUME the budget
 * BEFORE returning true, so a crash mid-flight costs one unit and produces no
 * application, rather than a retry storm running past the ceiling.
 */
async function consultCommit(s: CuSession, action: CuAction): Promise<boolean> {
  const ctx = s.applyContext;
  if (!ctx) return false;

  const origin = originOf(action.url ?? '') ?? originOf(s.startUrl) ?? '';
  const decision = await consultApplyGrant({
    tenantId: s.tenantId,
    subjectId: ctx.subjectId,
    campaignId: ctx.campaignId,
    origin,
    // A driven form is a `submit`. Anything the adapter surfaces that is not a
    // submission (a purchase, a download) is refused on class by the grant.
    commitClass: commitClassOf(action),
    tier: ctx.tier,
    now: Date.now(),
    // ADR 0541 D4 — a replayed/forked session never spends budget. `computer-use`
    // reads the recorded trajectory on replay rather than re-driving, so this is
    // belt-and-braces; the grant refuses on its own account so the property does
    // not depend on the caller remembering.
    isReplay: s.applyContext?.isReplay === true,
  });
  if (!decision.allowed || !decision.grantId) return false;

  // Idempotency BEFORE budget (D3b): if this listing is already claimed, this is
  // a retry — refuse rather than spend a second unit and send a second
  // application. The claim key is the session's request hash, which is
  // deterministic over (org, task, startUrl, origins).
  const claimed = await claimSubmission(s.tenantId, ctx.subjectId, s.requestHash, decision.grantId);
  if (!claimed) return false;

  return consumeSubmit(s.tenantId, decision.grantId, Date.now());
}

function originOf(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Map an adapter action onto the grant's class vocabulary.
 *
 * Maps on the CLOSED `CuActionKind` enum rather than sniffing the description.
 * A first draft matched keywords in free text, which is the wrong shape here:
 * the description is provider-authored, so a purchase button labelled "Submit
 * application" would have been read as a submission. A closed vocabulary cannot
 * be talked into the wrong class.
 *
 * Only `submit` is grantable; everything else maps to a class the grant refuses.
 */
function commitClassOf(action: CuAction): CommitClass {
  switch (action.kind) {
    case 'submit': return 'submit';
    case 'download': return 'download';
    case 'navigate': return 'new-origin';
    case 'credential': return 'credential';
    // Any other kind reaching the commit tier is unrecognised HERE, and an
    // unrecognised commit is never granted.
    default: return 'purchase';
  }
}
