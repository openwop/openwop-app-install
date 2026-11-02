/**
 * ADR 1005 D2/D3/D7/D8 — the RFC 0082 deployment store and state machine.
 *
 * One row per `(tenant, agentId, version)` in a tenant-partitioned
 * `DurableCollection`; every write is a CAS on the row read. What this upholds:
 *   - a refused transition writes nothing (each check runs before any write);
 *   - promoting a version to `active` never retires the one serving the channel:
 *     that one stays `active`, the canary remainder and the rollback target;
 *   - an applied transition runs on its own deployment-management run (RFC 0254
 *     §D), which carries `authorization.decided` and the `deployment.*` event; a
 *     refused one creates no run;
 *   - resolution is a pure function of the stored rows and the draw key, so it
 *     never needs `Math.random` and a pin can always be re-derived;
 *   - a cited eval run that is not a completed, passed eval of THIS agent never
 *     promotes (`eval_gate_unmet`).
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { appendAudit } from '../../host/auditChainService.js';
import { getEventLog } from '../../executor/eventLog.js';
import { toWireRunId } from '../../host/v2Ids.js';
import { isAgentEvalRun } from '../../host/evals/agentEvalRun.js';
import { getSuspendManager } from '../../executor/suspendManager.js';
import { buildInterruptRequestedPayload } from '../../executor/interruptRequestedPayload.js';
import { normalizeApprovalAction } from '../../executor/interruptActions.js';
import type { HostRunInterruptHandler } from '../../host/hostRunInterrupts.js';
import type { RunRecord } from '../../types.js';
import { effectivePolicy } from './policy.js';
import { prefetchVersions } from './prefetch.js';
import { RunLogClosedError } from '../../storage/runLogClosure.js';
import { isTerminalRunStatus } from '@openwop/openwop';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { canonicalReviewerUserId } from '../../host/approverResolution.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { Storage } from '../../storage/storage.js';
import type { ChannelResolution } from '../../host/agentChannelPin.js';
import { BINDABLE_CHANNELS, LATEST_CHANNEL, agentDeploymentFacet } from './capability.js';
import {
  compareVersions,
  type DeploymentState,
  type StoredDeployment,
  type TransitionRequest,
} from './types.js';

const rows = new DurableCollection<StoredDeployment>(
  'agent-deployments',
  (r) => rowId(r.tenant, r.agentId, r.version),
  undefined,
  (r) => r.tenant,
);

const log = createLogger('features.agent-deployments');
const rowId = (tenant: string, agentId: string, version: string): string => `${tenant}::${agentId}::${version}`;
const nowIso = (): string => new Date().toISOString();

// ── ADR 1005 D8 — the conformance agents ────────────────────────────────────

export const CHANNEL_AGENT = 'core.conformance.channel-agent';
export const SCRIPTED_AGENT = 'core.conformance.agents.scripted';
const RESERVED_AGENTS = new Set([CHANNEL_AGENT, SCRIPTED_AGENT]);

export function isReservedAgent(agentId: string): boolean {
  return RESERVED_AGENTS.has(agentId);
}

function seedRow(tenant: string, agentId: string, version: string, state: DeploymentState, channels?: string[]): StoredDeployment {
  return {
    tenant, agentId, version, state, revision: 1, updatedAt: nowIso(),
    ...(channels ? { channels, activatedAt: '1970-01-01T00:00:00.000Z' } : {}),
  };
}

async function seedReserved(tenant: string, agentId: string): Promise<void> {
  const seeds = agentId === CHANNEL_AGENT
    ? [seedRow(tenant, agentId, '1.0.0', 'active', ['stable']), seedRow(tenant, agentId, '1.0.1', 'draft')]
    : [seedRow(tenant, agentId, '1.0.0', 'draft')];
  // Create-if-absent on deterministic keys: two racing first touches write one row.
  for (const s of seeds) await rows.compareAndSwap(null, s);
}

/** After a transition of the channel agent: if it holds no draft, mint the next patch version as one. */
async function ensureDraft(tenant: string, agentId: string): Promise<void> {
  if (agentId !== CHANNEL_AGENT) return;
  const all = await listStored(tenant, agentId);
  if (all.some((r) => r.state === 'draft')) return;
  const patches = all.map((r) => /^1\.0\.(\d+)$/.exec(r.version)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]));
  const next = `1.0.${Math.max(0, ...patches) + 1}`;
  await rows.compareAndSwap(null, seedRow(tenant, agentId, next, 'draft'));
}

