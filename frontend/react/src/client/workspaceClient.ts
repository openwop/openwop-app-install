/**
 * Workspace tenancy client (ADR 0015). Proposed auth/caller integration2489,
 * based on the frozen2463 foundation. Metadata guards this loaded realm only;
 * it is not identity authority or a remote-settlement barrier. The synchronous
 * completion path ends at current invocation, not later callback effects.
 * Settled UID/chat integration and native exact-tree proof remain required.
 */
import { authedHeaders, config, fetchOpts, onAuthChange, fireAuthChanged, getCurrentAuthChangeEvent, AuthChangeDispatchError, type AuthChangeEvent } from './config.js';
import { rememberWireTenant } from './v2Wire.js';
import { ApiError } from './requestJson.js';

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  slug: string;
  roles: string[];
  kind: 'personal' | 'shared';
  active: boolean;
  /** ADR 0975 D12 — default agent of a feature-declared workspace. */
  chatAgent?: string;
}

export interface MyWorkspaces {
  workspaces: WorkspaceSummary[];
  active: string;
  personal: string;
  /** ADR 1158 — present when a shared workspace is active: send it as
   *  {@link WORKSPACE_SELECTION_HEADER} on a request that goes straight to the
   *  backend host, where this origin's session cookie does not travel. */
  selectionToken?: string;
}

/** ADR 1158 — the header a direct-to-host request carries the active workspace on. */
export const WORKSPACE_SELECTION_HEADER = 'x-openwop-workspace-selection';

const authBrand: unique symbol = Symbol('workspace-auth-revision');
const revisionBrand: unique symbol = Symbol('workspace-proof-revision');
const proofBrand: unique symbol = Symbol('workspace-read-proof');
export type AuthRevision = Readonly<{ [authBrand]: true }>;
export type ProofRevision = Readonly<{ [revisionBrand]: true }>;
export type WorkspacePhase = 'unverified' | 'pending' | 'ready' | 'failed' | 'uncertain';
export type AcceptedWorkspace = Readonly<Omit<WorkspaceSummary, 'roles'> & { roles: readonly string[] }>;
export type AcceptedWorkspaces = Readonly<{
  active: string;
  personal: string;
  workspaces: readonly AcceptedWorkspace[];
}>;
export interface WorkspaceTransitionSnapshot {
  readonly authRevision: AuthRevision;
  readonly revision: ProofRevision;
  readonly phase: WorkspacePhase;
  readonly pendingCount: number;
}
export interface WorkspaceReadProof {
  readonly [proofBrand]: true;
  readonly result: AcceptedWorkspaces;
}

type LifecycleCode = 'workspace_transition_retired' | 'workspace_transition_overlap' | 'workspace_transition_uncertain';
export class WorkspaceLifecycleError extends Error {
  readonly code: LifecycleCode;
  readonly creationMayHaveCompleted: boolean;
  constructor(code: LifecycleCode, creationMayHaveCompleted = false) {
    super(code);
    this.name = 'WorkspaceLifecycleError';
    this.code = code;
    this.creationMayHaveCompleted = creationMayHaveCompleted;
  }
}

type AttemptHandle = Readonly<object>;
interface Attempt {
  readonly handle: AttemptHandle;
  readonly auth: AuthRevision;
  readonly configEvent: AuthChangeEvent;
  stage: 'create' | 'switch';
  retired: boolean;
  settled: boolean;
  uncertain: boolean;
  requestDispatched: boolean;
  requestSettled: boolean;
  creationMayHaveCompleted: boolean;
}
interface ReadScope {
  readonly configEvent: AuthChangeEvent;
  readonly auth: AuthRevision;
  readonly revision: ProofRevision;
  readonly eligible: boolean;
}
interface AcceptedReadTarget {
  readonly scope: ReadScope;
  readonly active: string;
  readonly epoch: Readonly<object>;
  readonly previousEpoch: Readonly<object> | null;
  readonly latestOrder: number;
  readonly conflictingOrder: number;
}
interface Acceptance {
  readonly configEvent: AuthChangeEvent;
  readonly auth: AuthRevision;
  readonly revision: ProofRevision;
  readonly targetEpoch: Readonly<object>;
  readonly canonical: AcceptedWorkspaces;
}

