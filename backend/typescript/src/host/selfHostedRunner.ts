/**
 * RFC 0122 — self-hosted runner (remote-driven local execution). ADR 0182 Phase 5
 * reference arm: the host routes a run's per-STEP model/tool dispatch to a
 * user-controlled runner that holds local credentials the host cannot reach.
 *
 * This module is the host-side authority the §19 conformance seam
 * (`/v1/host/sample/runner/{register,dispatch}`) drives. It owns:
 *   - the per-subject runner REGISTRY (runtime state; a registered runner is a
 *     live channel in production, an in-process record for the seam's lifetime);
 *   - SUBJECT-FIRST matching — a dispatch resolves ONLY against a runner owned by
 *     the dispatch's own RFC 0048 subject; there is NO cross-subject fallback
 *     (SECURITY: subject isolation). No owning-subject runner ⇒ `runner_unavailable`;
 *   - AT-MOST-ONCE dispatch — `{runId, stepId}` is the idempotency key; the result
 *     is persisted in a DurableCollection (a REAL store, not a mock) so a
 *     redelivered dispatch is dropped (`deduped:true`), never re-executed. This is
 *     load-bearing: a runner side effect (a subscription `claude -p` spend / a tool
 *     action) is NOT idempotent.
 *
 * Boundary (ADR 0182): this host module NEVER spawns a vendor CLI — execution
 * lives in the `clients/subscription-provider` runner (the "degenerate runner" is
 * that shim on localhost). The frames are credential-free by schema
 * (`additionalProperties:false` = the `runner-credential-non-transit` rail); the
 * token stays on the runner and never enters openwop.
 *
 * The `seq` cursor on a dispatch frame is the per-runner monotonic DISPATCH
 * cursor — DISTINCT from the run event-log sequence (they MUST NOT be conflated).
 */

import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

/** A registered runner (RFC 0122 registration frame; runtime state). */
export interface RunnerRegistration {
  runnerId: string;
  /** The run's owning RFC 0048 principal. Subject-first match keys on this. */
  subject: string;
  capabilities: { providers?: string[]; models?: string[]; tools?: string[] };
}

/** A persisted dispatch result — the at-most-once store row. */
interface RunnerDispatchResult {
  /** `${subject}:${runId}:${stepId}` — the DurableCollection key. */
  key: string;
  /** The owning RFC 0048 subject (ADR 0464 P2) — carried as its own field so the
   *  DSAR eraser matches on it exactly, rather than parsing a `${subject}:…` key
   *  whose subject segment may itself contain colons (`user:<id>`). Additive; a
   *  legacy row without it falls back to the key prefix at erasure time. */
  subject?: string;
  output: unknown;
}

/** Per-subject runner registry. Runtime state (NOT on `/.well-known`). */
const registrationsBySubject = new Map<string, RunnerRegistration>();

/** At-most-once persisted-result store (real durable KV, not a mock). */
const dispatchResults = new DurableCollection<RunnerDispatchResult>(
  'runner-dispatch-result',
  (r) => r.key,
);

function dedupeKey(subject: string, runId: string, stepId: string): string {
  return `${subject}:${runId}:${stepId}`;
}

/** Register (or replace) the runner for a subject. Returns its id. */
export function registerRunner(reg: RunnerRegistration): { runnerId: string } {
  registrationsBySubject.set(reg.subject, reg);
  return { runnerId: reg.runnerId };
}

/** The runner owned by `subject`, or null. SUBJECT-FIRST: never another subject's. */
export function runnerForSubject(subject: string): RunnerRegistration | null {
  return registrationsBySubject.get(subject) ?? null;
}