// ── reads ────────────────────────────────────────────────────────────────────

async function listStored(tenant: string, agentId: string): Promise<StoredDeployment[]> {
  const found = await rows.listByPrefix(`${tenant}::${agentId}::`);
  // The prefix ends in the delimiter, but re-check: the key is the boundary.
  return found.filter((r) => r.tenant === tenant && r.agentId === agentId);
}

/**
 * The agent's records, version-sorted. A reserved agent is seeded on first
 * touch; an agent with no stored rows shows its installed version as the
 * synthesized baseline (`active` on `stable`), never written by a read.
 */
export async function listDeployments(tenant: string, agentId: string, baselineVersion?: string): Promise<StoredDeployment[]> {
  let stored = await listStored(tenant, agentId);
  if (stored.length === 0 && isReservedAgent(agentId)) {
    await seedReserved(tenant, agentId);
    stored = await listStored(tenant, agentId);
  }
  if (stored.length === 0 && baselineVersion !== undefined) {
    stored = [{ ...seedRow(tenant, agentId, baselineVersion, 'active', ['stable']), revision: 0 }];
  }
  return stored.sort((a, b) => compareVersions(a.version, b.version));
}

/** The actives listing `channel`, newest activation first. */
function activesOn(all: readonly StoredDeployment[], channel: string): StoredDeployment[] {
  return all
    .filter((r) => r.state === 'active' && (r.channels ?? []).includes(channel))
    .sort((a, b) => (b.activatedAt ?? '').localeCompare(a.activatedAt ?? '') || compareVersions(b.version, a.version));
}

function drawPercent(drawKey: string): number {
  return createHash('sha256').update(drawKey).digest().readUInt32BE(0) % 100;
}

/** ADR 1005 D3 — `(agentId, channel)` → one version, by the canary draw. */
export async function resolveChannel(tenant: string, agentId: string, channel: string, drawKey: string, baselineVersion?: string): Promise<ChannelResolution> {
  const facet = agentDeploymentFacet();
  if (!facet || !facet.channels.includes(channel)) return { ok: false, reason: 'channel_not_advertised' };
  const all = await listDeployments(tenant, agentId, baselineVersion);
  if (channel === LATEST_CHANNEL) {
    const top = all.filter((r) => r.state === 'active').sort((a, b) => compareVersions(b.version, a.version))[0];
    return top ? { ok: true, version: top.version } : { ok: false, reason: 'no_active_deployment' };
  }
  const [newest, prior] = activesOn(all, channel);
  if (!newest) return { ok: false, reason: 'no_active_deployment' };
  if (!prior) return { ok: true, version: newest.version };
  return { ok: true, version: drawPercent(drawKey) < (newest.canaryPercent ?? 100) ? newest.version : prior.version };
}

/** ADR 1014 D4 — does this tenant deploy this agent (any stored row)? */
export async function hasStoredRows(tenant: string, agentId: string): Promise<boolean> {
  return (await listStored(tenant, agentId)).length > 0;
}

/**
 * ADR 1014 D4 — a newly installed version of an agent arrives as a `draft` in every
 * tenant that already deploys it, and changes nothing that runs until promoted.
 * Create-if-absent on the deterministic key, so a reinstall or two instances
 * installing at once write one row. Returns how many rows it created.
 */
export async function mintInstalledDrafts(agentIds: readonly string[], version: string): Promise<number> {
  const ids = new Set(agentIds.filter((id) => !isReservedAgent(id)));
  const tenants = new Map<string, Set<string>>();
  for (const r of await rows.list()) {
    if (!ids.has(r.agentId)) continue;
    const t = tenants.get(r.tenant) ?? new Set<string>();
    t.add(r.agentId);
    tenants.set(r.tenant, t);
  }
  let minted = 0;
  for (const [tenant, agents] of tenants) {
    for (const agentId of agents) if (await mintDraft(tenant, agentId, version, 'pack-install')) minted += 1;
  }
  return minted;
}

/** ADR 1014 P5 — a deleted user agent's deployment rows go with it. */
export async function deleteAgentDeployments(tenant: string, agentId: string): Promise<void> {
  for (const r of await listStored(tenant, agentId)) await rows.compareAndDelete(r);
}

