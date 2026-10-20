/**
 * ADR 0925 P0 — executing an approved change set, one destination at a time,
 * confirmed only by reading the destination back.
 *
 * The job and every step are persisted `pending` BEFORE the first write. Per
 * step (in order):
 *   check  — re-read; already at target ⇒ confirmed without writing; moved from
 *            the source ⇒ conflicted `newer_human_edit`; client in preview ⇒
 *            incomplete `preview_only`;
 *   write  — the step goes `writing` (CAS) before the call; the adapter writes
 *            with `expectedVersion = sourceVersion`; an ambiguous outcome (a throw
 *            or timeout) is `unknown`, never `failed`;
 *   verify — re-read; target hash observed ⇒ confirmed, otherwise conflicted
 *            `readback_mismatch`. A step is confirmed ONLY from a read.
 * `unknown` is reconciled once automatically: target observed ⇒ confirmed (the
 * write had landed); still at source ⇒ retry once; anything else ⇒ conflicted.
 * A job is `finished` only when every step is confirmed; any other mix is
 * `needs_attention`. Nothing is rolled back across destinations.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { getApproval } from '../../host/approvalService.js';
import { OpenwopError } from '../../types.js';
import { adapterFor } from './adapters/registry.js';
import { fieldsHash } from './adapters/cmsPage.js';
import { getAsset } from './assetService.js';
import { auditOps } from './approval.js';
import { getChangeSet, transitionChangeSet } from './changeSetService.js';
import { getClient } from './clientService.js';
import type { ChangeSet, ChangeSetEntry } from './types.js';

export type StepState = 'pending' | 'checking' | 'writing' | 'written' | 'unknown' | 'confirmed' | 'conflicted' | 'incomplete';
/** ADR 0925 D6 — a closed set (plus the adapter's `not_authorized` / `publish_blocked`, recorded as-built). */
export type StepReason =
  | 'newer_human_edit' | 'readback_mismatch' | 'ambiguous_write_then_changed'
  | 'wrong_client' | 'client_inactive' | 'asset_gone' | 'preview_only'
  | 'access_revoked' | 'destination_unavailable' | 'email_already_sent'
  | 'not_authorized' | 'publish_blocked';

export interface JobStep {
  assetId: string;
  label: string;
  seq: number;
  state: StepState;
  reason?: StepReason;
  attempts: number;
  idempotencyKey: string;
  observed?: { version: number; contentHash: string; fieldsHash: string; at: string };
  resolution?: { action: string; by: string; at: string; note?: string };
  updatedAt: string;
}

