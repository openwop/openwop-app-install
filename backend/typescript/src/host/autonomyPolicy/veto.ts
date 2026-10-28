/**
 * ADR 0942 P4b — the veto window: a notify-after step with `vetoWindowMs` waits
 * on a TIMER, and the people the policy notifies may veto it before the timer
 * fires. It is never an approval that silence approves (RFC 0093): no veto ⇒ the
 * timer elapses and the step proceeds; a veto ⇒ the step fails `autonomy_vetoed`.
 *
 * - **One record per gate visit**, keyed by `(tenant, runId, gate key)`, opened
 *   get-or-create: a pack node re-executes from the top on resume (and on
 *   replay), so a second open finds the same record and sends no second notice.
 * - **The notification spec is frozen at open**. Named roles are resolved on
 *   the client org at decision time, so a revoked role grants no veto authority.
 * - **Terminal states are CAS'd** (`open → vetoed` before the deadline;
 *   `open → elapsed` when the timer fires), so a re-read is the same answer.
 * - Keyed `tenant::campaign::vetoId`, so a campaign's open windows are a prefix
 *   read, never a tenant scan.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../hostExtPersistence.js';
import type { ActionClass, NotifySpec } from './types.js';

export type VetoStatus = 'open' | 'vetoed' | 'elapsed';

export interface VetoRecord {
  key: string;
  vetoId: string;
  tenantId: string;
  orgId?: string;
  campaignId?: string;
  runId: string;
  gateKey: string;
  actionClass: ActionClass;
  ruleId: string;
  notify: NotifySpec;
  /** ISO; frozen at open. */
  deadline: string;
  status: VetoStatus;
  vetoedBy?: string;
  reason?: string;
  createdAt: string;
  closedAt?: string;
  /** The addressed notice was durably accepted before this window can elapse. */
  notifiedAt?: string;
}

const vetoes = new DurableCollection<VetoRecord>('autonomy:veto', (r) => r.key, undefined, (r) => r.tenantId);

export const vetoIdFor = (tenantId: string, runId: string, gateKey: string): string =>
  createHash('sha256').update([tenantId, runId, gateKey].join('\u0000')).digest('hex').slice(0, 24);
const keyOf = (tenantId: string, campaignId: string | undefined, vetoId: string): string => `${tenantId}::${campaignId ?? '-'}::${vetoId}`;

/** Get-or-create. `created` is false on a re-entry (resume, replay): send no notice then. */
export async function openVetoWindow(args: {
  tenantId: string; orgId?: string; campaignId?: string; runId: string; gateKey: string;
  actionClass: ActionClass; ruleId: string; notify: NotifySpec; windowMs: number; now?: Date;
}): Promise<{ record: VetoRecord; created: boolean }> {
  const vetoId = vetoIdFor(args.tenantId, args.runId, args.gateKey);
  const key = keyOf(args.tenantId, args.campaignId, vetoId);
  const existing = await vetoes.get(key);
  if (existing) return { record: existing, created: false };
  const now = args.now ?? new Date();
  const record: VetoRecord = {
    key, vetoId, tenantId: args.tenantId, ...(args.orgId ? { orgId: args.orgId } : {}), ...(args.campaignId ? { campaignId: args.campaignId } : {}),
    runId: args.runId, gateKey: args.gateKey, actionClass: args.actionClass, ruleId: args.ruleId, notify: args.notify,
    deadline: new Date(now.getTime() + args.windowMs).toISOString(), status: 'open', createdAt: now.toISOString(),
  };
  if (await vetoes.compareAndSwap(null, record)) return { record, created: true };
  const raced = await vetoes.get(key);
  return { record: raced ?? record, created: false };
}

export async function getVeto(tenantId: string, campaignId: string | undefined, vetoId: string): Promise<VetoRecord | null> {
  const r = await vetoes.get(keyOf(tenantId, campaignId, vetoId));
  return r && r.tenantId === tenantId ? r : null;
}