/** Create-if-absent one `draft` row (a deterministic key, so a repeat writes nothing). */
export async function mintDraft(tenant: string, agentId: string, version: string, source: 'pack-install' | 'agent-edit'): Promise<boolean> {
  if (!(await rows.compareAndSwap(null, seedRow(tenant, agentId, version, 'draft')))) return false;
  // ADR 1014 P5 — only the newest edit is THE draft: older never-promoted edit drafts
  // are superseded, so they neither pile up nor pin their revisions forever.
  if (source === 'agent-edit') {
    for (const r of await listStored(tenant, agentId)) {
      if (r.state === 'draft' && r.version !== version) await rows.compareAndDelete(r);
    }
  }
  await audit(tenant, 'deployment.draft.minted', { agentId, version, source });
  return true;
}

/** ADR 1014 D1 — every (agent, version) any tenant's rows name: what boot prefetches. */
export async function allNamedVersions(): Promise<Array<{ tenant: string; agentId: string; version: string }>> {
  return (await rows.list()).filter((r) => !isReservedAgent(r.agentId) && servable(r)).map((r) => ({ tenant: r.tenant, agentId: r.agentId, version: r.version }));
}

/** A version a run can be sent to now or after one transition (active, paused, staged). */
function servable(r: StoredDeployment): boolean {
  return r.state === 'active' || r.state === 'paused' || r.state === 'staged';
}

/** ADR 1014 Q3 — every version any tenant's rows name for these agents (a full
 *  scan; runs only when an install prunes its archive). */
export async function versionsNamedByRows(agentIds: readonly string[]): Promise<ReadonlySet<string>> {
  const ids = new Set(agentIds);
  const out = new Set<string>();
  for (const r of await rows.list()) if (ids.has(r.agentId)) out.add(r.version);
  return out;
}

// ── ADR 1005 D3 — the transition table ──────────────────────────────────────

const NEXT: Partial<Record<DeploymentState, DeploymentState>> = { draft: 'test', test: 'staged', staged: 'active' };

/** RFC 0254 §A — `409 deployment_state_conflict`, `details: {state, transition}`. */
function illegal(state: DeploymentState, transition: string): OpenwopError {
  return new OpenwopError('deployment_state_conflict', `A ${state} version cannot be sent \`${transition}\`.`, 409, { state, transition });
}

const stale = (): OpenwopError => new OpenwopError('conflict', 'The deployment record changed while this transition was applied; read it again and retry.', 409, { reason: 'stale' });

/** The state a transition enters, or a refusal. Pure. */
export function targetState(from: DeploymentState, req: Pick<TransitionRequest, 'transition' | 'toState'>): DeploymentState {
  switch (req.transition) {
    case 'promote': {
      const next = from === 'paused' ? 'active' : NEXT[from];
      if (!next || (req.toState !== undefined && req.toState !== next)) throw illegal(from, 'promote');
      return next;
    }
    case 'pause': if (from === 'active') return 'paused'; break;
    case 'deprecate': if (from === 'active') return 'deprecated'; break;
    case 'rollback': if (from === 'active') return 'rolled-back'; break;
    case 'adjust-canary': if (from === 'active') return 'active'; break;
  }
  throw illegal(from, req.transition);
}

// ── ADR 1005 D7 — the eval gate ─────────────────────────────────────────────

/**
 * `details` is `{reason}` alone. An unknown run and another tenant's run answer
 * byte-identically (identity.md tenant rule, RFC 0252 §C single refusal), and the
 * cited id is not echoed: the error redactor would rewrite it anyway.
 */
function unmet(reason: string): OpenwopError {
  return new OpenwopError('eval_gate_unmet', `The promotion's eval evidence is not met (${reason}).`, 422, { reason });
}