export interface Job {
  tenantId: string;
  orgId: string;
  jobId: string;
  changeSetId: string;
  approvedChangeSetHash: string;
  approvalId: string;
  actingUserId: string;
  status: 'running' | 'finished' | 'needs_attention';
  steps: JobStep[];
  outcome?: { confirmed: number; conflicted: number; incomplete: number; unknown: number; total: number };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

const jobs = new DurableCollection<Job>('campaign-ops:job', (j) => `${j.tenantId}::${j.orgId}::${j.jobId}`, undefined, (j) => j.tenantId);
const nowIso = (): string => new Date().toISOString();

export const jobIdOf = (tenantId: string, approvalId: string): string =>
  `cjob:${createHash('sha256').update(JSON.stringify([tenantId, approvalId])).digest('hex').slice(0, 32)}`;

export async function getJob(tenantId: string, orgId: string, jobId: string): Promise<Job | null> {
  const j = await jobs.get(`${tenantId}::${orgId}::${jobId}`);
  return j && j.tenantId === tenantId && j.orgId === orgId ? j : null;
}

export async function listJobs(tenantId: string, orgId: string): Promise<Job[]> {
  return (await jobs.listForTenantIndexed(tenantId))
    .filter((j) => j.tenantId === tenantId && j.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One step's state change, CAS on the whole job row. Returns the new job. */
async function updateStep(job: Job, assetId: string, patch: Partial<JobStep>): Promise<Job> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = attempt === 0 ? job : await getJob(job.tenantId, job.orgId, job.jobId);
    if (!cur) throw new OpenwopError('not_found', 'Job not found.', 404, { jobId: job.jobId });
    const next: Job = {
      ...cur,
      steps: cur.steps.map((s) => (s.assetId === assetId ? { ...s, ...patch, updatedAt: nowIso() } : s)),
      updatedAt: nowIso(),
    };
    if (await jobs.compareAndSwap(cur, next)) return next;
  }
  throw new OpenwopError('conflict', 'The job is being updated elsewhere; try again.', 409, { reason: 'job_contended' });
}

const TERMINAL: ReadonlySet<StepState> = new Set(['confirmed', 'conflicted', 'incomplete']);
const stepOf = (job: Job, assetId: string): JobStep => job.steps.find((s) => s.assetId === assetId)!;

/** Persist the job before acting (idempotent: one job per approval). */
async function ensureJob(tenantId: string, cs: ChangeSet, approvalId: string, actingUserId: string): Promise<Job> {
  const jobId = jobIdOf(tenantId, approvalId);
  const existing = await getJob(tenantId, cs.orgId, jobId);
  if (existing) return existing;
  const now = nowIso();
  const job: Job = {
    tenantId, orgId: cs.orgId, jobId,
    changeSetId: cs.changeSetId, approvedChangeSetHash: cs.hash, approvalId, actingUserId,
    status: 'running',
    steps: cs.entries.map((e, seq) => ({
      assetId: e.assetId, label: e.label, seq, state: 'pending' as const, attempts: 0,
      idempotencyKey: `cops:${cs.changeSetId}:${e.assetId}:${cs.hash}`, updatedAt: now,
    })),
    createdAt: now, updatedAt: now,
  };
  if (await jobs.compareAndSwap(null, job)) {
    auditOps(tenantId, 'job.started', { orgId: cs.orgId, jobId, changeSetId: cs.changeSetId, changeSetHash: cs.hash, approvalId });
    return job;
  }
  return (await getJob(tenantId, cs.orgId, jobId))!;
}

type Observation = { version: number; contentHash: string; fieldsHash: string; at: string };

async function observe(tenantId: string, orgId: string, entry: ChangeSetEntry): Promise<Observation | null> {
  const asset = await getAsset(tenantId, orgId, entry.assetId);
  if (!asset) return null;
  const snap = await adapterFor(asset.destination)?.read(asset, { tenantId });
  if (!snap) return null;
  return { version: snap.version, contentHash: snap.contentHash, fieldsHash: fieldsHash(snap.fields, asset.editableFields), at: nowIso() };
}

/** Steps 1–3 + reconcile for ONE entry. Returns the job after the step settled. */
async function runStep(job: Job, entry: ChangeSetEntry, preview: boolean): Promise<Job> {
  const { tenantId, orgId } = job;
  const settle = (state: StepState, reason?: StepReason, observed?: Observation): Promise<Job> => {
    auditOps(tenantId, 'step.observation', { orgId, jobId: job.jobId, assetId: entry.assetId, state, ...(reason ? { reason } : {}), ...(observed ? { version: observed.version, fieldsHash: observed.fieldsHash } : {}) });
    return updateStep(job, entry.assetId, { state, ...(reason ? { reason } : {}), ...(observed ? { observed } : {}) });
  };

  // check
  job = await updateStep(job, entry.assetId, { state: 'checking' });
  const before = await observe(tenantId, orgId, entry);
  if (!before) return settle('incomplete', 'asset_gone');
  if (before.fieldsHash === entry.targetContentHash) return settle('confirmed', undefined, before);
  if (before.version !== entry.sourceVersion || before.contentHash !== entry.sourceContentHash) return settle('conflicted', 'newer_human_edit', before);
  if (preview) return settle('incomplete', 'preview_only', before);

  const asset = (await getAsset(tenantId, orgId, entry.assetId))!;
  const adapter = adapterFor(asset.destination);
  if (!adapter) return settle('incomplete', 'destination_unavailable', before);

  const attemptWrite = async (): Promise<'written' | 'unknown' | Job> => {
    job = await updateStep(job, entry.assetId, { state: 'writing', attempts: stepOf(job, entry.assetId).attempts + 1 });
    auditOps(tenantId, 'step.attempt', { orgId, jobId: job.jobId, assetId: entry.assetId, attempt: stepOf(job, entry.assetId).attempts, idempotencyKey: stepOf(job, entry.assetId).idempotencyKey });
    try {
      const out = await adapter.write(asset, entry.edits, { expectedVersion: entry.sourceVersion }, { tenantId, actingUserId: job.actingUserId });
      if (out.kind === 'written') return 'written';
      if (out.kind === 'version_conflict') return settle('conflicted', 'newer_human_edit');
      const reason: StepReason = out.reason === 'edit_mismatch' || out.reason === 'not_editable' ? 'newer_human_edit' : out.reason;
      return out.reason === 'edit_mismatch' || out.reason === 'not_editable' ? settle('conflicted', reason) : settle('incomplete', reason);
    } catch {
      return 'unknown'; // the write may have landed: never `failed`, never a blind retry
    }
  };

  let result = await attemptWrite();
  if (typeof result !== 'string') return result;
  if (result === 'unknown') {
    job = await updateStep(job, entry.assetId, { state: 'unknown' });
    // Reconcile once against the destination itself.
    const seen = await observe(tenantId, orgId, entry);
    if (!seen) return settle('incomplete', 'asset_gone');
    if (seen.fieldsHash === entry.targetContentHash) return settle('confirmed', undefined, seen);
    if (seen.version !== entry.sourceVersion || seen.contentHash !== entry.sourceContentHash) return settle('conflicted', 'ambiguous_write_then_changed', seen);
    result = await attemptWrite(); // unchanged ⇒ the write did not land: retry ONCE
    if (typeof result !== 'string') return result;
    if (result === 'unknown') return updateStep(job, entry.assetId, { state: 'unknown' }); // stays visible as unknown
  }
  // verify
  job = await updateStep(job, entry.assetId, { state: 'written' });
  const after = await observe(tenantId, orgId, entry);
  if (!after) return settle('incomplete', 'asset_gone');
  return after.fieldsHash === entry.targetContentHash ? settle('confirmed', undefined, after) : settle('conflicted', 'readback_mismatch', after);
}

/**
 * Run (or resume) the job for an approved change set. Idempotent: a re-run skips
 * settled steps, and the check-before-write makes a resumed step converge.
 */
export async function executeApprovedChangeSet(tenantId: string, orgId: string, approvalId: string): Promise<Job> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'campaign-change-set' || approval.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Approval not found.', 404, { approvalId });
  }
  if (approval.status !== 'approved' || !approval.decidedBy) {
    throw new OpenwopError('forbidden', 'This change has not been approved.', 403, { reason: 'not_approved' });
  }
  const cs = await getChangeSet(tenantId, orgId, approval.changeSetId ?? '');
  // An approval of hash X never authorizes hash Y.
  if (!cs || cs.hash !== approval.changeSetHash) {
    throw new OpenwopError('forbidden', 'The approval does not name this change.', 403, { reason: 'change_set_mismatch' });
  }
  const client = await getClient(tenantId, orgId);
  let job = await ensureJob(tenantId, cs, approvalId, approval.decidedBy);
  await transitionChangeSet(tenantId, orgId, cs.changeSetId, ['approved'], 'executing');
  for (const entry of cs.entries) {
    const step = stepOf(job, entry.assetId);
    if (TERMINAL.has(step.state)) continue;
    if (!client || client.status !== 'active') { job = await updateStep(job, entry.assetId, { state: 'incomplete', reason: 'client_inactive' }); continue; }
    job = await runStep(job, entry, client.mode === 'preview');
  }
  const count = (st: StepState): number => job.steps.filter((s) => s.state === st).length;
  const outcome = { confirmed: count('confirmed'), conflicted: count('conflicted'), incomplete: count('incomplete'), unknown: count('unknown'), total: job.steps.length };
  const done: Job = { ...job, outcome, status: outcome.confirmed === outcome.total ? 'finished' : 'needs_attention', finishedAt: nowIso(), updatedAt: nowIso() };
  if (!(await jobs.compareAndSwap(job, done))) return (await getJob(tenantId, orgId, job.jobId)) ?? job;
  await transitionChangeSet(tenantId, orgId, cs.changeSetId, ['executing'], 'finished');
  auditOps(tenantId, 'job.finished', { orgId, jobId: job.jobId, changeSetId: cs.changeSetId, status: done.status, ...outcome });
  return done;
}

/** Remove every job of one client. */
export async function purgeJobsForOrg(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const j of await listJobs(tenantId, orgId)) if (await jobs.delete(`${tenantId}::${orgId}::${j.jobId}`)) n++;
  return n;
}
