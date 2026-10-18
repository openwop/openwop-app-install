/**
 * ADR 0418 P1 — the computer-use control loop. The invariants (each is an
 * acceptance criterion from the ADR's §Decision):
 *  - SUBMIT-once: a requestHash CAS claim gates provider submission — a re-run/
 *    fork resolves the existing session, never re-drives a browser.
 *  - Risk-tiered HITL: observe/interact auto-advance (recorded); EVERY
 *    commit-tier action halts the session `awaiting_approval` — the decide
 *    node raises the run's own approval interrupt for that action (ADR 0894
 *    D3), never a new approval flow.
 *  - Fail-closed origin allowlist: a provider-reported URL outside the task's
 *    https allowlist DENIES the action and fails the session — no override.
 *  - Ceilings: per-session step cap + per-call poll budget (runaway backstop).
 *  - Budget: a feature-local KV daily session counter (the imagegen:budget
 *    precedent — mediaBudget-kind absorption deferred, recorded in the ADR).
 *
 * ADR 0894 adds the authority the run model gives an HTTP door for free: a
 * session belongs to the PERSON who opened it (D2), a commit proceeds only on
 * that person's resolution of the approval raised for that action (D3), every
 * advance rechecks the opener and the toggle (D4), private/internal origins and
 * credential entry are refused outright (D5/D6), and a wall-clock ceiling + a
 * stop button end what nobody is attending to (D8).
 */
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
// ADR 0541 — the grant is a HOST authority object, so the gate can consult it
// without importing a feature.
import { consultApplyGrant, consumeSubmit, claimSubmission, type CommitClass } from '../../host/applyGrant.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { assertRunOrgScope } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getToggleDefault } from '../../host/featureToggles/registry.js';
import { isDeniedWebhookHost } from '../../host/webhookEgressGuard.js';
import { configuredPublicBaseUrl } from '../featureRoute.js';
import { tierOf, type ComputerUseAdapter, type CuAction } from './adapter.js';
import { privateOriginOf } from './hostResolution.js';
import { createHash } from 'node:crypto';
import {
  claimSession, getSession, requestHashFor, sessionIdFor, writeSession,
  type CuSession, type CuStep,
} from './sessionStore.js';

const log = createLogger('computer-use');

/** Hard per-session step ceiling (recorded steps, all tiers). */
const MAX_STEPS = 40;
/** Auto-advanced steps per advance() call — the loop yields regularly so a
 *  single node invocation never pins a worker. */
const MAX_STEPS_PER_ADVANCE = 10;

/** ADR 0894 D8 — the wall-clock ceiling ADR 0418 §5 promised and never
 *  shipped. A session halted at a commit holds a billed provider session until
 *  someone answers; an hour bounds a forgotten approval. */
function maxSessionMs(): number {
  const raw = Number(process.env.OPENWOP_COMPUTER_USE_MAX_SESSION_MIN);
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 60_000;
}

/** Seconds the decide node waits between polls while the provider is still
 *  working (no action yet). */
export function pollWaitSeconds(): number {
  const raw = Number(process.env.OPENWOP_COMPUTER_USE_POLL_WAIT_SEC);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

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

/**
 * ADR 0894 D5 — hosts a browser agent may never be pointed at: the shared
 * egress predicate (loopback, RFC 1918, link-local + cloud metadata, CGNAT,
 * ULA, IPv4-mapped forms, `localhost`, `metadata.google.internal`), plus
 * internal-only NAMES (`*.internal`, `*.local`, `*.localhost`). A public name
 * that RESOLVES to a private address is the hosted provider's network, not
 * ours (ADR 0894 residue CU2-R1).
 */
export function isRefusedBrowserHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (isDeniedWebhookHost(h)) return true;
  return /(^|\.)(internal|local|localhost)$/.test(h);
}

/** The app's own public origin — the agent must never drive this app (it
 *  would act on the app with whatever session the browser holds). */
function ownOrigin(): string | null {
  const base = configuredPublicBaseUrl();
  if (!base) return null;
  try { return new URL(base).origin; } catch { return null; }
}

/** Parse + validate the fail-closed origin allowlist: non-empty, https, real
 *  PUBLIC hosts (ADR 0894 D5). Stored on the session at start; immutable
 *  afterwards. */
