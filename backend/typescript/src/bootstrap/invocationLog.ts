/**
 * Invocation log — engine-side idempotency. Cross-instance retries of
 * the same (runId, nodeId, attempt, providerKey) tuple agree on a single
 * external-call result via storage-side receipts.
 *
 * Sample-grade: single-process, but the invariant is the same shape as
 * the postgres reference host's pattern.
 */

import { setInvocationBackend } from '../executor/invocationLog.js';
import { setEffectEscapeBackend } from '../host/effectEscapeLedger.js';
import type { Storage } from '../storage/storage.js';

export function ensureInvocationLogInstalled(storage: Storage): void {
  setInvocationBackend(storage);
  // ADR 0591 P2 — the effect ESCAPE ledger installs here too, deliberately.
  // Both are Layer-2 records of the same logical effect keyed by the same
  // RFC 0150 §B identity; installing them apart is how one ends up wired in a
  // deployment where the other is not, and an escape ledger that is silently
  // absent reports zero escapes rather than reporting that it is absent.
  setEffectEscapeBackend(storage);
}
