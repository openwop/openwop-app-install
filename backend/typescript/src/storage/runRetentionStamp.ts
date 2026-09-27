/**
 * ADR 0371 — the ONE removal-time stamp. Called by BOTH adapters' updateRun:
 * whenever a patch carries a terminal status, `removalAt = base + TTL` rides
 * along (base = the patch's completedAt, else now). Pure env default here —
 * per-definition overrides, pins, and legal holds are SWEEP-TIME re-checks
 * (they can change after the run completed; write-time stamping alone would
 * bake stale policy into rows).
 */
import type { RunRecord } from '../types.js';

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const DAY_MS = 86_400_000;

/** Days to keep terminal runs. **Absent ⇒ 0 ⇒ retention OFF** (keep-forever —
 *  the documented default; a destructive data-deletion feature must never
 *  activate by omission). Junk ⇒ 0 as well: fail-safe on a misconfiguration
 *  is to KEEP data, never to start deleting on a typo. The value is surfaced
 *  by the admin run-retention endpoint so an operator can confirm it. */
export function defaultRetentionDays(): number {
  const raw = process.env.OPENWOP_RUN_RETENTION_DAYS;
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Returns the patch, with `removalAt` added when it turns a run terminal and
 *  retention is enabled (days > 0). Never overrides an explicit removalAt. */
export function withRemovalStamp(patch: Partial<RunRecord>): Partial<RunRecord> {
  if (!patch.status || !TERMINAL.has(patch.status) || patch.removalAt !== undefined) return patch;
  const days = defaultRetentionDays();
  if (days <= 0) return patch; // 0 ⇒ retention disabled (the legacy posture)
  const base = patch.completedAt ? Date.parse(patch.completedAt) : Date.now();
  return { ...patch, removalAt: new Date(base + days * DAY_MS).toISOString() };
}
