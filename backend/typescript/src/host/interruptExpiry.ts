/**
 * ADR 1001 D6 — prompts that EXPIRE into a host-chosen resume value, keyed by
 * the interrupt data's `profile`.
 *
 * Approval gates fail closed on timeout (`executor/approvalGateTimeout.ts`).
 * A prompt a node can continue without — the ADR 0189 connect-to-continue
 * prompt (resumes as `{action:'skip'}`), an agent's clarification (resumes as
 * `{skipped:true, reason:'timeout'}`) — instead RESUMES on expiry. This is the
 * one registry of those profiles, read by the lazy path on the open-interrupts
 * read (`routes/interrupts.ts`) and by the periodic sweep on the webhook worker
 * tick, so a prompt nobody looks at still expires. Core names no feature's
 * profile; a feature registers its own.
 *
 * The resume itself goes through the ONE resolve choke point
 * (`resolveAndResume`, preclaimed), late-bound by the interrupts routes, which
 * own the host suite it needs.
 */
import type { Storage } from '../storage/storage.js';
import type { InterruptRecord } from '../types.js';
import { openInterruptsForSweep } from '../executor/openInterruptSweep.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.interruptExpiry');

interface ExpiringProfile { value: unknown; sweep: boolean }
const profiles = new Map<string, ExpiringProfile>();

/** Register a profile that resumes with `value` once past its `expiresAt`.
 *  `sweep: false` keeps it lazy-only (expires when someone reads the run). */
export function registerExpiringPromptProfile(profile: string, value: unknown, opts: { sweep: boolean }): void {
  profiles.set(profile, { value, sweep: opts.sweep });
}

/** The registered expiry value for an interrupt, or undefined. */
export function expiringPromptOf(it: Pick<InterruptRecord, 'data'>): ExpiringProfile | undefined {
  const profile = (it.data as { profile?: unknown } | null | undefined)?.profile;
  return typeof profile === 'string' ? profiles.get(profile) : undefined;
}

/** Claims the row (CAS) and resumes it; true when THIS call resolved it. */
export type ExpiringPromptResumer = (it: InterruptRecord) => Promise<boolean>;
let resumer: ExpiringPromptResumer | null = null;
export function setExpiringPromptResumer(fn: ExpiringPromptResumer | null): void {
  resumer = fn;
}

const SWEEP_BATCH = 200;

/** One periodic pass over open interrupts (bounded, round-robin, fail-contained). */
export async function sweepExpiredPrompts(storage: Storage, now: number = Date.now()): Promise<number> {
  if (!resumer || ![...profiles.values()].some((p) => p.sweep)) return 0;
  const open = await openInterruptsForSweep(storage, 'expiring-prompts', SWEEP_BATCH);
  let resumed = 0;
  for (const it of open) {
    const p = expiringPromptOf(it);
    if (!p?.sweep || it.resolvedAt || !it.expiresAt || Date.parse(it.expiresAt) > now) continue;
    try {
      if (await resumer(it)) resumed++;
    } catch (err) {
      log.warn('expiring_prompt_sweep_failed', { interruptId: it.interruptId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return resumed;
}
