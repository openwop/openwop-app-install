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
import { managedUsageBucket } from '../providers/managedUsageScope.js';
import type { Storage } from '../storage/storage.js';
import { DurableCollection } from '../host/hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('aiProviders.mediaBudget');

export type MediaKind = 'tts' | 'stt' | 'images' | 'video';

let storageRef: Storage | null = null;

/** ADR 0106 — the per-org budget OVERRIDE resolver, injected at bootstrap (a DI
 *  seam so this module never imports `governanceService` — no cross-module edge,
 *  no cycle). Returns the tenant's `mediaBudget` override (or null/absent ⇒ fall
 *  to the env default). A present field — INCLUDING `0` — overrides the env (0 =
 *  uncapped for that org; for VIDEO, 0 = paid video off and `'unlimited'` is
 *  uncapped — ADR 1051). */
export type MediaBudgetOverrideResolver = (tenantId: string) => Promise<{ ttsChars?: number; sttBytes?: number; images?: number; videoJobs?: VideoBudgetSetting } | null>;

/** ADR 1051 — a video cap as configured: a unit count, or the explicit word
 *  `unlimited`. `0` means paid video is DISABLED, never uncapped (zero-means-
 *  unlimited is a known foot-gun in this codebase). */
export type VideoBudgetSetting = number | 'unlimited';
/** ADR 1051 — the shipped video cap when the env names none: 10 units per tenant
 *  per UTC day (an avatar job weighs 1, a frontier text/image-to-video job 3). */
export const DEFAULT_DAILY_VIDEO_UNITS = 10;
/** The in-memory form of `unlimited` (never serialised: see `videoBudgetWire`). */
const UNLIMITED = Number.POSITIVE_INFINITY;
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

/** ADR 0401 P4 — the images unit converges here from the retired
 *  `host/imageGenBudget.ts`. Env default stays `OPENWOP_IMAGE_MAX_PER_DAY`
 *  (DEFAULT **50** — unlike tts/stt this kind ships capped, the ADR 0115
 *  posture carried over; 0/negative ⇒ uncapped). */
function imagesEnvBudget(): number {
  const raw = process.env.OPENWOP_IMAGE_MAX_PER_DAY;
  if (raw === undefined || raw === '') return 50;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** ADR 1051 — `OPENWOP_MEDIA_DAILY_VIDEO_JOBS`: unset ⇒ the shipped default;
 *  `unlimited` ⇒ uncapped; a non-negative integer ⇒ that many units, where `0`
 *  DISABLES paid video. Anything else is a misconfiguration, read as the default
 *  (never as uncapped). */
function videoEnvBudget(): number {
  const raw = (process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS ?? '').trim();
  if (raw === '') return DEFAULT_DAILY_VIDEO_UNITS;
  if (raw.toLowerCase() === 'unlimited') return UNLIMITED;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    log.warn('media_video_budget_env_invalid', { value: raw, using: DEFAULT_DAILY_VIDEO_UNITS });
    return DEFAULT_DAILY_VIDEO_UNITS;
  }
  return Math.floor(v);
}

/** A video cap for the wire: the count, or `'unlimited'` (JSON has no Infinity). */
export function videoBudgetWire(cap: number): VideoBudgetSetting {
  return cap === UNLIMITED ? 'unlimited' : cap;
}

/** The configured per-org daily budgets. tts/stt/images: 0 ⇒ uncapped (their
 *  long-standing convention). video (ADR 1051): 0 ⇒ DISABLED, `Infinity` ⇒ the
 *  explicit `unlimited`, unset ⇒ {@link DEFAULT_DAILY_VIDEO_UNITS}. */
export function mediaDailyBudget(): { tts: number; stt: number; images: number; video: number } {
  return {
    tts: envBudget('OPENWOP_MEDIA_DAILY_TTS_CHARS'),
    stt: envBudget('OPENWOP_MEDIA_DAILY_STT_BYTES'),
    images: imagesEnvBudget(),
    video: videoEnvBudget(),
  };
}

