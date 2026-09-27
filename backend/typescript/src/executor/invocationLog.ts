/**
 * Engine-side invocation log — `spec/v1/idempotency.md` §"Layer 2:
 * Activity-level idempotency".
 *
 * ADR 0549 P3 / RFC 0150 §B: keyed on the **logical effect identity**
 * (`host/effectIdentity.ts`), which folds in tenant, run, node, logical
 * invocation ordinal and provider key — and pointedly NOT the retry counter.
 *
 * `attempt` rides the key as the record's outcome-sequence discriminator, so a
 * replay can reproduce "failed at attempt 1, succeeded at attempt 2" (ADR 0326
 * P3a) — but it never enters the identity, so `latest()` is retry-stable.
 *
 * Async as of P3.3.
 */

import type { Storage } from '../storage/storage.js';

let backend: Storage | null = null;

/** The exact `(identity, attempt)` record — the replay/fork read. */
export interface InvocationRecordKey {
  runId: string;
  nodeId: string;
  attempt: number;
  invocationId: string;
}

/** The logical effect, without any attempt — the live, retry-stable read. */
export type InvocationIdentityKey = Omit<InvocationRecordKey, 'attempt'>;

export function setInvocationBackend(storage: Storage): void {
  backend = storage;
}

export function getInvocationLog() {
  if (!backend) throw new Error('InvocationLog backend not installed');
  const b = backend;
  return {
    /** Exact `(identity, attempt)`. Use for replay/fork attempt fidelity. */
    async get(key: InvocationRecordKey): Promise<unknown> {
      return await b.getInvocation(key);
    },
    /**
     * ADR 0618 — the ATOMIC claim `spec/v1/idempotency.md` §"Concurrent
     * duplicates (Layer 2)" requires of the persist that guards an effect.
     * `true` iff THIS caller won and must fire. Keyed on the retry-stable
     * identity (no `attempt`) — the identity RFC 0150 §B made retry-stable.
     */
    async claim(
      key: { runId: string; nodeId: string; invocationId: string },
      opts: { nowMs: number; staleAfterMs: number },
    ): Promise<boolean> {
      return await b.claimInvocation(key, opts);
    },
    /** Release a claim whose effect did not fire (best-effort). */
    async release(key: { runId: string; nodeId: string; invocationId: string }): Promise<void> {
      await b.releaseInvocationClaim(key);
    },
    /**
     * The newest recorded outcome for this logical effect, whatever attempt
     * produced it. This is the read RFC 0150 §B's retry stability is ABOUT: a
     * second attempt at the same logical effect resolves the first attempt's
     * record instead of minting a fresh key and re-firing the effect.
     */
    async latest(key: InvocationIdentityKey): Promise<unknown> {
      return await b.getLatestInvocation(key);
    },
    async put(key: InvocationRecordKey, result: unknown): Promise<void> {
      await b.putInvocation(key, result);
    },
  };
}