export type WorkspaceMutationResult = WorkspaceSummary | { ok: boolean; active: string };
export type CompletionOutcome = 'completed' | 'retired' | 'caller-retired' | 'failed';
export interface CompletionFailure {
  readonly phase: 'notification' | 'before-action' | 'action';
  readonly listenerFailureCount: number;
  readonly mutationMayHaveCompleted: true;
  readonly actionMayHaveRun: boolean;
}
export interface CompletionActions {
  isCallerCurrent(): boolean;
  beforeAction?(): void;
  action(): void;
  failed(failure: CompletionFailure): void;
}
interface CompletionRecord {
  readonly attempt: Attempt;
  readonly target: string;
  readonly auth: AuthRevision;
  readonly revision: ProofRevision;
  readonly configEvent: AuthChangeEvent;
  state: 'eligible' | 'consuming' | 'consumed';
  retired: boolean;
}
interface UICompletion {
  readonly source: CompletionRecord;
  expectedEvent: AuthChangeEvent | null;
  observedOwnEvent: boolean;
  postAuth: AuthRevision | null;
  postRevision: ProofRevision | null;
  retired: boolean;
}

const newAuth = (): AuthRevision => Object.freeze({ [authBrand]: true as const });
const newRevision = (): ProofRevision => Object.freeze({ [revisionBrand]: true as const });
let authRevision = newAuth();
let proofRevision = newRevision();
let observedConfigEvent = getCurrentAuthChangeEvent();
let restingPhase: 'unverified' | 'ready' | 'failed' = 'unverified';
const attempts = new Map<AttemptHandle, Attempt>();
let latestAttempt: Attempt | null = null;
const acceptances = new WeakMap<WorkspaceReadProof, Acceptance>();
let nextReadOrder = 0;
let acceptedReadTarget: AcceptedReadTarget | null = null;
const listeners = new Set<() => void>();
const completions = new WeakMap<object, CompletionRecord>();
let latestCompletion: CompletionRecord | null = null;
let activeUICompletion: UICompletion | null = null;
let snapshot: WorkspaceTransitionSnapshot = Object.freeze({
  authRevision, revision: proofRevision, phase: 'unverified', pendingCount: 0,
});

function pendingCount(): number {
  let count = 0;
  for (const attempt of attempts.values()) if (!attempt.settled) count += 1;
  return count;
}
function hasUncertainty(): boolean {
  for (const attempt of attempts.values()) if (attempt.uncertain) return true;
  return false;
}
function publish(targetChanged = false): void {
  const pending = pendingCount();
  const phase: WorkspacePhase = hasUncertainty() ? 'uncertain' : pending ? 'pending' : restingPhase;
  if (!targetChanged && snapshot.authRevision === authRevision && snapshot.revision === proofRevision
    && snapshot.phase === phase && snapshot.pendingCount === pending) return;
  snapshot = Object.freeze({ authRevision, revision: proofRevision, phase, pendingCount: pending });
  // This isolates OUR subscribers, not config's existing auth fan-out.
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch { /* observer failure cannot bypass the fence */ }
  }
}
export function getWorkspaceTransitionSnapshot(): WorkspaceTransitionSnapshot { return snapshot; }
export function subscribeWorkspaceTransition(changed: () => void): () => void {
  listeners.add(changed);
  return () => { listeners.delete(changed); };
}

// Module lifetime is the continuously loaded realm. A new realm loses all
// outstanding/uncertain knowledge; a later GET cannot prove remote settlement.
onAuthChange((event) => {
  const ui = activeUICompletion;
  if (ui && (ui.expectedEvent !== event || getCurrentAuthChangeEvent() !== event)) ui.retired = true;
  // A late outer event is delivered but cannot install old state over nested F.
  if (getCurrentAuthChangeEvent() !== event) return;
  observedConfigEvent = event;
  authRevision = newAuth();
  proofRevision = newRevision();
  restingPhase = 'unverified';
  for (const attempt of attempts.values()) attempt.retired = true;
  if (latestAttempt) latestAttempt.retired = true;
  if (latestCompletion) latestCompletion.retired = true;
  // All ordinary scopes above retire, even for our expected normal broadcast.
  // Only this newly minted UI context can retain the fresh post-event fence.
  if (ui && !ui.retired && ui.expectedEvent === event) {
    ui.observedOwnEvent = true;
    ui.postAuth = authRevision;
    ui.postRevision = proofRevision;
  }
  publish();
});