export function parseAllowedOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpenwopError('validation_error', 'Field `allowedOrigins` must be a non-empty array of https origins (fail-closed — an empty list would allow nothing).', 422, { field: 'allowedOrigins' });
  }
  const own = ownOrigin();
  return raw.map((v, i) => {
    if (typeof v !== 'string') throw new OpenwopError('validation_error', `allowedOrigins[${i}] must be a string.`, 422, { field: 'allowedOrigins' });
    let url: URL;
    try { url = new URL(v); } catch {
      throw new OpenwopError('validation_error', `allowedOrigins[${i}] is not a valid origin URL.`, 422, { field: 'allowedOrigins' });
    }
    if (url.protocol !== 'https:') throw new OpenwopError('validation_error', `allowedOrigins[${i}] must be https.`, 422, { field: 'allowedOrigins' });
    if (isRefusedBrowserHost(url.hostname)) {
      throw new OpenwopError('validation_error', `allowedOrigins[${i}] is a private or internal address and is not allowed.`, 422, { field: 'allowedOrigins' });
    }
    if (own && url.origin === own) {
      throw new OpenwopError('validation_error', `allowedOrigins[${i}] is this app's own origin and is not allowed.`, 422, { field: 'allowedOrigins' });
    }
    return url.origin;
  });
}