async function verifyEval(storage: Storage, tenant: string, agentId: string, storedRunId: string, requiredPassScore?: number, version?: string): Promise<void> {
  const run = await storage.getRun(storedRunId);
  if (!run || run.tenantId !== tenant) throw unmet('eval_run_not_found');
  if (!isAgentEvalRun(run)) throw unmet('not_an_eval_run');
  const meta = (run.metadata ?? {}) as { eval?: { agentId?: unknown; agentVersion?: unknown; agentVersionPinned?: unknown; agentVersionServed?: unknown }; evalSummary?: { passed?: unknown; aggregateScore?: unknown } };
  if (meta.eval?.agentId !== agentId) throw unmet('eval_of_another_agent');
  // ADR 1014 D5 — an eval that named a version is evidence for that version only.
  if (version !== undefined && (meta.eval.agentVersionPinned === true || meta.eval.agentVersionServed === true) && meta.eval.agentVersion !== version) throw unmet('eval_of_another_version');
  if (run.status !== 'completed' || !meta.evalSummary) throw unmet('eval_not_terminal');
  const passed = requiredPassScore !== undefined
    ? typeof meta.evalSummary.aggregateScore === 'number' && meta.evalSummary.aggregateScore >= requiredPassScore
    : meta.evalSummary.passed === true;
  if (!passed) throw unmet('eval_not_passed');
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface TransitionContext {
  storage: Storage;
  /** The acting principal, for `authorization.decided` on the management run. */
  principal: string;
  /** D13 — every canonical spelling of the requester, for the separation of duties. */
  requesterIds?: string[];
  /** D13 — a spelling could not be resolved to a person: no one may accept (fail closed). */
  requesterUnresolved?: boolean;
  /** The installed version, for an agent with no stored rows. */
  baselineVersion?: string;
  /** `evalRunId` as stored (the wire id decoded against the caller's tenant). */
  storedEvalRunId?: string;
}

/** `200` applied, or `202` waiting on an approval (RFC 0254 §D). */
export interface TransitionOutcome {
  status: 200 | 202;
  record: StoredDeployment;
}

export const DEPLOYMENT_MANAGEMENT_WORKFLOW_ID = 'openwop-app.agent-deployment';
/** D13 — the one interrupt a gated transition suspends on. */
export const APPROVAL_NODE_ID = 'deployment-approval';

/**
 * RFC 0254 §D — the deployment-management run for one transition. Owned by the
 * caller's tenant so `runs:read` reads it on the ordinary run reads. It never
 * executes: it stands for the operation, like the ADR 0858 negotiation audit run.
 * A gated transition's run also carries what its approval needs to apply it.
 */
async function openManagementRun(storage: Storage, tenant: string, agentId: string, req: TransitionRequest, pending?: PendingApply, runId: string = randomUUID()): Promise<string> {
  const now = nowIso();
  await storage.insertRun({
    runId,
    workflowId: DEPLOYMENT_MANAGEMENT_WORKFLOW_ID,
    tenantId: tenant,
    status: 'running',
    inputs: {},
    metadata: { purpose: 'agent-deployment', agentId, version: req.version, transition: req.transition, ...(pending ? { pendingApply: pending } : {}) },
    configurable: {},
    createdAt: now,
    updatedAt: now,
  });
  return runId;
}

async function closeManagementRun(storage: Storage, runId: string, error?: { code: string; message: string }): Promise<void> {
  const now = nowIso();
  await storage.updateRun(runId, error
    ? { status: 'failed', updatedAt: now, completedAt: now, error: { code: error.code, message: error.message } }
    : { status: 'completed', updatedAt: now, completedAt: now });
}

async function write(read: StoredDeployment, next: StoredDeployment): Promise<StoredDeployment> {
  const written = { ...next, revision: read.revision + 1, updatedAt: nowIso() };
  // A synthesized baseline (revision 0) has no stored row yet: insert it.
  if (!(await rows.compareAndSwap(read.revision === 0 ? null : read, written))) throw stale();
  return written;
}

function without<K extends keyof StoredDeployment>(r: StoredDeployment, ...keys: K[]): StoredDeployment {
  const out = { ...r };
  for (const k of keys) delete out[k];
  return out;
}

interface Plan {
  rec: StoredDeployment;
  to: DeploymentState;
  writes: Array<{ read: StoredDeployment; next: StoredDeployment }>;
  event: { kind: string; payload: Record<string, unknown> };
  gated: boolean;
}

/**
 * Validate and gate one transition against the CURRENT rows, and plan its writes.
 * Pure of side effects: every refusal is thrown here, before any run or write.
 */
async function planTransition(tenant: string, agentId: string, req: TransitionRequest, ctx: TransitionContext): Promise<Plan> {
  const facet = agentDeploymentFacet();
  if (!facet) throw new OpenwopError('not_found', 'capabilities.agents.deployment is not advertised', 404, { family: 'agents', facet: 'deployment' });
  const all = await listDeployments(tenant, agentId, ctx.baselineVersion);
  const rec = all.find((r) => r.version === req.version);
  if (!rec) throw new OpenwopError('not_found', `No deployment record of ${agentId} at version ${req.version}.`, 404, { agentId, version: req.version });

  // Advertised states and canary first: the only ground for these refusals is the advertisement.
  if (req.toState !== undefined && !facet.states.includes(req.toState)) {
    throw new OpenwopError('validation_error', `State ${req.toState} is not one this host advertises.`, 400, { field: 'toState' });
  }
  const to = targetState(rec.state, req);
  if (!facet.states.includes(to)) throw new OpenwopError('validation_error', `State ${to} is not one this host advertises.`, 400, { field: 'transition' });
  if (req.channel !== undefined && !(BINDABLE_CHANNELS as readonly string[]).includes(req.channel)) {
    throw new OpenwopError('validation_error', `\`channel\` must be one of: ${BINDABLE_CHANNELS.join(', ')}.`, 400, { field: 'channel' });
  }
  if (req.transition === 'adjust-canary' && req.canaryPercent === undefined) {
    throw new OpenwopError('validation_error', '`adjust-canary` needs `canaryPercent`.', 400, { field: 'canaryPercent' });
  }

  // D7/D12 — cited evidence is always verified; policy may require it.
  const policy = await effectivePolicy(tenant, agentId);
  if (req.transition === 'promote') {
    if (policy.requiredEval && req.evalRunId === undefined) throw unmet('eval_required');
  }
  if (req.evalRunId !== undefined) {
    await verifyEval(ctx.storage, tenant, agentId, ctx.storedEvalRunId ?? req.evalRunId, policy.requiredEval?.requiredPassScore, req.version);
  }
  // D13 — a promote that leaves the record `active` waits for a person.
  // A canary raise is gated too: otherwise an approved 1% could be taken to 100% unreviewed.
  const raisesCanary = req.transition === 'adjust-canary' && (req.canaryPercent ?? 0) > (rec.canaryPercent ?? 100);
  const gated = policy.approval?.onActivate === true && ((req.transition === 'promote' && to === 'active') || raisesCanary);

  const evidence = req.evalRunId !== undefined ? { evalRunId: req.evalRunId } : {};
  let writes: Plan['writes'];
  let event: Plan['event'];
  if (req.transition === 'rollback') {
    // RFC 0254 §B — restore the most recent OTHER version active on the same channel.
    const channels = rec.channels ?? [];
    const others = all.filter((r) => r.version !== rec.version);
    const target = channels.map((c) => activesOn(others, c)[0]).find((r) => r !== undefined);
    if (!target) throw illegal(rec.state, 'rollback');
    writes = [
      // Target first: a lost second write leaves it serving, and a retry completes.
      { read: target, next: without({ ...target, state: 'active', channels: [...new Set([...(target.channels ?? []), ...channels])] }, 'canaryPercent') },
      { read: rec, next: without({ ...rec, state: 'rolled-back', rollbackPointer: target.version }, 'channels', 'canaryPercent') },
    ];
    event = { kind: 'deployment.rolled-back', payload: { agentId, fromVersion: rec.version, toVersion: target.version, rollbackPointer: target.version, ...(req.reason ? { reason: req.reason } : {}) } };
  } else if (req.transition === 'adjust-canary') {
    writes = [{ read: rec, next: { ...rec, canaryPercent: req.canaryPercent! } }];
    event = { kind: 'deployment.canary.adjusted', payload: { agentId, version: rec.version, fromPercent: rec.canaryPercent ?? 100, toPercent: req.canaryPercent! } };
  } else if (req.transition === 'promote' && rec.state === 'paused') {
    // RFC 0254 §A — resume is a promote from paused, recorded as a state change.
    writes = [{ read: rec, next: { ...rec, state: 'active', ...evidence } }];
    event = { kind: 'deployment.state.changed', payload: { agentId, version: rec.version, fromState: 'paused', toState: 'active' } };
  } else if (req.transition === 'promote' && to === 'active') {
    const channels = req.channel !== undefined ? [...new Set([...(rec.channels ?? []), req.channel])] : rec.channels;
    const serving = req.channel !== undefined ? activesOn(all, req.channel).find((r) => r.version !== rec.version) : undefined;
    writes = [{ read: rec, next: {
      ...rec,
      state: 'active',
      ...(channels && channels.length > 0 ? { channels } : {}),
      ...(req.canaryPercent !== undefined ? { canaryPercent: req.canaryPercent } : {}),
      activatedAt: nowIso(),
      ...evidence,
    } }];
    event = { kind: 'deployment.promoted', payload: {
      agentId, ...(serving ? { fromVersion: serving.version } : {}), toVersion: rec.version, toState: 'active',
      ...(req.channel ? { channel: req.channel } : {}), ...(req.canaryPercent !== undefined && req.canaryPercent < 100 ? { canaryPercent: req.canaryPercent } : {}), ...evidence,
    } };
  } else if (req.transition === 'promote') {
    writes = [{ read: rec, next: { ...rec, state: to, ...evidence } }];
    event = { kind: 'deployment.promoted', payload: { agentId, toVersion: rec.version, toState: to, ...evidence } };
  } else {
    writes = [{ read: rec, next: { ...rec, state: to } }];
    event = { kind: 'deployment.state.changed', payload: { agentId, version: rec.version, fromState: rec.state, toState: to } };
  }
  return { rec, to, writes, event, gated };
}

/** Commit a plan on its management run; the run closes `completed`, or `failed` on a lost write. */
async function commit(storage: Storage, tenant: string, agentId: string, plan: Plan, runId: string, principal: string, decision: 'deploy-scope' | 'approved'): Promise<StoredDeployment> {
  const transitionRunId = toWireRunId(runId, tenant);
  const eventLog = getEventLog();
  let updated: StoredDeployment | undefined;
  let wrote = false;
  try {
    // An approved transition's decision is the `interrupt.resolved` already on its log.
    if (decision === 'deploy-scope') {
      await eventLog.append({ runId, type: 'authorization.decided', payload: { principal, action: 'deploy:*', resource: `agent:${agentId}`, allowed: true, reason: 'deploy-scope' } });
    }
    for (const w of plan.writes) {
      const written = await write(w.read, { ...w.next, transitionRunId });
      if (w.read.version === plan.rec.version) updated = written;
    }
    wrote = true;
    await eventLog.append({ runId, type: plan.event.kind, payload: plan.event.payload });
  } catch (err) {
    if (wrote && err instanceof RunLogClosedError) {
      // The run was cancelled after the rows were written: the transition stands,
      // and the run keeps the terminal status its log closed with.
      log.warn('agent_deployment_applied_after_run_closed', { runId, closedBy: err.closedBy });
      await audit(tenant, plan.event.kind, plan.event.payload);
      return updated!;
    }
    await closeManagementRun(storage, runId, err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
    throw err;
  }
  await closeManagementRun(storage, runId);
  await audit(tenant, plan.event.kind, plan.event.payload);
  await ensureDraft(tenant, agentId);
  // ADR 1014 D1 — fetch this agent's named versions in the background ("on promote").
  // Detached: the transition is already durable, so nothing here may fail it.
  if (!isReservedAgent(agentId)) {
    void listStored(tenant, agentId)
      .then((rs) => prefetchVersions(rs.filter(servable).map((r) => ({ tenant, agentId, version: r.version }))))
      .catch(() => undefined);
  }
  return updated!;
}

/**
 * Validate, gate and apply one transition. Every refusal is thrown before the
 * first write. A transition D13 gates answers `202`: its run suspends on an
 * approval interrupt and no row is written until a person accepts it.
 */
export async function applyTransition(tenant: string, agentId: string, req: TransitionRequest, ctx: TransitionContext): Promise<TransitionOutcome> {
  const plan = await planTransition(tenant, agentId, req, ctx);
  if (plan.gated) return { status: 202, record: await suspendForApproval(tenant, agentId, req, ctx, plan) };
  // RFC 0254 §D — the management run: every changed record names it.
  const runId = await openManagementRun(ctx.storage, tenant, agentId, req);
  return { status: 200, record: await commit(ctx.storage, tenant, agentId, plan, runId, ctx.principal, 'deploy-scope') };
}

// ── ADR 1005 D13 — the approval gate ────────────────────────────────────────

/** What an accepted approval needs to apply the transition, carried on its run. */
export interface PendingApply {
  request: TransitionRequest;
  principal: string;
  /** Every canonical spelling of the requester (D13 separation of duties). */
  requesterIds: string[];
  requesterUnresolved?: boolean;
  baselineVersion?: string;
  storedEvalRunId?: string;
}

/** D13 — an open approval expires as rejected after a week (RFC 0093). */
const APPROVAL_TIMEOUT_SEC = 7 * 24 * 60 * 60;

/** One open approval per `(tenant, agentId, version)`, cleared when its gate resolves. */
interface PendingRow { tenant: string; agentId: string; version: string; runId: string; createdAt: string }
const pendingApprovals = new DurableCollection<PendingRow>(
  'agent-deployment-pending-approvals',
  (p) => rowId(p.tenant, p.agentId, p.version),
  undefined,
  (p) => p.tenant,
);

async function releasePending(tenant: string, agentId: string, version: string, runId: string): Promise<void> {
  const row = await pendingApprovals.get(rowId(tenant, agentId, version));
  if (row && row.runId === runId) await pendingApprovals.compareAndDelete(row);
}

/**
 * Claim the version for one approval. A row whose run is gone, finished or no
 * longer waiting on its gate is stale (a crash, a lost cancel hook): it is
 * released and the claim retried once, so a version is never held forever.
 */
async function claimPending(storage: Storage, claim: PendingRow): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await pendingApprovals.compareAndSwap(null, claim)) return true;
    const held = await pendingApprovals.get(rowId(claim.tenant, claim.agentId, claim.version));
    if (!held) continue;
    const run = await storage.getRun(held.runId);
    const open = run && !isTerminalRunStatus(run.status) && (await storage.getInterruptByNode(held.runId, APPROVAL_NODE_ID)) !== null;
    if (open) return false;
    if (run && !isTerminalRunStatus(run.status)) await closeManagementRun(storage, run.runId, { code: 'approval_abandoned', message: 'The approval was abandoned before it could be decided.' });
    await pendingApprovals.compareAndDelete(held);
  }
  return false;
}