function retireCompletionIntent(): void {
  if (latestCompletion) latestCompletion.retired = true;
  if (activeUICompletion) activeUICompletion.retired = true;
}
function retireCompletionForTarget(active: string): void {
  if (latestCompletion && latestCompletion.target !== active) latestCompletion.retired = true;
  if (activeUICompletion && activeUICompletion.source.target !== active) activeUICompletion.retired = true;
}

function lifecycle(attempt?: Attempt, overlap = false): WorkspaceLifecycleError {
  const code = hasUncertainty() ? 'workspace_transition_uncertain'
    : overlap ? 'workspace_transition_overlap' : 'workspace_transition_retired';
  return new WorkspaceLifecycleError(code, attempt?.creationMayHaveCompleted ?? false);
}
function isCurrentAttempt(attempt: Attempt): boolean {
  return latestAttempt === attempt && attempt.auth === authRevision && !attempt.retired
    && attempt.configEvent === getCurrentAuthChangeEvent() && observedConfigEvent === attempt.configEvent;
}
function assertAttempt(attempt: Attempt): void {
  if (!isCurrentAttempt(attempt) || attempts.get(attempt.handle) !== attempt || attempt.settled || hasUncertainty()) {
    throw lifecycle(attempt);
  }
}
function beginAttempt(stage: Attempt['stage']): Attempt {
  // New intent retires completion even if admission/preparation then refuses.
  retireCompletionIntent();
  if (observedConfigEvent !== getCurrentAuthChangeEvent()) throw lifecycle();
  if (hasUncertainty()) throw lifecycle();
  if (latestAttempt) latestAttempt.retired = true;
  const attempt: Attempt = {
    handle: Object.freeze({}), auth: authRevision, configEvent: observedConfigEvent, stage, retired: false,
    settled: false, uncertain: false, requestDispatched: false,
    requestSettled: false, creationMayHaveCompleted: false,
  };
  latestAttempt = attempt;
  attempts.set(attempt.handle, attempt);
  proofRevision = newRevision();
  restingPhase = 'unverified';
  publish(); // A subscriber can supersede this attempt before its first fetch.
  return attempt;
}
function settleOwn(attempt: Attempt, uncertain: boolean): void {
  if (attempts.get(attempt.handle) !== attempt || attempt.settled) return;
  attempt.settled = true;
  attempt.uncertain = uncertain;
  // Unknown remote outcomes remain in this realm; no force-clear endpoint.
  if (!uncertain) attempts.delete(attempt.handle);
}
function rejectAttempt(attempt: Attempt, error: unknown): never {
  const wasCurrent = isCurrentAttempt(attempt);
  const uncertain = attempt.requestDispatched && !attempt.requestSettled;
  settleOwn(attempt, uncertain);
  if (wasCurrent && !(error instanceof WorkspaceLifecycleError)) {
    proofRevision = newRevision();
    restingPhase = 'failed';
  }
  publish();
  if (hasUncertainty()) throw lifecycle(attempt);
  if (!wasCurrent || !isCurrentAttempt(attempt)) throw lifecycle(attempt);
  throw error;
}
function finishAttempt<T extends object>(attempt: Attempt, active: string, result: T): T {
  assertAttempt(attempt);
  const anotherClaim = Array.from(attempts.values()).some((other) => other !== attempt);
  settleOwn(attempt, false);
  restingPhase = 'unverified';
  publish();
  if (anotherClaim || !isCurrentAttempt(attempt) || pendingCount() || hasUncertainty()) {
    throw lifecycle(attempt, anotherClaim);
  }
  rememberWireTenant(active);
  if (!isCurrentAttempt(attempt) || pendingCount() || hasUncertainty()) throw lifecycle(attempt);
  // Issue a fresh object per success: reusing a transport object cannot rebind
  // an older caller's alias to a newer completion. Public fields stay mutable.
  const issued = { ...result };
  const completion: CompletionRecord = {
    attempt, target: active, auth: authRevision, revision: proofRevision,
    configEvent: observedConfigEvent, state: 'eligible', retired: false,
  };
  completions.set(issued, completion);
  latestCompletion = completion;
  return issued;
}