function originAllowed(session: CuSession, action: CuAction): boolean {
  if (!action.url) return true; // non-URL actions are constrained by tier, not origin
  try {
    const url = new URL(action.url);
    // The allowlist was screened at start, but a provider-reported URL is
    // checked on its own account too (D5): an allowlist can only ever grow
    // safer by being re-asked, never by being trusted.
    return session.allowedOrigins.includes(url.origin) && !isRefusedBrowserHost(url.hostname);
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
  /** The run that opens the session (ADR 0894 CU2UX-2) — its end ends the session. */
  runId?: string;
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

/** The longest provider note the approval card shows. */
export const NOTE_SHOWN_MAX = 280;

/** ADR 0894 addendum 2 — exactly what the approval card shows for an action:
 *  the closed kind, the full target URL, its site, and the provider's note as
 *  truncated for display. The decide node copies these fields VERBATIM into the
 *  approval it raises, so the card renders this and nothing else. */
export interface ShownAction { kind: string; url: string; origin: string; note: string }

export function shownAction(action: CuAction, startUrl: string): ShownAction {
  const originOf = (u: string): string => { try { return new URL(u).origin; } catch { return ''; } };
  const url = action.url ?? '';
  return {
    kind: action.kind,
    url,
    origin: originOf(url) || originOf(startUrl),
    note: typeof action.description === 'string' ? action.description.slice(0, NOTE_SHOWN_MAX) : '',
  };
}

/**
 * ADR 0894 addendum G-A, corrected by addendum 2 — the digest an approval binds
 * is of EXACTLY what the approver saw: kind, full URL, and the note as shown
 * (not the hidden tail of a long description). The action id is chosen by the
 * provider, so an approval keyed on the id alone would ride a different action
 * re-issued under the same id; one keyed on more than was shown would claim the
 * human approved text they never read.
 */
export function shownDigest(shown: Pick<ShownAction, 'kind' | 'url' | 'note'>): string {
  return createHash('sha256').update(JSON.stringify([shown.kind, shown.url, shown.note])).digest('hex');
}

export function actionDigest(action: CuAction, startUrl = ''): string {
  return shownDigest(shownAction(action, startUrl));
}

export interface SessionView {
  sessionId: string;
  status: CuSession['status'];
  steps: number;
  pendingAction?: CuAction;
  /** Addendum 2 — what the approval card shows for the pending action. */
  pendingShown?: ShownAction;
  /** G-A — the digest of `pendingShown`; the decide node keys its approval on it. */
  pendingDigest?: string;
  resultSummary?: string;
  error?: string;
  /** Polls that found the provider still working; the decide node keys its
   *  wait on it (CU2CD-1). */
  idleRounds: number;
}

const view = (s: CuSession): SessionView => ({
  sessionId: s.sessionId,
  status: s.status,
  steps: s.steps.length,
  idleRounds: s.idleRounds ?? 0,
  ...(s.pendingAction ? { pendingAction: s.pendingAction, pendingShown: shownAction(s.pendingAction, s.startUrl), pendingDigest: actionDigest(s.pendingAction, s.startUrl) } : {}),
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

  // ADR 0894 D1 — a person, in an org. The surface asks `runs:create` there
  // before reaching this; these are the service's own floor for any other caller.
  if (!input.createdBy) throw new OpenwopError('forbidden', 'A browser session needs a person behind it.', 403, {});
  if (!input.orgId) throw new OpenwopError('validation_error', 'Field `orgId` is required.', 422, { field: 'orgId' });
  // ADR 0894 addendum G-C — the names must not RESOLVE private either.
  const privateOrigin = await privateOriginOf(allowedOrigins);
  if (privateOrigin) {
    throw new OpenwopError('validation_error', `${privateOrigin} resolves to a private or internal address and is not allowed.`, 422, { field: 'allowedOrigins' });
  }

  const requestHash = requestHashFor({
    orgId: input.orgId, task, startUrl: startUrl.href, allowedOrigins, createdBy: input.createdBy,
    ...(input.applyContext ? { applyContext: input.applyContext } : {}),
  });
  const sessionId = sessionIdFor(input.tenantId, requestHash);
  const now = new Date().toISOString();
  const claim = await claimSession({
    sessionId, tenantId: input.tenantId, orgId: input.orgId, requestHash,
    status: 'starting', task, startUrl: startUrl.href, allowedOrigins,
    ...(input.applyContext ? { applyContext: input.applyContext } : {}),
    steps: [], createdBy: input.createdBy, ...(input.runId ? { runId: input.runId } : {}), createdAt: now, updatedAt: now,
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
    return { sessionId: session.sessionId, status: 'failed', steps: 0, idleRounds: 0, error: started.error };
  }
  const live = await writeSession(session, { ...session, status: 'running', providerSessionId: started.value.providerSessionId });
  if (!live) {
    // Ended (stopped, revoked) between the claim and the provider start.
    await adapter.abortSession(started.value.providerSessionId);
    const stored = await getSession(session.tenantId, session.sessionId);
    return view(stored ?? session);
  }
  return advance(adapter, live);
}

/** Drive the poll→tier→decide loop: auto-advance observe/interact (recording
 *  each step), HALT on commit-tier (awaiting_approval), enforce the origin
 *  allowlist + step ceilings. Bounded per call.
 *
 *  Every write is a compare-and-swap on the session's revision (CU2CD-3): if
 *  another writer moved the row — a stop, a membership-loss hook, a concurrent
 *  advance — this call stops and reports what is stored, never overwrites it. */
export async function advance(adapter: ComputerUseAdapter, session: CuSession): Promise<SessionView> {
  let s = session;
  const psid = s.providerSessionId;
  if (!psid || (s.status !== 'running' && s.status !== 'starting')) return view(s);
  // ADR 0894 D4/D8 — every advance re-asks before it drives anything.
  const lapsed = await authorityLapse(s);
  if (lapsed) return view(await endSession(adapter, s, lapsed));
  // ADR 0894 addendum G-C — a name that starts resolving private mid-session
  // (DNS rebinding) ends it before the browser is driven any further.
  if (await privateOriginOf(s.allowedOrigins)) return view(await endSession(adapter, s, 'origin_resolves_private'));
  /** Write `next`; on a lost race return the stored row's view instead. */
  const save = async (next: CuSession): Promise<SessionView | null> => {
    const written = await writeSession(s, next);
    if (written) { s = written; return null; }
    const stored = await getSession(s.tenantId, s.sessionId);
    return view(stored ?? s);
  };
  const finish = async (next: CuSession): Promise<SessionView> => {
    const { pendingAction: _pa, ...rest } = next;
    return (await save(next.status === 'awaiting_approval' ? next : rest)) ?? view(s);
  };
  let progressed = false;
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i += 1) {
    if (s.steps.length >= MAX_STEPS) {
      await adapter.abortSession(psid);
      return finish({ ...s, status: 'failed', error: 'step_ceiling_reached' });
    }
    const polled = await adapter.pollSession(psid);
    if (!polled.ok) return view(s); // transient — a re-invoke resumes
    const p = polled.value;
    if (p.status === 'completed') {
      return finish({ ...s, status: 'completed', ...(p.resultSummary ? { resultSummary: p.resultSummary } : {}) });
    }
    if (p.status === 'failed') {
      return finish({ ...s, status: 'failed', error: p.error ?? 'provider_failed' });
    }
    const action = p.pendingAction;
    if (!action) {
      // Provider still thinking — yield. Count the idle round so the decide
      // node's wait has a fresh durable key (CU2CD-1).
      if (progressed) return view(s);
      return (await save({ ...s, status: 'running', idleRounds: (s.idleRounds ?? 0) + 1 })) ?? view(s);
    }
    if (!originAllowed(s, action)) {
      // Fail closed: deny the action AND end the session — an off-allowlist
      // navigation is never silently skipped.
      await adapter.submitDecision(psid, action.actionId, false);
      await adapter.abortSession(psid);
      log.warn('computer-use origin denied', { sessionId: s.sessionId, url: action.url });
      return finish({ ...s, status: 'failed', error: `origin_denied:${action.url ?? 'unknown'}` });
    }
    if (action.kind === 'credential') {
      // ADR 0894 D6 — never offered for approval. Credentials enter only through
      // a broker the model never sees (ADR 0418 §2), and no broker exists; a
      // human approving "type the password" would be approving the provider
      // obtaining it some other way.
      await adapter.submitDecision(psid, action.actionId, false);
      await adapter.abortSession(psid);
      return finish({ ...s, status: 'failed', error: 'credential_entry_unsupported' });
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
        const lost = await save({ ...s, steps: [...s.steps, step] });
        if (lost) return lost;
        progressed = true;
        continue;
      }
      return finish({ ...s, status: 'awaiting_approval', pendingAction: action });
    }
    // observe/interact — auto-approve, record the step.
    const decided = await adapter.submitDecision(psid, action.actionId, true);
    if (!decided.ok) return view(s); // stale/contended — a re-invoke re-polls
    const step: CuStep = { action, tier, decidedBy: 'auto', at: new Date().toISOString() };
    const lost = await save({ ...s, steps: [...s.steps, step] });
    if (lost) return lost;
    progressed = true;
  }
  return view(s); // per-call budget spent — still running; re-invoke resumes
}

export interface DecideInput {
  tenantId: string;
  sessionId: string;
  approve: boolean;
  /** The run's person (`scope.actingUserId`). Must be the opener (D2). */
  actor: string;
  /** D3 — the approval interrupt whose recorded resolution authorises an
   *  approve. The SURFACE verifies it against the run record before passing it
   *  (`approvalBinding.ts`); this function enforces the one-use rule. */
  approvalInterruptId?: string;
}

const openerOnly = (s: CuSession, actor: string): void => {
  if (!actor || actor !== s.createdBy) {
    throw new OpenwopError('forbidden', 'Only the person who started this browser session can decide its actions.', 403, { sessionId: s.sessionId });
  }
};

/** Record the opener's decision on the pending commit-tier action, then resume
 *  (approve) or end the session (deny). Deny needs nothing but the opener: the
 *  safe direction is always available.
 *
 *  An approve CLAIMS before it acts (CU2CD-4): the CAS that marks the approval
 *  consumed and the session running lands first, and only its winner tells the
 *  provider. Two concurrent decides on one approval cannot both submit. */
export async function decide(adapter: ComputerUseAdapter, input: DecideInput): Promise<SessionView> {
  const s = await getSession(input.tenantId, input.sessionId);
  if (!s) throw new OpenwopError('not_found', 'Session not found.', 404, { sessionId: input.sessionId });
  openerOnly(s, input.actor);
  if (s.status !== 'awaiting_approval' || !s.pendingAction || !s.providerSessionId) {
    throw new OpenwopError('conflict', `Session is ${s.status} — nothing awaiting approval.`, 409, { sessionId: s.sessionId, status: s.status });
  }
  const lapsed = await authorityLapse(s);
  if (lapsed) return view(await endSession(adapter, s, lapsed));
  const action = s.pendingAction;
  const psid = s.providerSessionId;
  const lostRace = (): never => {
    throw new OpenwopError('conflict', 'This session changed while the decision was being recorded.', 409, { sessionId: s.sessionId });
  };
  if (!input.approve) {
    const { pendingAction: _pa, ...rest } = s;
    const denied = await writeSession(s, { ...rest, status: 'denied', error: `denied:${action.actionId}` });
    if (!denied) return lostRace();
    await adapter.submitDecision(psid, action.actionId, false);
    await adapter.abortSession(psid);
    return view(denied);
  }
  const interruptId = input.approvalInterruptId;
  if (!interruptId || (s.consumedApprovals ?? []).includes(interruptId)) {
    throw new OpenwopError('approval_required', 'This action needs your approval in the run before the browser agent may take it.', 409, { sessionId: s.sessionId });
  }
  const step: CuStep = { action, tier: 'commit', decidedBy: 'human', approvalInterruptId: interruptId, at: new Date().toISOString() };
  const { pendingAction: _pa, ...rest } = s;
  const claimed = await writeSession(s, { ...rest, status: 'running', steps: [...s.steps, step], consumedApprovals: [...(s.consumedApprovals ?? []), interruptId] });
  if (!claimed) return lostRace();
  const decided = await adapter.submitDecision(psid, action.actionId, true);
  if (!decided.ok) {
    // The provider no longer offers this action (it moved on, or the session
    // died). The approval is spent either way; the next poll reports reality.
    log.warn('computer-use approve not accepted by the provider', { sessionId: s.sessionId, error: decided.error });
  }
  return advance(adapter, claimed);
}

/** Resume a `running` session one advance further (the decide node's poll
 *  while the provider is still working, CU2CD-1). Opener-only, like decide. */
export async function resumeSession(adapter: ComputerUseAdapter, input: { tenantId: string; sessionId: string; actor: string }): Promise<SessionView> {
  const s = await getSession(input.tenantId, input.sessionId);
  if (!s) throw new OpenwopError('not_found', 'Session not found.', 404, { sessionId: input.sessionId });
  openerOnly(s, input.actor);
  return advance(adapter, s);
}

/** The terminal statuses — a session in one of these drives nothing. */
export const isLive = (s: CuSession): boolean => s.status === 'starting' || s.status === 'running' || s.status === 'awaiting_approval';

/**
 * ADR 0894 D4/D8 — the reason a live session may no longer proceed, or null.
 * The opener is re-asked with the SAME run-lane predicate D1 starts with
 * (`assertRunOrgScope`, which knows a personal workspace's implicit owner — a
 * raw access read would abort every personal-workspace session, ADR 0894 A3).
 * Only a refusal ends the session; a storage error is rethrown, never read as
 * "revoked".
 */
export async function authorityLapse(s: CuSession): Promise<'wall_clock_ceiling' | 'feature_disabled' | 'opener_revoked' | null> {
  if (Date.now() - Date.parse(s.createdAt) > maxSessionMs()) return 'wall_clock_ceiling';
  // The seam's own rule (`featureSurfaces.ts` gate): a feature with no
  // registered toggle has no toggle to be off.
  if (getToggleDefault('computer-use')) {
    const toggle = await resolveOne('computer-use', { tenantId: s.tenantId, ...(s.createdBy ? { userId: s.createdBy } : {}) });
    if (!toggle || !toggle.enabled) return 'feature_disabled';
  }
  try {
    await assertRunOrgScope(s.tenantId, s.createdBy, s.orgId, 'runs:create');
  } catch (err) {
    if (err instanceof OpenwopError && (err.httpStatus === 403 || err.httpStatus === 404)) return 'opener_revoked';
    throw err;
  }
  return null;
}

/**
 * End a live session `aborted` (ADR 0894 D4/D8). The ROW always ends, even when
 * the provider cannot be reached or none is configured (A5): a session must
 * never stay live because its provider is gone.
 */
export async function endSession(adapter: ComputerUseAdapter | null, s: CuSession, reason: string): Promise<CuSession> {
  // CAS loop: the end must win against an in-flight advance, never be
  // overwritten by it (CU2CD-3). A row that is already terminal stays as is.
  let current: CuSession | null = s;
  for (let attempt = 0; attempt < 8 && current; attempt += 1) {
    if (!isLive(current)) return current;
    const { pendingAction: _pa, ...rest } = current;
    const ended = await writeSession(current, { ...rest, status: 'aborted', error: reason });
    if (ended) {
      if (ended.providerSessionId && adapter) {
        try { await adapter.abortSession(ended.providerSessionId); } catch (err) {
          log.warn('computer-use abort failed at the provider', { sessionId: ended.sessionId, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // `endReason`, not `reason`: the logger treats a `reason` field as PII and
      // hashes it, which hid why sessions ended (CU2CD-7).
      log.info('computer-use session ended', { sessionId: ended.sessionId, endReason: reason });
      return ended;
    }
    current = await getSession(s.tenantId, s.sessionId);
  }
  return current ?? s;
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
    // ADR 0894 D7 — the grant authorises its GRANTOR, in its org. `applyContext`
    // is node input, so without these two a peer's run carrying someone else's
    // context spent their grant.
    orgId: s.orgId,
    grantedBy: s.createdBy,
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
  // deterministic over (org, task, startUrl, origins, opener, apply context).
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