async function suspendForApproval(tenant: string, agentId: string, req: TransitionRequest, ctx: TransitionContext, plan: Plan): Promise<StoredDeployment> {
  const runId = randomUUID();
  // Claimed BEFORE the run exists, so a refused second request creates no run (RFC 0254 §D).
  const claim: PendingRow = { tenant, agentId, version: req.version, runId, createdAt: nowIso() };
  if (!(await claimPending(ctx.storage, claim))) {
    throw new OpenwopError('deployment_state_conflict', `A change to ${agentId} ${req.version} is already waiting for approval.`, 409, { state: plan.rec.state, transition: req.transition, reason: 'approval_pending' });
  }
  const pendingApply: PendingApply = {
    request: req,
    principal: ctx.principal,
    requesterIds: ctx.requesterIds ?? [ctx.principal],
    ...(ctx.requesterUnresolved ? { requesterUnresolved: true } : {}),
    ...(ctx.baselineVersion !== undefined ? { baselineVersion: ctx.baselineVersion } : {}),
    ...(ctx.storedEvalRunId !== undefined ? { storedEvalRunId: ctx.storedEvalRunId } : {}),
  };
  try {
    await openManagementRun(ctx.storage, tenant, agentId, req, pendingApply, runId);
  } catch (err) {
    await pendingApprovals.compareAndDelete(claim);
    throw err;
  }
  try {
    const eventLog = getEventLog();
    await eventLog.append({ runId, type: 'authorization.decided', payload: { principal: ctx.principal, action: 'deploy:*', resource: `agent:${agentId}`, allowed: true, reason: 'deploy-scope' } });
    // Content-free: what changes and who asked, never prompts or eval content.
    const canary = req.transition === 'adjust-canary';
    const data = {
      title: canary ? `Approve ${agentId} ${req.version} canary at ${req.canaryPercent}%` : `Approve ${agentId} ${req.version} going active`,
      description: canary
        ? `Raising the canary share from ${plan.rec.canaryPercent ?? 100}% to ${req.canaryPercent}% is waiting for a second person.`
        : `A promotion from ${plan.rec.state} to active${req.channel ? ` on ${req.channel}` : ''} is waiting for a second person.`,
      actions: ['accept', 'reject'],
      timeoutSec: APPROVAL_TIMEOUT_SEC,
      deployment: {
        agentId, version: req.version, transition: req.transition, fromState: plan.rec.state, toState: plan.to,
        ...(req.channel !== undefined ? { channel: req.channel } : {}),
        ...(req.canaryPercent !== undefined ? { canaryPercent: req.canaryPercent } : {}),
      },
      requestedBy: ctx.principal,
    };
    const interrupt = await getSuspendManager().createInterrupt({ runId, nodeId: APPROVAL_NODE_ID, kind: 'approval', data });
    await eventLog.append({ runId, nodeId: APPROVAL_NODE_ID, type: 'node.suspended', payload: { interruptId: interrupt.interruptId, kind: 'approval' } });
    await eventLog.append({ runId, nodeId: APPROVAL_NODE_ID, type: 'interrupt.requested', payload: buildInterruptRequestedPayload({ runId, nodeId: APPROVAL_NODE_ID, kind: 'approval', data }) });
    await ctx.storage.updateRun(runId, { status: 'waiting-input', updatedAt: nowIso() });
  } catch (err) {
    // Never leave a half-open approval holding the version.
    await closeManagementRun(ctx.storage, runId, err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500)).catch(() => undefined);
    await pendingApprovals.compareAndDelete(claim).catch(() => undefined);
    throw err;
  }
  await audit(tenant, 'deployment.approval.requested', { agentId, version: req.version, transition: req.transition });
  // RFC 0254 §D — the record unchanged apart from `transitionRunId`. Nothing is written.
  return { ...plan.rec, transitionRunId: toWireRunId(runId, tenant) };
}