/** A retry after a failed notice uses the same notification id and record. */
export async function markVetoNotified(tenantId: string, campaignId: string | undefined, vetoId: string, runId: string): Promise<VetoRecord> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getVeto(tenantId, campaignId, vetoId);
    if (!cur || cur.runId !== runId) throw new Error('Veto notification owner changed');
    if (cur.notifiedAt) return cur;
    if (Date.parse(cur.deadline) <= Date.now()) throw new Error('Veto notification arrived after its review deadline');
    const next = { ...cur, notifiedAt: new Date().toISOString() };
    if (await vetoes.compareAndSwap(cur, next)) return next;
  }
  throw new Error('Veto notification acknowledgement remained contended');
}

/** The timer fired: `open → elapsed` (CAS), or the terminal state already written. */
export async function closeVetoWindow(tenantId: string, campaignId: string | undefined, vetoId: string, runId: string, now?: Date): Promise<VetoRecord | null> {
  for (let i = 0; i < 3; i++) {
    const cur = await getVeto(tenantId, campaignId, vetoId);
    if (!cur || cur.runId !== runId) return null;
    if (cur.status !== 'open') return cur;
    if (!cur.notifiedAt) return cur;
    const at = now ?? new Date();
    if (!Number.isFinite(Date.parse(cur.deadline)) || Date.parse(cur.deadline) > at.getTime()) return cur;
    const next: VetoRecord = { ...cur, status: 'elapsed', closedAt: at.toISOString() };
    if (await vetoes.compareAndSwap(cur, next)) return next;
  }
  const current = await getVeto(tenantId, campaignId, vetoId);
  return current?.runId === runId ? current : null;
}

/** `open → vetoed` before the deadline. Eligibility is the caller's (the route). */
export async function castVeto(args: { tenantId: string; campaignId: string; vetoId: string; by: string; reason?: string; now?: Date }):
  Promise<{ ok: true; record: VetoRecord } | { ok: false; reason: 'not_found' | 'closed' | 'past_deadline' }> {
  for (let i = 0; i < 3; i++) {
    const cur = await getVeto(args.tenantId, args.campaignId, args.vetoId);
    if (!cur) return { ok: false, reason: 'not_found' };
    if (cur.status !== 'open') return { ok: false, reason: 'closed' };
    const now = args.now ?? new Date();
    if (!Number.isFinite(Date.parse(cur.deadline)) || Date.parse(cur.deadline) <= now.getTime()) return { ok: false, reason: 'past_deadline' };
    const next: VetoRecord = { ...cur, status: 'vetoed', vetoedBy: args.by, ...(args.reason ? { reason: args.reason } : {}), closedAt: now.toISOString() };
    if (await vetoes.compareAndSwap(cur, next)) return { ok: true, record: next };
  }
  return { ok: false, reason: 'closed' };
}

export async function listOpenVetoes(tenantId: string, campaignId: string): Promise<VetoRecord[]> {
  return (await vetoes.listByPrefix(`${tenantId}::${campaignId}::`)).filter((r) => r.tenantId === tenantId && r.status === 'open');
}

/** Subject erasure: `vetoedBy` names a person; it is redacted, the decision kept. */
export async function eraseVetoSubjects(tenantId: string, forms: ReadonlySet<string>, erasedRef: string): Promise<number> {
  let n = 0;
  for (const row of await vetoes.listForTenantIndexed(tenantId)) {
    for (let attempt = 0; ; attempt++) {
      const r = await vetoes.get(row.key);
      if (!r || r.tenantId !== tenantId || !r.vetoedBy || !forms.has(r.vetoedBy)) break;
      if (attempt === 6) throw new Error('Veto subject erasure remained contended');
      if (await vetoes.compareAndSwap(r, { ...r, vetoedBy: erasedRef, reason: undefined })) { n++; break; }
    }
  }
  return n;
}
