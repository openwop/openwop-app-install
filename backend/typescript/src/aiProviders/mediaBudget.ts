/**
 * Media-generation cost governance (ADR 0106) — per-org daily budget accounting
 * for the paid media path: text-to-speech (`ctx.callSpeechSynthesizer`, metered in
 * CHARACTERS) and speech-to-text transcription (`ctx.callAI` audio parts, metered
 * in decoded BYTES).
 *
 * Mirrors the managed-provider daily-cap pattern (`managedProvider.ts`): a
 * module-level `Storage` injected at bootstrap, per-`(tenant, UTC-day)` accounting
 * (tenant = workspace = org at root, ADR 0015), upserted via the storage layer.
 *
 * **Default OFF** — a budget of 0 (env unset) disables both the cap CHECK and the
 * usage RECORD for that kind, so a host that doesn't configure media budgets pays
 * zero overhead and sees no behaviour change. This module never throws; the caller
 * (`aiProvidersHost`) maps an over-budget result to its `AiProviderError` so this
 * module stays free of that dependency (no import cycle).
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('aiProviders.mediaBudget');

export type MediaKind = 'tts' | 'stt';

let storageRef: Storage | null = null;

/** ADR 0106 — the per-org budget OVERRIDE resolver, injected at bootstrap (a DI
 *  seam so this module never imports `governanceService` — no cross-module edge,
 *  no cycle). Returns the tenant's `mediaBudget` override (or null/absent ⇒ fall
 *  to the env default). A present field — INCLUDING `0` — overrides the env (0 =
 *  uncapped for that org). */
export type MediaBudgetOverrideResolver = (tenantId: string) => Promise<{ ttsChars?: number; sttBytes?: number } | null>;
let overrideResolver: MediaBudgetOverrideResolver | null = null;

/** Inject the durable store + (optionally) the per-org override resolver
 *  (called at bootstrap, next to `configureManagedProvider`). */
export function configureMediaBudget(input: { storage: Storage; resolveOverride?: MediaBudgetOverrideResolver }): void {
  storageRef = input.storage;
  overrideResolver = input.resolveOverride ?? null;
}

/** Reset for tests. */
export function _resetMediaBudgetForTest(): void {
  storageRef = null;
  overrideResolver = null;
}

/** Decoded byte count of a base64 string WITHOUT decoding it (~3/4 of the length,
 *  minus padding) — the cheap pre-flight size for an STT (transcription) input
 *  (ADR 0106 Phase 2). Used by the upload route to project against the budget. */
export function estimateMediaBytes(contentBase64: string): number {
  const len = contentBase64.length;
  if (len === 0) return 0;
  const padding = contentBase64.endsWith('==') ? 2 : contentBase64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

function envBudget(key: string): number {
  const raw = process.env[key];
  if (!raw) return 0;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The configured per-org daily budgets (0 ⇒ that kind is uncapped). */
export function mediaDailyBudget(): { tts: number; stt: number } {
  return {
    tts: envBudget('OPENWOP_MEDIA_DAILY_TTS_CHARS'),
    stt: envBudget('OPENWOP_MEDIA_DAILY_STT_BYTES'),
  };
}

/** Resolve a tenant's EFFECTIVE daily budgets: the per-org override (when set)
 *  wins over the env default, field by field. A present override field (incl. 0)
 *  is authoritative; an absent one falls through to env. Fail-soft — a resolver
 *  error logs and falls back to the env default (a governance-read outage must
 *  not block a paid media call). */
export async function resolveBudget(tenantId: string): Promise<{ tts: number; stt: number }> {
  const env = mediaDailyBudget();
  if (!overrideResolver || !tenantId) return env;
  let override: { ttsChars?: number; sttBytes?: number } | null = null;
  try {
    override = await overrideResolver(tenantId);
  } catch (err) {
    log.warn('media_budget_override_read_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return env;
  }
  return {
    tts: override?.ttsChars != null ? Math.max(0, Math.floor(override.ttsChars)) : env.tts,
    stt: override?.sttBytes != null ? Math.max(0, Math.floor(override.sttBytes)) : env.stt,
  };
}

/** UTC calendar day (YYYY-MM-DD) — the roll-up window, mirroring managed usage. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface MediaBudgetCheck {
  exceeded: boolean;
  /** The configured cap (0 ⇒ uncapped). */
  cap: number;
  /** Usage already accumulated today for this kind. */
  used: number;
  /** What the total would be if this call proceeds. */
  nextTotal: number;
  kind: MediaKind;
}

/**
 * Would a media call of `size` (chars for tts / decoded bytes for stt) push the
 * tenant over its daily budget? Returns `{ exceeded:false }` immediately when the
 * kind is uncapped (budget 0) or no store is configured. Fail-OPEN on a storage
 * read error (a usage-read outage must not block a paid feature the operator is
 * paying for) — logged for visibility.
 */
export async function checkMediaBudget(tenantId: string, kind: MediaKind, size: number): Promise<MediaBudgetCheck> {
  const resolved = await resolveBudget(tenantId);
  const cap = kind === 'tts' ? resolved.tts : resolved.stt;
  if (cap <= 0 || !storageRef || !tenantId) return { exceeded: false, cap, used: 0, nextTotal: size, kind };
  let used = 0;
  try {
    const usage = await storageRef.getMediaUsage(tenantId, todayUtc());
    used = kind === 'tts' ? usage.ttsChars : usage.sttBytes;
  } catch (err) {
    log.warn('media_budget_read_failed', { tenantId, kind, error: err instanceof Error ? err.message : String(err) });
    return { exceeded: false, cap, used: 0, nextTotal: size, kind }; // fail-open
  }
  const nextTotal = used + Math.max(0, size);
  return { exceeded: nextTotal > cap, cap, used, nextTotal, kind };
}

/**
 * Record `size` of media usage AFTER a successful dispatch (real figures, like
 * `emitCost`). No-op when the kind is uncapped (budget 0) or no store is
 * configured — so an off-by-default host writes nothing. Best-effort: a write
 * failure is logged, never thrown (it must not fail a call that already succeeded).
 */
export async function recordMediaUsage(tenantId: string, kind: MediaKind, size: number): Promise<void> {
  if (!storageRef || !tenantId || size <= 0) return;
  const resolved = await resolveBudget(tenantId);
  if ((kind === 'tts' ? resolved.tts : resolved.stt) <= 0) return; // uncapped for this org ⇒ don't accumulate
  try {
    await storageRef.incrementMediaUsage(
      tenantId,
      todayUtc(),
      kind === 'tts' ? Math.floor(size) : 0,
      kind === 'stt' ? Math.floor(size) : 0,
    );
  } catch (err) {
    log.warn('media_usage_record_failed', { tenantId, kind, error: err instanceof Error ? err.message : String(err) });
  }
}