function captureRead(): ReadScope {
  const configEvent = getCurrentAuthChangeEvent();
  return { auth: authRevision, revision: proofRevision, configEvent,
    eligible: pendingCount() === 0 && !hasUncertainty() && observedConfigEvent === configEvent };
}
function currentRead(scope: ReadScope): boolean {
  return scope.eligible && scope.auth === authRevision && scope.revision === proofRevision
    && scope.configEvent === getCurrentAuthChangeEvent() && observedConfigEvent === scope.configEvent
    && pendingCount() === 0 && !hasUncertainty();
}
function assertRead(scope: ReadScope): void { if (!currentRead(scope)) throw lifecycle(); }
function targetForRead(scope: ReadScope): AcceptedReadTarget | null {
  const target = acceptedReadTarget;
  return target && target.scope.auth === scope.auth && target.scope.revision === scope.revision
    && target.scope.configEvent === scope.configEvent ? target : null;
}
function acceptReadTarget(
  scope: ReadScope, captured: AcceptedReadTarget | null, order: number, active: string,
): AcceptedReadTarget | null {
  const previous = targetForRead(scope);
  // Captured observed-target authority is not renewed by a later invocation
  // order. Only the immediate successor can coalesce a compatible result.
  if (captured && previous?.epoch !== captured.epoch) {
    if (!previous || previous.previousEpoch !== captured.epoch || previous.active !== active) return null;
  }
  // A newer accepted contradiction permanently fences an older request. Keep
  // both watermarks: A -> B -> A must not revive a held read from the first A.
  // Same-target concurrent reads can finish in either order, even after a flip.
  if (previous && order < (previous.active === active ? previous.conflictingOrder : previous.latestOrder)) return null;
  const changed = previous !== null && previous.active !== active;
  const target: AcceptedReadTarget = Object.freeze({
    scope, active, epoch: previous && !changed ? previous.epoch : Object.freeze({}),
    previousEpoch: changed ? previous.epoch : previous?.previousEpoch ?? null,
    latestOrder: Math.max(order, previous?.latestOrder ?? 0),
    conflictingOrder: changed ? previous.latestOrder : previous?.conflictingOrder ?? 0,
  });
  acceptedReadTarget = target;
  return target;
}

const base = `${config.baseUrl}/host/openwop-app`;
const headers = (): Record<string, string> => authedHeaders();
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch { /* non-JSON error body */ }
    throw new ApiError({ status: res.status, statusText: res.statusText, url: res.url, message: detail || `${ctx} returned ${res.status}` });
  }
  return (await res.json()) as T;
}

async function readWorkspaces<T>(check: () => void = () => {}): Promise<T> {
  check();
  const options = fetchOpts({ headers: headers() });
  check(); // header preparation can synchronously refresh authentication
  const res = await fetch(`${base}/me/workspaces`, options);
  check();
  const out = await asJson<T>(res, 'listMyWorkspaces');
  check();
  return out;
}
async function mutationRequest<T>(
  url: string, prepare: () => RequestInit, ctx: string, attempt?: Attempt,
): Promise<T> {
  if (attempt) {
    assertAttempt(attempt);
    attempt.requestDispatched = false;
    attempt.requestSettled = false;
  }
  const options = prepare();
  if (attempt) {
    assertAttempt(attempt); // final check AFTER preparation, directly before fetch
    attempt.requestDispatched = true;
    if (attempt.stage === 'create') attempt.creationMayHaveCompleted = true;
  }
  const res = await fetch(url, options);
  // Inspect currentness immediately. A stale body may be drained solely to
  // settle this exact HTTP claim; it cannot advance, warm, or be accepted.
  const currentAfterHeaders = !attempt || isCurrentAttempt(attempt);
  let out: T;
  try { out = await asJson<T>(res, ctx); }
  finally { if (attempt) attempt.requestSettled = true; }
  if (attempt) {
    if (!currentAfterHeaders) throw lifecycle(attempt);
    assertAttempt(attempt);
  }
  return out;
}

