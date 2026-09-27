/**
 * AI-video job store (ADR 0404 §b) — the replay/idempotency anchor. Keyed by a
 * FORK-STABLE requestHash (sha256 of the generation inputs — NEVER runId/nodeId,
 * mirroring adsAdapter idemKeyFor), tenant-scoped so two tenants with identical
 * inputs never collide. An insert-if-absent CAS on the job row makes SUBMIT
 * exactly-once: the CAS winner submits + meters; a concurrent (or re-run) caller
 * with the same inputs finds the existing job and never re-submits / re-charges.
 * On completion the media asset id is pinned here; the node returns it, so replay
 * returns the recorded asset id and never regenerates.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §b
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';

export type VideoJobStatus = 'submitting' | 'processing' | 'downloading' | 'completed' | 'failed';
/** avatar = HeyGen-class script→avatar; t2v = frontier text→video (ADR 0404 P4). */
export type VideoJobKind = 'avatar' | 't2v';

export interface VideoJob {
  /** `${tenantId}:${requestHash}` — the dedup key. */
  jobId: string;
  tenantId: string;
  orgId: string;
  requestHash: string;
  kind: VideoJobKind;
  provider: string; // 'heygen' | the t2v provider
  /** Model id when the provider exposes a choice (t2v) — part of the request hash. */
  model?: string;
  providerJobId?: string;
  status: VideoJobStatus;
  assetId?: string;
  error?: string;
  /** Asset-lineage inputs stamped at submit so ANY finalizer (incl. the status/
   *  resolve path, which lacks the original request) can mint the asset. */
  promptSnippet?: string;
  lineageModel?: string;
  rightsNote?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function isVideoJob(v: unknown): VideoJob | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Record<string, unknown>;
  if (typeof j.jobId !== 'string' || typeof j.tenantId !== 'string' || typeof j.requestHash !== 'string') return null;
  return v as VideoJob;
}

const jobs = new DurableCollection<VideoJob>('creative-video:job', (j) => j.jobId, isVideoJob, (j) => j.tenantId);

/** Fork-stable request hash — the SUBMIT dedup key. Inputs only; NO run/node ids.
 *  `orgId` is included so two ORGS in one tenant with byte-identical inputs get
 *  DISTINCT jobs — else org B would dedup onto org A's asset id and receive a
 *  completed id it can't fetch (org-scoped), plus a cross-org existence oracle
 *  (ADR 0404 grade-data CV-1). `model` + t2v params are included so the SAME prompt
 *  on a DIFFERENT model is a distinct job, never a collision that returns the first
 *  model's asset or under-charges (ADR 0404 P4). */
export function requestHashFor(input: { provider: string; orgId?: string; kind?: VideoJobKind; model?: string; script: string; avatarId?: string; voiceId?: string; width?: number; height?: number; durationSec?: number }): string {
  const canonical = JSON.stringify({
    p: input.provider, o: input.orgId ?? '', k: input.kind ?? 'avatar', m: input.model ?? '', s: input.script,
    a: input.avatarId ?? '', v: input.voiceId ?? '', w: input.width ?? 0, h: input.height ?? 0, d: input.durationSec ?? 0,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function jobIdFor(tenantId: string, requestHash: string): string {
  return `${tenantId}:${requestHash}`;
}

export async function getJob(tenantId: string, orgId: string, jobId: string): Promise<VideoJob | null> {
  const j = await jobs.get(jobId);
  return j && j.tenantId === tenantId && j.orgId === orgId ? j : null;
}

export async function getJobByHash(tenantId: string, requestHash: string): Promise<VideoJob | null> {
  const j = await jobs.get(jobIdFor(tenantId, requestHash));
  return j && j.tenantId === tenantId ? j : null;
}

export async function listJobs(tenantId: string, orgId: string): Promise<VideoJob[]> {
  return (await jobs.listForTenantIndexed(tenantId))
    .filter((j) => j.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ClaimResult = { outcome: 'claimed'; job: VideoJob } | { outcome: 'exists'; job: VideoJob };

/** Insert-if-absent CAS on the job row — the SUBMIT-once gate. Returns `claimed`
 *  (this caller must submit) or `exists` (a concurrent/prior caller owns it). */
export async function claimJob(input: { tenantId: string; orgId: string; requestHash: string; kind: VideoJobKind; provider: string; model?: string; createdBy: string }): Promise<ClaimResult> {
  const jobId = jobIdFor(input.tenantId, input.requestHash);
  const existing = await jobs.get(jobId);
  if (existing) return { outcome: 'exists', job: existing };
  const now = new Date().toISOString();
  const row: VideoJob = {
    jobId, tenantId: input.tenantId, orgId: input.orgId, requestHash: input.requestHash,
    kind: input.kind, provider: input.provider, ...(input.model ? { model: input.model } : {}),
    status: 'submitting', createdBy: input.createdBy, createdAt: now, updatedAt: now,
  };
  const won = await jobs.compareAndSwap(null, row);
  if (won) return { outcome: 'claimed', job: row };
  const fresh = await jobs.get(jobId);
  return { outcome: 'exists', job: fresh ?? row };
}

export async function putJob(next: VideoJob): Promise<void> {
  await jobs.put({ ...next, updatedAt: new Date().toISOString() });
}

/** DELETE every job in (tenant, org) that pinned `assetId` — called when that media
 *  asset is deleted, so a `completed` job can't keep replaying a DEAD asset id
 *  (completed is terminal/non-reclaimable; deleting the row lets the inputs be
 *  regenerated afresh). Bounded: one tenant-indexed scan. (ADR 0404 grade-data CV-2.)
 *  Returns the count pruned. */
export async function clearJobsForAsset(tenantId: string, orgId: string, assetId: string): Promise<number> {
  const rows = (await jobs.listForTenantIndexed(tenantId)).filter((j) => j.orgId === orgId && j.assetId === assetId);
  for (const r of rows) await jobs.delete(r.jobId);
  return rows.length;
}

/**
 * CAS a job row from an EXACT expected state to `next`, returning the persisted row
 * (with its bumped `updatedAt`) on success or `null` if another writer got there
 * first. This is the single race-free state-transition primitive — it backs both
 * the download-claim (processing→downloading, so the large bytes are stored + the
 * asset minted by exactly ONE finalizer) AND the re-claim of a retriable-failed or
 * stale row (→submitting), so a concurrent caller can never steal a row that has
 * advanced (its bytes wouldn't match `expected`). No delete → no delete-race.
 */
export async function casJob(expected: VideoJob, next: VideoJob): Promise<VideoJob | null> {
  const persisted: VideoJob = { ...next, updatedAt: new Date().toISOString() };
  const won = await jobs.compareAndSwap(expected, persisted);
  return won ? persisted : null;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearVideoJobs(): Promise<void> {
  await jobs.__clear();
}