function pendingOf(run: RunRecord): PendingApply | undefined {
  const p = (run.metadata as { pendingApply?: PendingApply } | undefined)?.pendingApply;
  return p && typeof p === 'object' && typeof p.principal === 'string' && p.request && typeof p.request.version === 'string' ? p : undefined;
}

function refuse(reason: string, message: string): OpenwopError {
  return new OpenwopError('forbidden', message, 403, { reason });
}

/** D13/D14 — the resolve route's hand-off for a gated transition's run. */
export function deploymentApprovalHandler(storage: Storage): HostRunInterruptHandler {
  return {
    async authorize({ run, resumeValue, decidedBy }) {
      if (decidedBy === undefined) throw refuse('approval_requires_identity', 'A deployment approval must be decided by a signed-in person.');
      const p = pendingOf(run);
      const raw = (resumeValue as { action?: unknown } | null | undefined)?.action;
      const action = normalizeApprovalAction(typeof raw === 'string' ? raw : '');
      if (action !== 'accept') return; // the requester may withdraw (reject)
      // Separation of duties, compared after canonicalisation: a delegated key
      // resolves to its issuer and a scheme-prefixed subject to its user.
      if (!p || p.requesterUnresolved) throw refuse('self_approval', 'Who asked for this change cannot be established, so it cannot be approved.');
      const asked = new Set(p.requesterIds);
      const decider = (await canonicalDecider(run.tenantId, decidedBy)) ?? decidedBy;
      const user = await canonicalReviewerUserId(run.tenantId, decider);
      if ([decidedBy, decider, user].some((id) => asked.has(id))) {
        throw refuse('self_approval', 'The person who asked for this change cannot approve it.');
      }
    },
    async onResolved({ run, rejection }) {
      const p = pendingOf(run);
      const agentId = (run.metadata as { agentId?: string } | undefined)?.agentId ?? '';
      try {
        if (!p) {
          await closeManagementRun(storage, run.runId, new OpenwopError('internal_error', 'The approval run lost its transition.', 500));
          return;
        }
        if (rejection) {
          await closeManagementRun(storage, run.runId, rejection);
          await audit(run.tenantId, 'deployment.approval.rejected', { agentId, version: p.request.version, transition: p.request.transition });
          return;
        }
        // Planned again against the CURRENT rows: state or evidence may have moved while it waited.
        let plan: Plan;
        try {
          plan = await planTransition(run.tenantId, agentId, p.request, {
            storage, principal: p.principal,
            ...(p.baselineVersion !== undefined ? { baselineVersion: p.baselineVersion } : {}),
            ...(p.storedEvalRunId !== undefined ? { storedEvalRunId: p.storedEvalRunId } : {}),
          });
        } catch (err) {
          await closeManagementRun(storage, run.runId, err instanceof OpenwopError ? err : new OpenwopError('internal_error', String(err), 500));
          return;
        }
        // commit() closes the run itself, `failed` on a lost write.
        await commit(storage, run.tenantId, agentId, plan, run.runId, p.principal, 'approved').catch((err: unknown) => {
          log.warn('agent_deployment_approved_apply_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) });
        });
      } finally {
        if (p) await releasePending(run.tenantId, agentId, p.request.version, run.runId);
      }
    },
    async onCancelled({ run }) {
      const p = pendingOf(run);
      const agentId = (run.metadata as { agentId?: string } | undefined)?.agentId ?? '';
      if (!p) return;
      await releasePending(run.tenantId, agentId, p.request.version, run.runId);
      await audit(run.tenantId, 'deployment.approval.cancelled', { agentId, version: p.request.version, transition: p.request.transition });
    },
  };
}

/** D4 — the content-free audit row. A sink failure never undoes an applied transition. */
export async function audit(tenant: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await appendAudit(tenant, kind, payload);
  } catch (err) {
    // The decision stands as made, as `compensationOperator.auditDecision` does.
    log.error('agent_deployment_audit_failed', { kind, error: err instanceof Error ? err.message : String(err) });
  }
}