/** Legacy list payload remains mutable; it is never itself an issued proof. */
export async function listMyWorkspaces(options: { rememberTenant?: boolean } = {}): Promise<MyWorkspaces> {
  const scope = captureRead();
  const out = await readWorkspaces<MyWorkspaces>();
  if (options.rememberTenant !== false && currentRead(scope)) rememberWireTenant(out.active);
  return out;
}
function createRequest(input: { name: string; description?: string }, attempt?: Attempt): Promise<WorkspaceSummary> {
  return mutationRequest(`${base}/workspaces`, () => fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input),
  }), 'createWorkspace', attempt);
}
/** Create alone does not enter; retain its existing public behavior. */
export function createWorkspace(input: { name: string; description?: string }): Promise<WorkspaceSummary> {
  return createRequest(input);
}
function switchRequest(workspaceId: string, attempt: Attempt): Promise<{ ok: boolean; active: string }> {
  return mutationRequest(`${base}/workspaces/${encodeURIComponent(workspaceId)}/switch`,
    () => fetchOpts({ method: 'POST', headers: jsonHeaders() }), 'switchWorkspace', attempt);
}
function validSwitch(out: { ok: boolean; active: string }, workspaceId: string): void {
  if (!out || out.ok !== true || out.active !== workspaceId) throw new Error('workspace_switch_response_invalid');
}
export async function switchWorkspace(workspaceId: string): Promise<{ ok: boolean; active: string }> {
  const attempt = beginAttempt('switch');
  try {
    const out = await switchRequest(workspaceId, attempt);
    assertAttempt(attempt);
    validSwitch(out, workspaceId);
    return finishAttempt(attempt, out.active, out);
  } catch (error) { return rejectAttempt(attempt, error); }
}
/** One invocation/claim starts before the first create fetch, not at switch. */
export async function createAndEnterWorkspace(name: string): Promise<WorkspaceSummary> {
  const attempt = beginAttempt('create');
  try {
    const workspace = await createRequest({ name }, attempt);
    assertAttempt(attempt);
    if (!workspace || typeof workspace.workspaceId !== 'string' || !workspace.workspaceId) {
      throw new Error('workspace_create_response_invalid');
    }
    attempt.stage = 'switch';
    const entered = await switchRequest(workspace.workspaceId, attempt);
    assertAttempt(attempt);
    validSwitch(entered, workspace.workspaceId);
    return finishAttempt(attempt, entered.active, workspace);
  } catch (error) { return rejectAttempt(attempt, error); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalidWorkspaceRead(): never { throw new Error('workspace_read_response_invalid'); }
function normalizeWorkspaces(value: unknown): AcceptedWorkspaces {
  if (!isRecord(value) || typeof value.active !== 'string' || !value.active
    || typeof value.personal !== 'string' || !value.personal || !Array.isArray(value.workspaces)) {
    return invalidWorkspaceRead();
  }
  const active = value.active;
  const ids = new Set<string>();
  const workspaces: AcceptedWorkspace[] = value.workspaces.map((row: unknown) => {
    if (!isRecord(row) || typeof row.workspaceId !== 'string' || !row.workspaceId
      || ids.has(row.workspaceId) || typeof row.name !== 'string' || typeof row.slug !== 'string'
      || !Array.isArray(row.roles) || !row.roles.every((role: unknown) => typeof role === 'string')
      || (row.kind !== 'personal' && row.kind !== 'shared') || typeof row.active !== 'boolean'
      || row.active !== (row.workspaceId === active)
      || (row.chatAgent !== undefined && typeof row.chatAgent !== 'string')) return invalidWorkspaceRead();
    ids.add(row.workspaceId);
    const roles: string[] = row.roles.map((role: unknown) => {
      if (typeof role !== 'string') return invalidWorkspaceRead();
      return role;
    });
    const accepted: AcceptedWorkspace = Object.freeze({
      workspaceId: row.workspaceId, name: row.name, slug: row.slug,
      roles: Object.freeze(roles), kind: row.kind, active: row.active,
      ...(row.chatAgent === undefined ? {} : { chatAgent: row.chatAgent }),
    });
    return accepted;
  });
  if (!ids.has(active)) return invalidWorkspaceRead();
  return Object.freeze({ active, personal: value.personal, workspaces: Object.freeze(workspaces) });
}
/** Fresh server data under the currently observed lifetime, not a credential. */
export async function revalidateWorkspace(): Promise<WorkspaceReadProof> {
  const scope = captureRead();
  assertRead(scope);
  const order = ++nextReadOrder;
  const capturedTarget = targetForRead(scope);
  let issuedTarget: AcceptedReadTarget | null = null;
  try {
    const raw = await readWorkspaces<unknown>(() => assertRead(scope));
    const canonical = normalizeWorkspaces(raw);
    assertRead(scope);
    const previousTarget = targetForRead(scope);
    const target = acceptReadTarget(scope, capturedTarget, order, canonical.active);
    if (!target) throw lifecycle();
    issuedTarget = target;
    retireCompletionForTarget(canonical.active);
    restingPhase = 'ready';
    // Notify predicate consumers of target retirement without invalidating
    // compatible in-flight reads through the auth/mutation lifetime revision.
    publish(previousTarget !== null && previousTarget.epoch !== target.epoch);
    assertRead(scope); // subscriber reentrancy may have begun a transition
    if (targetForRead(scope)?.epoch !== target.epoch) throw lifecycle();
    const proof: WorkspaceReadProof = Object.freeze({ [proofBrand]: true as const, result: canonical });
    acceptances.set(proof, Object.freeze({
      auth: scope.auth, revision: scope.revision, configEvent: scope.configEvent,
      targetEpoch: target.epoch, canonical,
    }));
    rememberWireTenant(canonical.active);
    return proof;
  } catch (error) {
    // An older read's refusal, malformed payload or transport failure cannot
    // erase a newer accepted projection (nor warm its contradictory target).
    const currentTarget = targetForRead(scope);
    const expectedTarget = issuedTarget ?? capturedTarget;
    if (!currentRead(scope) || (expectedTarget !== null && currentTarget?.epoch !== expectedTarget.epoch)
      || order < (currentTarget?.latestOrder ?? 0)) throw lifecycle();
    proofRevision = newRevision();
    const failedAuth = authRevision;
    const failedRevision = proofRevision;
    restingPhase = 'failed';
    publish();
    if (authRevision !== failedAuth || proofRevision !== failedRevision) throw lifecycle();
    throw error;
  }
}
export function isCurrentWorkspaceRead(proof: WorkspaceReadProof): boolean {
  if (!proof || typeof proof !== 'object') return false;
  const accepted = acceptances.get(proof);
  const target = acceptedReadTarget;
  return accepted !== undefined && target !== null && accepted.auth === authRevision
    && accepted.targetEpoch === target.epoch
    && accepted.canonical.active === target.active
    && accepted.revision === proofRevision && snapshot.phase === 'ready'
    && accepted.configEvent === getCurrentAuthChangeEvent() && observedConfigEvent === accepted.configEvent
    && pendingCount() === 0 && !hasUncertainty();
}


function currentResultCompletion(record: CompletionRecord): boolean {
  return latestCompletion === record && !record.retired
    && latestAttempt === record.attempt && record.auth === authRevision
    && record.revision === proofRevision && record.configEvent === getCurrentAuthChangeEvent()
    && observedConfigEvent === record.configEvent && pendingCount() === 0 && !hasUncertainty();
}
function currentUICompletion(ui: UICompletion): boolean {
  return activeUICompletion === ui && !ui.retired && ui.observedOwnEvent
    && ui.expectedEvent !== null && getCurrentAuthChangeEvent() === ui.expectedEvent
    && observedConfigEvent === ui.expectedEvent && ui.postAuth === authRevision
    && ui.postRevision === proofRevision && latestAttempt === ui.source.attempt
    && pendingCount() === 0 && !hasUncertainty();
}

/**
 * Owner decision D2a (#6156): once the server has completed a switch or create,
 * the cookie already names the new workspace. If the completion was retired
 * (an auth event such as a token refresh, or the caller unmounted), the page is
 * still running the OLD workspace's state, so writes would land in the new one.
 * Reload, unless a newer attempt is pending: that attempt owns the transition,
 * and reloading now would abort it mid-request.
 * Returns true when it reloaded.
 */
export function reloadIfTransitionStranded(outcome: CompletionOutcome, reload: () => void): boolean {
  if (outcome !== 'retired' && outcome !== 'caller-retired') return false;
  if (pendingCount() > 0) return false;
  reload();
  return true;
}

/** One synchronous UI invocation, NOT a lease over a later callback/realm. */
export function completeWorkspaceTransition(result: WorkspaceMutationResult, actions: CompletionActions): CompletionOutcome {
  if (!result || typeof result !== 'object') return 'retired';
  const record = completions.get(result);
  if (!record || record.state !== 'eligible' || !currentResultCompletion(record)) return 'retired';
  record.state = 'consuming';
  let ui: UICompletion | null = null;
  try {
    // Accessors can reenter; check the global binding again after capture.
    const isCallerCurrent = actions.isCallerCurrent;
    const beforeAction = actions.beforeAction;
    const action = actions.action;
    const failed = actions.failed;
    if (typeof isCallerCurrent !== 'function' || typeof action !== 'function' || typeof failed !== 'function'
      || (beforeAction !== undefined && typeof beforeAction !== 'function')) {
      throw new TypeError('workspace_completion_actions_invalid');
    }
    if (!currentResultCompletion(record)) return 'retired';
    const context: UICompletion = {
      source: record, expectedEvent: null, observedOwnEvent: false,
      postAuth: null, postRevision: null, retired: false,
    };
    ui = context;
    activeUICompletion = context;
    let notificationFailed = false;
    let notificationError: unknown;
    try {
      fireAuthChanged((event) => {
        context.expectedEvent = event;
        if (activeUICompletion !== context || context.retired || latestAttempt !== record.attempt
          || getCurrentAuthChangeEvent() !== event || pendingCount() || hasUncertainty()) throw lifecycle();
      });
    } catch (error) { notificationFailed = true; notificationError = error; }

    const status = (): 'retired' | 'caller-retired' | null => {
      if (!currentUICompletion(context)) return 'retired';
      const caller = isCallerCurrent(); // a thrown guard propagates; no UI callback
      if (!currentUICompletion(context)) return 'retired';
      return caller ? null : 'caller-retired';
    };
    const reportFailure = (phase: CompletionFailure['phase'], error: unknown, actionMayHaveRun: boolean): CompletionOutcome => {
      const stale = status();
      if (stale) return stale;
      failed(Object.freeze({
        phase, listenerFailureCount: error instanceof AuthChangeDispatchError ? error.listenerFailureCount : 0,
        mutationMayHaveCompleted: true as const, actionMayHaveRun,
      }));
      return 'failed';
    };
    const afterNotification = status();
    if (afterNotification) return afterNotification;
    if (notificationFailed) return reportFailure('notification', notificationError, false);
    try { beforeAction?.(); }
    catch (error) { reportFailure('before-action', error, false); throw error; }
    const immediatelyBeforeAction = status();
    if (immediatelyBeforeAction) return immediatelyBeforeAction;
    try { action(); }
    catch (error) { reportFailure('action', error, true); throw error; }
    // The action has already been invoked. Reentrancy inside it cannot undo it.
    return 'completed';
  } finally {
    record.state = 'consumed';
    if (ui && activeUICompletion === ui) activeUICompletion = null;
  }
}