/** Raised when no owning-subject runner is registered — retriable by contract. */
export class RunnerUnavailableError extends Error {
  readonly retriable = true;
  constructor(message = 'no runner registered for the dispatch subject') {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

/** The result of routing a dispatch frame to a registered runner. */
export interface DispatchOutcome {
  result: unknown;
  deduped: boolean;
}

/**
 * Route ONE dispatch step to the subject's registered runner.
 *
 * - No owning-subject runner ⇒ throws {@link RunnerUnavailableError} (the caller
 *   maps it to `runner_unavailable`, retriable). NEVER falls back to another
 *   subject's runner.
 * - A `{runId, stepId}` whose result is already persisted ⇒ returns it with
 *   `deduped:true` (at-most-once; the runner is NOT re-invoked).
 * - Otherwise routes to the runner, persists the result, returns `deduped:false`.
 *
 * `execute` is injected: in the conformance seam it deterministically represents
 * the registered runner's execution (the degenerate in-process runner); on the
 * product path it is the SSE/loopback channel to the real runner. The output is
 * treated as UNTRUSTED transport by callers before it re-enters the agent loop
 * (`runner-output-untrusted-transport`).
 */
export async function dispatchToRunner(
  args: { subject: string; runId: string; stepId: string; frame: unknown },
  execute: (runner: RunnerRegistration, frame: unknown) => Promise<unknown>,
): Promise<DispatchOutcome> {
  const { subject, runId, stepId, frame } = args;
  const runner = runnerForSubject(subject);
  if (!runner) throw new RunnerUnavailableError();

  const key = dedupeKey(subject, runId, stepId);
  const existing = await dispatchResults.get(key);
  if (existing) return { result: existing.output, deduped: true };

  const output = await execute(runner, frame);
  await dispatchResults.put({ key, subject, output });
  return { result: output, deduped: false };
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A dispatch-result row is at-most-once bookkeeping for ONE subject's runner
// dispatches (`${subject}:${runId}:${stepId}`) — the subject's own execution
// residue, keyed by their RFC 0048 principal. This store is DELIBERATELY
// SUBJECT-scoped, not tenant-scoped: the RFC 0122 §19 dispatch wire carries no
// tenant, so a row cannot be attributed to one. A DSAR therefore DELETES every
// row owned by the subject regardless of which tenant's erasure triggered it —
// over-erasure of the subject's OWN data (never another subject's), the
// fail-closed direction for privacy. The bounded cost: if the same principal is
// active in another tenant, that tenant's at-most-once dedup for the subject's
// runner resets and an already-executed step may re-run. Acceptable: the runner
// capability is HONEST-OFF (`supported:false`), so today the store only ever
// holds conformance-seam residue.

/** DSAR eraser — delete every runner dispatch-result row owned by the subject.
 *  `_tenantId` is intentionally unused (see the subject-scoped note above). */
export async function eraseSubjectRunnerDispatches(_tenantId: string, subjectKey: string): Promise<void> {
  if (!subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const row of await dispatchResults.list()) {
    // Prefer the explicit `subject` field; fall back to the key's subject prefix
    // (`${subject}:${runId}:${stepId}`) for legacy rows that predate the field.
    const rowSubject = row.subject ?? row.key.split(':').slice(0, -2).join(':');
    if (forms.has(rowSubject)) await dispatchResults.delete(row.key);
  }
}

/** Register the self-hosted-runner DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerSelfHostedRunnerErasure(): void {
  registerSubjectEraser(eraseSubjectRunnerDispatches);
}

/**
 * RFC 0122 capability advertisement. HONEST-OFF: `supported:false` until RFC 0122
 * is `Accepted` (Phase 3) AND an operator opts in — no host may advertise
 * `supported:true` before then. `dispatchKinds:["model"]` reflects the Phase-5
 * model-first arm (tool dispatch deferred behind the same gate).
 */
export function selfHostedRunnerAdvertised(): { supported: boolean; dispatchKinds: string[] } {
  const supported =
    process.env.OPENWOP_SELF_HOSTED_RUNNER === 'true' &&
    process.env.OPENWOP_SELF_HOSTED_RUNNER_ACCEPTED === 'true';
  return { supported, dispatchKinds: ['model'] };
}

/** Test-only reset of the in-memory registry (durable results persist). */
export function _resetRunnerRegistryForTest(): void {
  registrationsBySubject.clear();
}
