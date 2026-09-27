/**
 * Strategy check-ins (ADR 0231 §C1) — the append-only measurement trail under
 * key results, and the ONE write path for KR values.
 *
 * The governance model (the Phase C architect review's binding correction —
 * the capability firewall CANNOT gate workflow-node `ctx.features.*` calls,
 * `host/adsAdapter.ts:204` precedent):
 *
 *   - origin 'human' (routes)  ⇒ status 'confirmed'
 *   - origin 'agent' (surface) ⇒ status 'proposed' — STRUCTURALLY; an agent
 *     can only ever propose (RFC 0096 semantics; the Strategy Analyst's
 *     mutation-free doctrine survives in spirit). A human confirms/dismisses.
 *   - origin 'sync'            ⇒ 'confirmed' ONLY when the KR carries a
 *     human-configured `measure.source` (the standing authorization);
 *     refused fail-closed otherwise.
 *
 * Progress is computed AT READ from the latest CONFIRMED check-in (never
 * stored — `strategyHealth.ts` consumes the helpers below).
 */
import { randomUUID } from 'node:crypto';
import { ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createStrategyCheckInApproval, hasPendingApprovalForCheckIn, findApprovalForCheckIn, resolveApproval } from '../../host/approvalService.js';
import type { Strategy, StrategyKeyResult, StrategyConfidence } from './types.js';
import { strategyMutated } from './emit.js';

export type CheckInStatus = 'confirmed' | 'proposed' | 'dismissed';
export type CheckInOrigin = 'human' | 'agent' | 'sync';

export interface StrategyCheckIn {
  checkInId: string;
  tenantId: string;
  strategyId: string;
  krId: string;
  /** The measured value (absent for a narrative-only check-in). */
  value?: number;
  note?: string;
  confidence?: StrategyConfidence;
  status: CheckInStatus;
  origin: CheckInOrigin;
  /** Opaque actor — principal for humans, `run:<runId>`/'workflow' for runs. */
  actor: string;
  createdAt: string;
  /** Set when a proposed row was confirmed/dismissed. */
  decidedBy?: string;
  decidedAt?: string;
}

const checkIns = new DurableCollection<StrategyCheckIn>(
  'strategy:checkin',
  (c) => c.checkInId,
  undefined,
  (c) => c.tenantId,
);

export const CHECKIN_CAP_PER_KR = 200;
/** Default staleness window (days) — no confirmed check-in within it ⇒ stale. */
export const DEFAULT_STALE_DAYS = 14;

const NOTE_MAX = 2000;

function krOf(strategy: Strategy, krId: string): StrategyKeyResult | undefined {
  for (const o of strategy.objectives) {
    const kr = o.keyResults.find((k) => k.id === krId);
    if (kr) return kr;
  }
  return undefined;
}

/**
 * Append a check-in. Status derives from `origin` (see module doc); a 'sync'
 * write against a KR with no `measure.source` is refused fail-closed.
 */
