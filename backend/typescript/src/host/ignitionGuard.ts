/**
 * Ignition guard (CFP-1 remediation, HIGH-1) — a small durable dedup latch that
 * stops a model loop from igniting the SAME workflow run over and over.
 *
 * The chat igniter tools (podcasts.produce, campaign run/generate, campaign-brief
 * research/kernel, production plan, …) each `startWorkflowRun` on call. Nothing
 * stopped a re-prompted or retrying model from calling an igniter twice with
 * IDENTICAL business inputs seconds apart — each call minted a fresh (expensive)
 * run, amplifying cost with no user intent behind it. This latch makes a repeat
 * call with the same deterministic key inside a short window RETURN the run that
 * was already started instead of igniting again, while still allowing an honest
 * re-run once the window elapses.
 *
 * Backed by the host's durable `DurableCollection` KV (read-through, per-entity,
 * cross-instance CAS) so the latch holds across instances, not just in one
 * process. The claim row is keyed `ignition:${tenantId}:${key}` (tenant-prefixed
 * so tenant teardown sweeps it); `key` is a caller-computed sha256 over the
 * STABLE business inputs (never a timestamp) so it is deterministic per intent.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from './retentionPurger.js';

/** One ignition claim — the latch for a (tenant, business-key) pair. */
interface IgnitionClaim {
  tenantId: string;
  /** The deterministic business key (sha256 of stable inputs); part of the row id. */
  key: string;
  /** The run this claim ignited, recorded best-effort after `startWorkflowRun`. */
  runId?: string;
  /** When the claim was taken (epoch ms) — a claim older than the window is replaceable. */
  claimedAt: number;
}

const DEFAULT_WINDOW_MS = 5 * 60_000;

/** `ignition:${tenantId}:${key}` row id → tenant-prefixed, so teardown sweeps it. */
const claims = new DurableCollection<IgnitionClaim>(
  'ignition',
  (c) => `${c.tenantId}:${c.key}`,
  undefined,
  (c) => c.tenantId,
);

export type ClaimResult = { claimed: true } | { claimed: false; existingRunId?: string };

/** Build a deterministic ignition key from stable business inputs. Parts are
 *  NUL-joined and hashed, so callers pass e.g. `(toolName, briefId, channel)`.
 *  Never pass timestamps / run ids — the key must be identical across a retry. */
export function ignitionKey(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * Claim the right to ignite for `(tenantId, key)`. Returns `{ claimed: true }`
 * when the caller SHOULD ignite (no live claim), or `{ claimed: false,
 * existingRunId? }` when an identical ignition happened inside `windowMs` — the
 * caller must then REUSE `existingRunId` instead of starting a new run. A claim
 * older than `windowMs` (or absent) is replaceable, so an honest re-run after
 * the window succeeds. `nowMs` is injectable for tests.
 */
export async function claimIgnition(
  tenantId: string,
  key: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  nowMs: number = Date.now(),
): Promise<ClaimResult> {
  const id = `${tenantId}:${key}`;
  const existing = await claims.get(id);
  if (existing && nowMs - existing.claimedAt < windowMs) {
    return { claimed: false, ...(existing.runId ? { existingRunId: existing.runId } : {}) };
  }
  // Take (or replace a stale) claim via CAS against exactly what we read, so a
  // concurrent claimer that swapped first excludes us (cross-instance correct).
  const next: IgnitionClaim = { tenantId, key, claimedAt: nowMs };
  const swapped = await claims.compareAndSwap(existing, next);
  if (swapped) return { claimed: true };
  // Lost the race — re-read: if the winner's claim is live, defer to it.
  const current = await claims.get(id);
  if (current && nowMs - current.claimedAt < windowMs) {
    return { claimed: false, ...(current.runId ? { existingRunId: current.runId } : {}) };
  }
  return { claimed: true };
}

/**
 * CFPT-2 — RELEASE a claim taken by `claimIgnition` when the ignition it guarded
 * did NOT happen (e.g. `startWorkflowRun` returned null / threw). Without this an
 * honest retry is blocked for the whole window even though NO run was started —
 * the claim would be a false "already igniting" latch over a failure. CAS-deletes
 * the claim row only while it is still the un-ignited claim we took: if a run was
 * already recorded against it (`runId` set) the claim is real and is LEFT intact,
 * and an absent/replaced row is a no-op. Cross-instance safe via the id read.
 */
export async function releaseIgnition(tenantId: string, key: string): Promise<void> {
  const id = `${tenantId}:${key}`;
  const existing = await claims.get(id);
  // Only release a claim that never recorded a run — never drop one that ignited.
  if (!existing || existing.runId) return;
  await claims.delete(id).catch(() => undefined);
}

/**
 * Best-effort: record the run this claim ignited so a subsequent duplicate call
 * inside the window can return the real `runId`. A missing/absent claim is a
 * no-op (never resurrects one). CAS so it never clobbers a newer claim.
 */
export async function recordIgnitionRun(tenantId: string, key: string, runId: string): Promise<void> {
  const id = `${tenantId}:${key}`;
  const existing = await claims.get(id);
  if (!existing) return;
  await claims.compareAndSwap(existing, { ...existing, runId }).catch(() => undefined);
}

/** Test-only: drop every claim row. */
export async function __resetIgnitionClaims(): Promise<void> {
  await claims.__clear();
}

// CFPT-4 — age the `ignition` collection via the ADR 0077 retention seam. A claim
// is meaningful only for its short dedup window (minutes); once past it the row is
// functionally dead but still a durable KV row, so without a reaper the namespace
// grows one row per distinct (tenant, business-key) ignition forever. The claim
// carries no PII — a tenant id, a sha256 business key, and an optional runId — so
// it ages on the `internal` classification, like the chat-widget caps counters.
// `claimedAt` (epoch ms) is projected to an ISO instant for the `updatedAt <
// cutoffIso` comparison; the window is operator opt-in (`retention.internalDays`,
// a short value ample for minute-scale claims). Rows without a `tenantId` match no
// tenant and are skipped.
registerRetentionPurger({
  feature: 'ignition-guard',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    return purgeRowsByAge(
      'ignition-guard',
      await claims.list(),
      tenantId,
      cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: new Date(r.claimedAt).toISOString(), id: `${r.tenantId}:${r.key}` }),
      (id) => claims.delete(id),
    );
  },
});