/** Resolve a tenant's EFFECTIVE daily budgets: the per-org override (when set)
 *  wins over the env default, field by field. A present override field (incl. 0)
 *  is authoritative; an absent one falls through to env. Fail-soft — a resolver
 *  error logs and falls back to the env default (a governance-read outage must
 *  not block a paid media call). */
export async function resolveBudget(tenantId: string): Promise<{ tts: number; stt: number; images: number; video: number }> {
  const env = mediaDailyBudget();
  if (!overrideResolver || !tenantId) return env;
  let override: { ttsChars?: number; sttBytes?: number; images?: number; videoJobs?: VideoBudgetSetting } | null = null;
  try {
    override = await overrideResolver(tenantId);
  } catch (err) {
    log.warn('media_budget_override_read_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return env;
  }
  return {
    tts: override?.ttsChars != null ? Math.max(0, Math.floor(override.ttsChars)) : env.tts,
    stt: override?.sttBytes != null ? Math.max(0, Math.floor(override.sttBytes)) : env.stt,
    images: override?.images != null ? Math.max(0, Math.floor(override.images)) : env.images,
    // ADR 1051 — the same rule as the env: `unlimited` is explicit, `0` disables.
    video: override?.videoJobs === 'unlimited' ? UNLIMITED
      : typeof override?.videoJobs === 'number' ? Math.max(0, Math.floor(override.videoJobs)) : env.video,
  };
}

/** Resolve the effective cap for a kind. */
function capForKind(resolved: { tts: number; stt: number; images: number; video: number }, kind: MediaKind): number {
  return kind === 'tts' ? resolved.tts : kind === 'stt' ? resolved.stt : kind === 'images' ? resolved.images : resolved.video;
}

// ── The images counter (ADR 0401 P4, absorbed from host/imageGenBudget.ts) ───
// KV daily count, NOT a media_usage SQL column — the kb embed-budget precedent
// (a count does not justify a 2-adapter storage migration; ADR correction).
// Collection name + key shape unchanged (`imagegen:budget`, `${tenant}:${day}`)
// so existing rows, the GEN-6 tenant purge, and the GEN-1b fold keep working.
interface ImageCount { key: string; tenantId: string; count: number }
const imageCounts = new DurableCollection<ImageCount>('imagegen:budget', (c) => c.key);

async function imagesUsedToday(tenantId: string): Promise<number> {
  return (await imageCounts.get(`${tenantId}:${todayUtc()}`))?.count ?? 0;
}

async function recordImagesUsed(tenantId: string, n: number): Promise<void> {
  const key = `${tenantId}:${todayUtc()}`;
  // MKP-3: atomic increment via bounded CAS — best-effort post-success
  // accounting; on contention exhaustion, under-count rather than throw.
  for (let attempt = 0; attempt < 12; attempt++) {
    const existing = await imageCounts.get(key);
    const next: ImageCount = { key, tenantId, count: (existing?.count ?? 0) + n };
    if (await imageCounts.compareAndSwap(existing ?? null, next)) return;
  }
}

// ── The video counter (ADR 0404) — KV daily job count, the images precedent
// (a count does not justify an SQL migration). Video is metered per JOB. ──
interface VideoCount { key: string; tenantId: string; count: number }
const videoCounts = new DurableCollection<VideoCount>('creative-video:budget', (c) => c.key);

async function videoUsedToday(tenantId: string): Promise<number> {
  return (await videoCounts.get(`${tenantId}:${todayUtc()}`))?.count ?? 0;
}

async function recordVideoUsed(tenantId: string, n: number): Promise<void> {
  const key = `${tenantId}:${todayUtc()}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const existing = await videoCounts.get(key);
    const next: VideoCount = { key, tenantId, count: (existing?.count ?? 0) + n };
    if (await videoCounts.compareAndSwap(existing ?? null, next)) return;
  }
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
  /** Head-room under the cap (Infinity when uncapped) — the images path clamps
   *  its request count by this. */
  remaining: number;
  /** ADR 1051 — video only: the cap is `0`, i.e. paid video is switched off. */
  disabled?: boolean;
}

/**
 * Would a media call of `size` (chars for tts / decoded bytes for stt) push the
 * tenant over its daily budget? Returns `{ exceeded:false }` immediately when the
 * kind is uncapped (budget 0) or no store is configured. Fail-OPEN on a storage
 * read error (a usage-read outage must not block a paid feature the operator is
 * paying for) — logged for visibility.
 */
export async function checkMediaBudget(tenantId: string, kind: MediaKind, size: number, actingSubject?: string): Promise<MediaBudgetCheck> {
  const resolved = await resolveBudget(tenantId);
  const cap = capForKind(resolved, kind);
  // ADR 1051 — video: `0` is DISABLED (refuse), `unlimited` is uncapped.
  if (kind === 'video') {
    if (cap === UNLIMITED || !tenantId) return { exceeded: false, cap, used: 0, nextTotal: size, kind, remaining: Infinity };
    if (cap <= 0) return { exceeded: true, cap: 0, used: 0, nextTotal: Math.max(0, size), kind, remaining: 0, disabled: true };
  }
  // images + video counters are KV-backed (no storageRef needed); tts/stt ride media_usage.
  const kvBacked = kind === 'images' || kind === 'video';
  if (cap <= 0 || !tenantId || (!kvBacked && !storageRef)) {
    return { exceeded: false, cap, used: 0, nextTotal: size, kind, remaining: Infinity };
  }
  let used = 0;
  try {
    if (kind === 'images') {
      used = await imagesUsedToday(tenantId);
    } else if (kind === 'video') {
      used = await videoUsedToday(tenantId);
    } else {
      // ADR 0693 phase 3 — read the same bucket the charge is written to. A
      // personal tenant's bucket IS the tenant, so this is byte-identical there;
      // a shared workspace gets the acting participant's own allowance instead
      // of one pooled across everyone in it. images/video are NOT routed: they
      // use separate counters (`imagesUsedToday`/`videoUsedToday`), so they
      // never touched `getMediaUsage` and phase 3 does not reach them.
      const usage = await storageRef!.getMediaUsage(managedUsageBucket(tenantId, actingSubject), todayUtc());
      used = kind === 'tts' ? usage.ttsChars : usage.sttBytes;
    }
  } catch (err) {
    log.warn('media_budget_read_failed', { tenantId, kind, error: err instanceof Error ? err.message : String(err) });
    // Video is the MOST EXPENSIVE kind — fail CLOSED on a usage-read outage so a read
    // blip can't wave through unlimited paid renders (ADR 0404 grade-code CV-4). The
    // cheaper kinds fail-open (a read outage must not block a paid feature the
    // operator is paying for).
    if (kind === 'video') return { exceeded: true, cap, used: cap, nextTotal: cap + Math.max(0, size), kind, remaining: 0 };
    return { exceeded: false, cap, used: 0, nextTotal: size, kind, remaining: Infinity }; // fail-open
  }
  const nextTotal = used + Math.max(0, size);
  return { exceeded: nextTotal > cap, cap, used, nextTotal, kind, remaining: Math.max(0, cap - used) };
}

/**
 * Record `size` of media usage AFTER a successful dispatch (real figures, like
 * `emitCost`). No-op when the kind is uncapped (budget 0) or no store is
 * configured — so an off-by-default host writes nothing. Best-effort: a write
 * failure is logged, never thrown (it must not fail a call that already succeeded).
 */
export async function recordMediaUsage(tenantId: string, kind: MediaKind, size: number, actingSubject?: string): Promise<void> {
  if (!tenantId || size <= 0) return;
  const resolved = await resolveBudget(tenantId);
  const cap = capForKind(resolved, kind);
  if (cap <= 0 || cap === UNLIMITED) return; // uncapped (or, for video, disabled) ⇒ don't accumulate
  if (kind === 'images') {
    await recordImagesUsed(tenantId, Math.floor(size));
    return;
  }
  if (kind === 'video') {
    await recordVideoUsed(tenantId, Math.floor(size));
    return;
  }
  if (!storageRef) return;
  try {
    await storageRef.incrementMediaUsage(
      // ADR 0693 phase 3 — same bucket as the cap read above. Reading one and
      // writing the other would cap a participant on a total they never accrued.
      managedUsageBucket(tenantId, actingSubject),
      todayUtc(),
      kind === 'tts' ? Math.floor(size) : 0,
      kind === 'stt' ? Math.floor(size) : 0,
    );
  } catch (err) {
    log.warn('media_usage_record_failed', { tenantId, kind, error: err instanceof Error ? err.message : String(err) });
  }
}

/** ADR 1051 — today's video units, read from the counter whatever the cap says
 *  (the governance panel's usage line; `checkMediaBudget` short-circuits to 0
 *  when the cap is off or unlimited). */
export async function videoUnitsUsedToday(tenantId: string): Promise<number> {
  try { return await videoUsedToday(tenantId); } catch { return 0; }
}

// ── ADR 1051 D3 — reserve video units BEFORE the paid call ──────────────────

/** What a video reservation took, so its release touches exactly that: the UTC
 *  day it was counted on and the units, and whether a counter moved at all (an
 *  `unlimited` cap reserves without counting). Persisted on the job row. */
export interface VideoReservation {
  dayKey: string;
  units: number;
  counted: boolean;
}

export type VideoReserveResult =
  | { ok: true; token: VideoReservation }
  | { ok: false; reason: 'disabled' | 'exceeded'; cap: number; used: number };

/**
 * Atomically take `units` of today's video budget, or refuse. One bounded CAS
 * loop increments the counter only while `used + units ≤ cap`, so concurrent
 * callers can never overshoot together (the check-then-record shape it replaces
 * let all of them through). Fails CLOSED: a read error or an exhausted loop is
 * `exceeded`, never a pass — video is the most expensive kind.
 */
export async function reserveMediaBudget(tenantId: string, kind: 'video', units: number): Promise<VideoReserveResult> {
  const n = Math.max(1, Math.floor(units));
  const dayKey = `${tenantId}:${todayUtc()}`;
  const cap = capForKind(await resolveBudget(tenantId), kind);
  if (cap === UNLIMITED) return { ok: true, token: { dayKey, units: n, counted: false } };
  if (cap <= 0) return { ok: false, reason: 'disabled', cap: 0, used: 0 };
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const existing = await videoCounts.get(dayKey);
      const used = existing?.count ?? 0;
      if (used + n > cap) return { ok: false, reason: 'exceeded', cap, used };
      const next: VideoCount = { key: dayKey, tenantId, count: used + n };
      if (await videoCounts.compareAndSwap(existing ?? null, next)) return { ok: true, token: { dayKey, units: n, counted: true } };
    }
  } catch (err) {
    log.warn('media_budget_reserve_failed', { tenantId, kind, error: err instanceof Error ? err.message : String(err) });
  }
  return { ok: false, reason: 'exceeded', cap, used: cap };
}

/**
 * Give a reservation back — ONLY for an outcome where the provider provably did
 * not take the job. Decrements exactly the reserved day by exactly the reserved
 * units (a release after midnight never credits the new day), never below 0, and
 * never touches a counter the reservation did not move. Best-effort: a failed
 * release over-counts (the safe direction) and is logged.
 */
export async function releaseMediaBudget(token: VideoReservation): Promise<void> {
  if (!token.counted) return;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const existing = await videoCounts.get(token.dayKey);
      if (!existing) return;
      const next: VideoCount = { ...existing, count: Math.max(0, existing.count - token.units) };
      if (await videoCounts.compareAndSwap(existing, next)) return;
    }
  } catch (err) {
    log.warn('media_budget_release_failed', { dayKey: token.dayKey, error: err instanceof Error ? err.message : String(err) });
  }
}