export async function appendCheckIn(input: {
  strategy: Strategy;
  krId: string;
  value?: number;
  note?: string;
  confidence?: StrategyConfidence;
  origin: CheckInOrigin;
  actor: string;
}): Promise<StrategyCheckIn> {
  const { strategy, krId, origin, actor } = input;
  const kr = krOf(strategy, krId);
  if (!kr) throw new OpenwopError('not_found', 'Key result not found on this strategy.', 404, { krId });
  if (input.value === undefined && !input.note?.trim()) {
    throw new OpenwopError('validation_error', 'A check-in needs a value and/or a note.', 400, {});
  }
  if (input.value !== undefined && !Number.isFinite(input.value)) {
    throw new OpenwopError('validation_error', 'Field `value` must be a finite number.', 400, { field: 'value' });
  }
  if (origin === 'sync' && !kr.measure?.source) {
    // Fail-closed: automation may only write where a human configured a source.
    throw new OpenwopError('forbidden_scope', 'This key result has no configured metric source; a sync write is not authorized.', 403, { krId });
  }
  const status: CheckInStatus = origin === 'agent' ? 'proposed' : 'confirmed';
  const row: StrategyCheckIn = {
    checkInId: `ci:${randomUUID()}`,
    tenantId: strategy.tenantId,
    strategyId: strategy.id,
    krId,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, NOTE_MAX) } : {}),
    ...(input.confidence ? { confidence: input.confidence } : {}),
    status,
    origin,
    actor,
    createdAt: new Date().toISOString(),
  };
  await checkIns.put(row);
  strategyMutated({
    entity: 'check-in', verb: status === 'proposed' ? 'proposed' : 'recorded',
    tenantId: strategy.tenantId, actor, strategyId: strategy.id, orgId: strategy.orgId, changed: [krId],
  });
  // CHAT-FIRST-PORT-AUDIT D3 — a PROPOSED (agent) check-in raises a shared
  // approval row so the confirm/dismiss decision renders in the reviews inbox
  // (and the originating conversation), not only on the strategy page. Deciding
  // from the inbox and from the page resolve THE SAME row (CAS). Deterministic
  // key = checkInId; a retry dedups on the pending row.
  if (status === 'proposed' && !(await hasPendingApprovalForCheckIn(strategy.tenantId, row.checkInId))) {
    const valueBit = input.value !== undefined ? ` ${input.value}` : '';
    await createStrategyCheckInApproval({
      tenantId: strategy.tenantId,
      orgId: strategy.orgId,
      strategyId: strategy.id,
      strategyTitle: strategy.title,
      checkInId: row.checkInId,
      krId,
      krTitle: kr.title,
      proposal: `Confirm check-in on "${kr.title}":${valueBit}${row.note ? ` — ${row.note}` : ''}`.trim(),
    });
  }
  // Cap prune (oldest first, per KR) — an unbounded-growth guard, not policy.
  const existing = await listCheckIns(strategy.tenantId, strategy.id, krId);
  const over = existing.length - CHECKIN_CAP_PER_KR;
  for (let i = 0; i < over; i++) await checkIns.delete(existing[existing.length - 1 - i]!.checkInId);
  return row;
}

/** One check-in by id, tenant + strategy scoped (or null). The page decide route
 *  re-reads through this after the shared approval resolution to return the
 *  updated row (the response contract the FE has always received). */
export async function getCheckIn(tenantId: string, strategyId: string, checkInId: string): Promise<StrategyCheckIn | null> {
  const row = await checkIns.get(checkInId);
  return row && row.tenantId === tenantId && row.strategyId === strategyId ? row : null;
}

/** Check-ins for a strategy (optionally one KR), NEWEST first. Tenant-indexed. */
export async function listCheckIns(tenantId: string, strategyId: string, krId?: string): Promise<StrategyCheckIn[]> {
  return (await checkIns.listForTenantIndexed(tenantId))
    .filter((c) => c.strategyId === strategyId && (krId === undefined || c.krId === krId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** ALL of a tenant's check-ins grouped by strategy — the portfolio-fan-out read
 *  (grade-code STRAT-PERF-1): `/strategy/health` and `listStaleKrs` resolve K
 *  strategies; per-strategy `listCheckIns` would re-scan the same tenant slice
 *  K times. ONE indexed read, grouped once. */
export async function listCheckInsByStrategy(tenantId: string): Promise<Map<string, StrategyCheckIn[]>> {
  const out = new Map<string, StrategyCheckIn[]>();
  for (const c of await checkIns.listForTenantIndexed(tenantId)) {
    const list = out.get(c.strategyId) ?? [];
    list.push(c);
    out.set(c.strategyId, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/** Confirm or dismiss a PROPOSED check-in (human decision; route-gated). */
export async function decideCheckIn(
  tenantId: string,
  strategyId: string,
  checkInId: string,
  outcome: 'confirmed' | 'dismissed',
  decidedBy: string,
): Promise<StrategyCheckIn | null> {
  const row = await checkIns.get(checkInId);
  if (!row || row.tenantId !== tenantId || row.strategyId !== strategyId) return null;
  if (row.status !== 'proposed') {
    throw new OpenwopError('conflict', `Check-in already ${row.status}.`, 409, { status: row.status });
  }
  const next: StrategyCheckIn = { ...row, status: outcome, decidedBy, decidedAt: new Date().toISOString() };
  await checkIns.put(next);
  strategyMutated({
    entity: 'check-in', verb: outcome, tenantId, actor: decidedBy,
    strategyId, changed: [row.krId],
  });
  return next;
}

/** Hard-delete cascade (called from `hardDeleteStrategy`). Also resolves any
 *  still-pending check-in approvals to rejected so a deleted strategy leaves no
 *  ghost row in the reviews inbox (mirrors `rejectPendingApprovalForPage`). */
export async function deleteCheckInsFor(tenantId: string, strategyId: string): Promise<void> {
  for (const c of await listCheckIns(tenantId, strategyId)) {
    if (c.status === 'proposed') {
      const appr = await findApprovalForCheckIn(tenantId, c.checkInId);
      if (appr && appr.status === 'pending') await resolveApproval(appr.approvalId, { status: 'rejected', note: 'strategy deleted' });
    }
    await checkIns.delete(c.checkInId);
  }
}

// ── read-time progress (ADR 0231 §C1 — never stored) ─────────────────────────

/** 0..1 progress for a measured KR given its latest confirmed value; undefined
 *  when unmeasured or unvalued. */
export function computeKrProgress(kr: StrategyKeyResult, latestValue: number | undefined): number | undefined {
  const m = kr.measure;
  if (!m || latestValue === undefined) return undefined;
  if (m.kind === 'boolean') return latestValue >= 1 ? 1 : 0;
  const target = m.target;
  if (target === undefined) return undefined;
  const baseline = m.baseline ?? 0;
  const dir = m.direction ?? 'increase';
  const span = dir === 'increase' ? target - baseline : baseline - target;
  if (span === 0) return latestValue === target ? 1 : undefined; // degenerate config
  const gained = dir === 'increase' ? latestValue - baseline : baseline - latestValue;
  return Math.min(1, Math.max(0, gained / span));
}

export interface StrategyProgress {
  /** 0..1 weighted across measured objectives; undefined when nothing is measured. */
  progress?: number;
  /** Measured KRs with no confirmed check-in within the staleness window. */
  staleKrCount: number;
  measuredKrCount: number;
  proposedCount: number;
}

/** Weighted read-time rollup: KR → objective (KR weights) → strategy
 *  (objective weights). Only measured KRs participate. */
export function computeStrategyProgress(
  strategy: Strategy,
  rows: StrategyCheckIn[],
  nowMs: number = Date.now(),
  staleDays: number = DEFAULT_STALE_DAYS,
): StrategyProgress {
  const latestConfirmed = new Map<string, StrategyCheckIn>();
  let proposedCount = 0;
  for (const r of rows) {
    if (r.status === 'proposed') { proposedCount++; continue; }
    if (r.status !== 'confirmed' || r.value === undefined) continue;
    const cur = latestConfirmed.get(r.krId);
    if (!cur || cur.createdAt < r.createdAt) latestConfirmed.set(r.krId, r);
  }
  const staleBefore = nowMs - staleDays * 86_400_000;
  let staleKrCount = 0;
  let measuredKrCount = 0;
  const objParts: Array<{ w: number; p: number }> = [];
  for (const o of strategy.objectives) {
    const krParts: Array<{ w: number; p: number }> = [];
    for (const kr of o.keyResults) {
      if (!kr.measure) continue;
      measuredKrCount++;
      const latest = latestConfirmed.get(kr.id);
      if (!latest || Date.parse(latest.createdAt) < staleBefore) staleKrCount++;
      const p = computeKrProgress(kr, latest?.value);
      if (p !== undefined) krParts.push({ w: clampWeight(kr.weight), p });
    }
    if (krParts.length > 0) {
      const wSum = krParts.reduce((s, x) => s + x.w, 0);
      objParts.push({ w: clampWeight(o.weight), p: krParts.reduce((s, x) => s + x.w * x.p, 0) / wSum });
    }
  }
  const out: StrategyProgress = { staleKrCount, measuredKrCount, proposedCount };
  if (objParts.length > 0) {
    const wSum = objParts.reduce((s, x) => s + x.w, 0);
    out.progress = objParts.reduce((s, x) => s + x.w * x.p, 0) / wSum;
  }
  return out;
}

function clampWeight(w: number | undefined): number {
  return typeof w === 'number' && Number.isFinite(w) ? Math.min(10, Math.max(1, w)) : 1;
}

/** R2 STR2-M7 — sever the person-link on the measurement trail. The check-in itself is
 *  business truth (it is what a KR's progress is computed from), so the row survives. */
export async function eraseCheckInSubject(tenantId: string, forms: ReadonlySet<string>): Promise<void> {
  for (const r of await checkIns.list()) {
    if (r.tenantId !== tenantId) continue;
    const next = { ...r };
    let touched = false;
    if (forms.has(r.actor)) { next.actor = ERASED_USER_REF; touched = true; }
    if (r.decidedBy !== undefined && forms.has(r.decidedBy)) { next.decidedBy = ERASED_USER_REF; touched = true; }
    if (touched) await checkIns.put(next);
  }
}
