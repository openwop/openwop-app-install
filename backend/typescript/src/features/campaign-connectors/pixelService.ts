/**
 * Pixels + server-side conversions (ADR 0297 D1 — campaign-connectors growth,
 * NOT a new package). Two halves:
 *
 *  1. Pixel configs — per-org client-side pixel ids (Meta/Google/TikTok). The
 *     PUBLIC read is consent-gated at the route ('marketing' — ad pixels are
 *     marketing, not analytics) so an unconsented visitor never even learns
 *     which pixels a site runs.
 *  2. The conversions relay (CAPI) — a QUEUE with the privacy-critical halves
 *     done here: server-side SHA-256 hashing of the email identifier (the raw
 *     address is NEVER stored) and eventId dedup (a retried beacon can't
 *     double-fire). Dispatch to each platform's conversions API is injectable;
 *     the wired default is none — platform delivery rides the existing ads
 *     connector transports as the recorded follow-on (ADR 0297 D1), so queued
 *     rows are honest "accepted, not yet delivered" state, never a fake sent.
 */
import { createHash, randomUUID } from 'node:crypto';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { GOOGLE_CONVERSION_ACTION_RE } from '../../host/adsWire.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { isAllowed } from '../consent/consentService.js';
import { createLogger } from '../../observability/logger.js';

const consentLog = createLogger('features.campaign-connectors');

/**
 * ADR 0849 D4 (architect H4), hoisted here by ADR 0907 D7 (architect G2) so the
 * public intake AND the send-time re-check call ONE function: an unreadable
 * consent is NOT a grant. It answers like a refusal and says so in the log (the
 * ADR 0657 D5 / CNWF-6 shape) — the class only, since a storage message can
 * embed the row key.
 */
export async function marketingAllowedOrUnreadable(tenantId: string, vk: string, lane: 'pixels' | 'conversions' | 'conversions-send'): Promise<boolean | 'unreadable'> {
  try {
    return await isAllowed(tenantId, vk, 'marketing');
  } catch (err) {
    consentLog.warn('consent_unreadable', { tenantId, lane, error: err instanceof Error ? err.name : 'unknown' });
    return 'unreadable';
  }
}

export const PIXEL_PLATFORMS = ['meta', 'google', 'tiktok'] as const;
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number];

export interface PixelConfig {
  id: string; // `${tenantId}:${orgId}:${platform}`
  tenantId: string; orgId: string;
  platform: PixelPlatform;
  pixelId: string;
  active: boolean;
  /** Google ONLY (ADR 0907 D5): the Ads customer the conversions upload to. */
  googleCustomerId?: string;
  /** Google ONLY: relay event name → conversion action RESOURCE NAME
   *  (`customers/<cid>/conversionActions/<id>`). An event with no entry is
   *  never sent to Google — an event name is not a conversion action. */
  conversionActions?: Record<string, string>;
  updatedAt: string;
}

const pixels = new DurableCollection<PixelConfig>('campaign-connectors:pixel', (p) => p.id, undefined, (p) => p.tenantId);

export async function upsertPixel(tenantId: string, orgId: string, input: { platform: unknown; pixelId: unknown; active?: unknown; googleCustomerId?: unknown; conversionActions?: unknown }): Promise<PixelConfig> {
  const platform = String(input.platform ?? '');
  if (!(PIXEL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new OpenwopError('validation_error', `platform must be one of: ${PIXEL_PLATFORMS.join(', ')}`, 400, { field: 'platform' });
  }
  const pixelId = cleanString(input.pixelId, 100);
  if (!pixelId) throw new OpenwopError('validation_error', 'A pixelId is required.', 400, { field: 'pixelId' });
  let google: Pick<PixelConfig, 'googleCustomerId' | 'conversionActions'> = {};
  if (platform === 'google') {
    const prev = await pixels.get(`${tenantId}:${orgId}:google`).catch(() => undefined);
    const cid = input.googleCustomerId === undefined ? prev?.googleCustomerId : String(input.googleCustomerId ?? '').replace(/[^0-9]/g, '');
    if (cid !== undefined && cid !== '' && !/^[0-9]{10}$/.test(cid)) throw new OpenwopError('validation_error', 'googleCustomerId must be a 10-digit Google Ads customer id.', 400, { field: 'googleCustomerId' });
    let actions = prev?.conversionActions;
    if (input.conversionActions !== undefined) {
      if (input.conversionActions === null) actions = undefined;
      else {
        if (typeof input.conversionActions !== 'object' || Array.isArray(input.conversionActions)) throw new OpenwopError('validation_error', 'conversionActions must map event names to conversion action resource names.', 400, { field: 'conversionActions' });
        const entries = Object.entries(input.conversionActions as Record<string, unknown>);
        if (entries.length > 50) throw new OpenwopError('validation_error', 'At most 50 conversion actions.', 400, { field: 'conversionActions' });
        const out: Record<string, string> = {};
        for (const [name, rn] of entries) {
          const event = cleanString(name, 100);
          if (!event || typeof rn !== 'string' || !GOOGLE_CONVERSION_ACTION_RE.test(rn)) {
            throw new OpenwopError('validation_error', `"${String(name).slice(0, 40)}" must map to customers/<id>/conversionActions/<id>.`, 400, { field: 'conversionActions' });
          }
          out[event] = rn;
        }
        actions = Object.keys(out).length > 0 ? out : undefined;
      }
    }
    google = { ...(cid ? { googleCustomerId: cid } : {}), ...(actions ? { conversionActions: actions } : {}) };
  }
  const row: PixelConfig = {
    id: `${tenantId}:${orgId}:${platform}`, tenantId, orgId,
    platform: platform as PixelPlatform, pixelId,
    active: input.active !== false, ...google, updatedAt: new Date().toISOString(),
  };
  await pixels.put(row);
  return row;
}

export async function listPixels(tenantId: string, orgId: string): Promise<PixelConfig[]> {
  return (await pixels.listForTenantIndexed(tenantId)).filter((p) => p.orgId === orgId);
}

export async function removePixel(tenantId: string, orgId: string, platform: string): Promise<boolean> {
  const row = await pixels.get(`${tenantId}:${orgId}:${platform}`);
  if (!row || row.tenantId !== tenantId) return false;
  await pixels.delete(row.id);
  return true;
}

/** The consented public projection — platform + id only. */
export async function publicPixelsForOrg(tenantId: string, orgId: string): Promise<Array<{ platform: PixelPlatform; pixelId: string }>> {
  return (await listPixels(tenantId, orgId)).filter((p) => p.active).map((p) => ({ platform: p.platform, pixelId: p.pixelId }));
}

// ── the conversions relay queue ──────────────────────────────────────────────

export interface ConversionEvent {
  id: string; // `${tenantId}:${orgId}:${eventId}` — the dedup key
  tenantId: string; orgId: string;
  eventId: string;
  eventName: string;
  /** SHA-256 of the lowercased/trimmed email — the raw address never persists. */
  emailHash?: string;
  /** ADR 0907 D6 — SHA-256 of the E.164 digits without `+` (Meta/TikTok) and
   *  with `+` (Google). The raw phone never persists. */
  phoneHash?: string;
  phoneHashE164?: string;
  value?: number;
  currency?: string;
  visitor?: string;
  /** ADR 0907 D6 — match-quality signals. `ip` and `userAgent` are dropped the
   *  moment every target platform has the event (they live hours, not days). */
  ip?: string;
  userAgent?: string;
  fbc?: string;
  fbp?: string;
  ttclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  pageUrl?: string;
  at: string;
  /** `expired`: every remaining target refused it as too old (ADR 0907 D7) —
   *  terminal, never sent; `expiredFor` names the platforms. */
  status: 'queued' | 'sent' | 'expired';
  sentTo?: PixelPlatform[];
  expiredFor?: PixelPlatform[];
  expiredReason?: 'outside_platform_window';
  /** ADR 0907 D7 — the last delivery error per platform (the health card). */
  lastErrors?: Partial<Record<PixelPlatform, { error: string; at: string }>>;
}

const conversions = new DurableCollection<ConversionEvent>('campaign-connectors:conversion', (c) => c.id, undefined, (c) => c.tenantId);

// ADR 0907 D6 — the relay row's personal data, declared for erasure/export/
// masking. Entity-scoped (not global by field name): `ip`, `visitor` and the
// click-id names are common words elsewhere in the app.
declarePiiFields('campaign-connectors.conversion', [
  'emailHash', 'phoneHash', 'phoneHashE164', 'visitor', 'ip', 'userAgent', 'fbc', 'fbp', 'ttclid', 'gclid', 'gbraid', 'wbraid', 'pageUrl',
], { maskGloballyByFieldName: false });

// FM-D1-RET (ADR 0297 / grade-data) — conversion rows carry a pseudonymous
// emailHash + visitor key, so they ride the tenant's confidential-pii
// retention window (the intent-ledger pattern): purge on ingest age (`at` —
// relay rows are append-only, so create-age is the honest key).
registerRetentionPurger({
  feature: 'campaign-connectors-conversions',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('campaign-connectors-conversions', await conversions.list(), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.at, id: c.id }),
      (id) => conversions.delete(id));
  },
});

/**
 * ADR 0907 D8 — DSAR reach into the relay queue. A row addresses the subject when
 * its consent visitor key (`visitor`, the consent `subjectKey`) or its email hash
 * EXACTLY equals the key, or when the key is an email whose hash equals
 * `emailHash`. Exact match only: over-erasure is unrecoverable. Returns how many
 * rows were deleted and how many deletes did not take.
 */
export async function deleteSubjectConversions(tenantId: string, subjectKey: string): Promise<{ removed: number; failed: number }> {
  const out = { removed: 0, failed: 0 };
  const key = subjectKey.trim();
  if (!tenantId || !key) return out;
  const asEmailHash = key.includes('@') ? hashEmail(key) : undefined;
  const asPhone = hashPhone(key); // a phone-shaped key (ADR 0907 D6)
  for (const row of await conversions.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId) continue; // a stale index marker never reaches another tenant's row
    const hit = row.visitor === key || row.emailHash === key.toLowerCase() || (asEmailHash !== undefined && row.emailHash === asEmailHash)
      || (asPhone !== undefined && (row.phoneHash === asPhone.phoneHash || row.phoneHashE164 === asPhone.phoneHashE164));
    if (!hit) continue;
    if (await conversions.delete(row.id)) out.removed += 1; else out.failed += 1;
  }
  return out;
}

export function hashEmail(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
}

/** ADR 0907 D6 — normalise a phone to E.164 and hash it both ways. Only a number
 *  given in INTERNATIONAL form (`+` or `00` prefix, 8–15 digits) is accepted: a
 *  national number cannot be placed in a country without guessing, and a wrong
 *  guess sends someone else's hash. */
export function hashPhone(raw: string): { phoneHash: string; phoneHashE164: string } | undefined {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  const m = /^(?:\+|00)([1-9][0-9]{7,14})$/.exec(compact);
  if (!m) return undefined;
  const digits = m[1]!;
  return {
    phoneHash: createHash('sha256').update(digits).digest('hex'),
    phoneHashE164: createHash('sha256').update(`+${digits}`).digest('hex'),
  };
}

const CLICK_ID_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const FBC_RE = /^fb\.1\.[0-9]{10,16}\.[A-Za-z0-9._~-]{1,256}$/;
const FBP_RE = /^fb\.1\.[0-9]{10,16}\.[0-9]{1,20}$/;
const DAY_MS = 86_400_000;

/** `fbc` per Meta's format `fb.1.<click-ms>.<fbclid>`, built from the CLICK time
 *  the site recorded (never "now" — MyndHyve wart 7), or taken verbatim from a
 *  well-formed `_fbc` cookie value. A click time in the future or older than
 *  Meta's 90-day window is refused. */
export function buildFbc(input: { fbc?: unknown; fbclid?: unknown; fbclidAt?: unknown }, nowMs = Date.now()): string | undefined {
  if (typeof input.fbc === 'string' && FBC_RE.test(input.fbc)) return input.fbc;
  if (typeof input.fbclid !== 'string' || !CLICK_ID_RE.test(input.fbclid)) return undefined;
  const at = typeof input.fbclidAt === 'number' ? input.fbclidAt : Number(input.fbclidAt);
  if (!Number.isInteger(at) || at > nowMs || at < nowMs - 90 * DAY_MS) return undefined;
  return `fb.1.${at}.${input.fbclid}`;
}

/** Accept one conversion for relay. Dedup by (org, eventId): a re-post of the
 *  same eventId returns the existing row untouched. */
export async function relayConversion(tenantId: string, orgId: string, input: {
  eventId?: unknown; eventName: unknown; email?: unknown; value?: unknown; currency?: unknown; visitor?: unknown;
  /** ADR 0907 D6 — from the request body (the site's beacon). */
  phone?: unknown; fbc?: unknown; fbclid?: unknown; fbclidAt?: unknown; fbp?: unknown;
  ttclid?: unknown; gclid?: unknown; gbraid?: unknown; wbraid?: unknown; pageUrl?: unknown;
  /** From the REQUEST (trusted-proxy client address, ADR 0851; the UA header) — never the body. */
  ip?: string; userAgent?: string;
}): Promise<{ event: ConversionEvent; deduped: boolean }> {
  const eventName = cleanString(input.eventName, 100);
  if (!eventName) throw new OpenwopError('validation_error', 'An eventName is required.', 400, { field: 'eventName' });
  const eventId = cleanString(input.eventId, 100) || randomUUID();
  const id = `${tenantId}:${orgId}:${eventId}`;
  const existing = await conversions.get(id);
  if (existing && existing.tenantId === tenantId) return { event: existing, deduped: true };
  const email = typeof input.email === 'string' && input.email.trim() ? input.email : undefined;
  const phone = typeof input.phone === 'string' ? hashPhone(input.phone) : undefined;
  const value = Number(input.value);
  const clickId = (v: unknown): string | undefined => (typeof v === 'string' && CLICK_ID_RE.test(v) ? v : undefined);
  const fbc = buildFbc(input);
  const fbp = typeof input.fbp === 'string' && FBP_RE.test(input.fbp) ? input.fbp : undefined;
  const pageUrl = typeof input.pageUrl === 'string' && /^https?:\/\//i.test(input.pageUrl) ? input.pageUrl.slice(0, 1024) : undefined;
  const ids = { ttclid: clickId(input.ttclid), gclid: clickId(input.gclid), gbraid: clickId(input.gbraid), wbraid: clickId(input.wbraid) };
  const row: ConversionEvent = {
    id, tenantId, orgId, eventId, eventName,
    ...(email ? { emailHash: hashEmail(email) } : {}),
    ...(phone ?? {}),
    ...(input.ip && input.ip !== 'unknown' ? { ip: input.ip.slice(0, 64) } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 512) } : {}),
    ...(fbc ? { fbc } : {}),
    ...(fbp ? { fbp } : {}),
    ...Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== undefined)),
    ...(pageUrl ? { pageUrl } : {}),
    ...(Number.isFinite(value) && value >= 0 ? { value } : {}),
    ...(typeof input.currency === 'string' && input.currency.trim() ? { currency: input.currency.trim().slice(0, 8).toUpperCase() } : {}),
    ...(typeof input.visitor === 'string' && input.visitor.trim() ? { visitor: input.visitor.trim().slice(0, 128) } : {}),
    at: new Date().toISOString(),
    status: 'queued',
  };
  await conversions.put(row);
  return { event: row, deduped: false };
}

export type ConversionTransport = (platform: PixelPlatform, event: ConversionEvent) => Promise<void>;

/** ADR 0907 D7 — the per-row send decision taken just before sending:
 *  `send`, `drop` (delete the row — e.g. consent withdrawn) or `hold` (leave it
 *  queued — e.g. consent unreadable right now). */
export type ConversionAdmission = 'send' | 'drop' | 'hold';
export interface DispatchOutcome { sent: number; dropped: number; held: number; expired: number }

/** Dispatch queued conversions through an injected transport to every ACTIVE
 *  pixel platform of the org. No transport (the wired v1 default) leaves rows
 *  honestly queued. Returns how many rows were marked sent. */
export interface DispatchOptions {
  platforms?: readonly PixelPlatform[];
  /** ADR 0907 D5 — whether a platform can take THIS row at all (Google needs a
   *  mapped conversion action and a click id or identifier). A platform that
   *  cannot is not a target for the row, so it never wedges the queue. */
  applies?: (platform: PixelPlatform, row: ConversionEvent) => boolean;
  /** ADR 0907 D7 — the send-time decision (consent re-check). Absent = send. */
  admit?: (row: ConversionEvent) => Promise<ConversionAdmission>;
  /** ADR 0907 D7 — the platform no longer accepts a row this old. That
   *  platform is not sent to; a row whose every remaining target is expired
   *  becomes `expired` (terminal). */
  expired?: (platform: PixelPlatform, row: ConversionEvent) => boolean;
}

export async function dispatchQueuedConversions(tenantId: string, orgId: string, transport: ConversionTransport | null, opts: DispatchOptions = {}): Promise<number> {
  return (await dispatchQueuedConversionsDetailed(tenantId, orgId, transport, opts)).sent;
}

export async function dispatchQueuedConversionsDetailed(tenantId: string, orgId: string, transport: ConversionTransport | null, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
  const out: DispatchOutcome = { sent: 0, dropped: 0, held: 0, expired: 0 };
  if (!transport) return out;
  let targets = (await publicPixelsForOrg(tenantId, orgId)).map((p) => p.platform);
  // Platform filter (ADR 0297 D1 follow-on): conversions APIs are wired for a
  // SUBSET of pixel platforms — unfiltered targets would leave rows queued
  // forever behind an unsupported platform.
  if (opts.platforms) targets = targets.filter((p) => opts.platforms!.includes(p));
  if (targets.length === 0) return out;
  for (const row of (await conversions.listForTenantIndexed(tenantId)).filter((c) => c.orgId === orgId && c.status === 'queued')) {
    const admission = opts.admit ? await opts.admit(row) : 'send';
    if (admission === 'drop') {
      if (await conversions.delete(row.id)) out.dropped += 1;
      continue;
    }
    if (admission === 'hold') { out.held += 1; continue; }
    // Resume from prior partial deliveries (grade-code GC-D1-1): platforms that
    // already accepted this event are SKIPPED on retry — never double-fired.
    const delivered = new Set<PixelPlatform>(row.sentTo ?? []);
    const rowTargets = opts.applies ? targets.filter((p) => opts.applies!(p, row)) : targets;
    const lastErrors = { ...(row.lastErrors ?? {}) };
    const tooOld = new Set(rowTargets.filter((p) => !delivered.has(p) && opts.expired?.(p, row)));
    for (const platform of rowTargets) {
      if (delivered.has(platform) || tooOld.has(platform)) continue;
      try { await transport(platform, row); delivered.add(platform); delete lastErrors[platform]; }
      catch (err) { lastErrors[platform] = { error: (err instanceof Error ? err.message : String(err)).slice(0, 200), at: new Date().toISOString() }; }
    }
    const sentTo = [...delivered];
    const errorsChanged = JSON.stringify(lastErrors) !== JSON.stringify(row.lastErrors ?? {});
    if (tooOld.size > 0 && rowTargets.every((t) => delivered.has(t) || tooOld.has(t))) {
      // Terminal: what could be delivered was, the rest is past its window.
      const { ip: _ip, userAgent: _ua, lastErrors: _le, ...rest } = row;
      await conversions.put({ ...rest, status: 'expired', sentTo, expiredFor: [...tooOld], expiredReason: 'outside_platform_window' });
      out.expired += 1;
    } else if (rowTargets.every((t) => delivered.has(t))) {
      // ADR 0907 D6 — every target has the event: the IP and user agent served
      // their purpose (match quality) and are dropped now, not at retention.
      const { ip: _ip, userAgent: _ua, lastErrors: _le, ...rest } = row;
      await conversions.put({ ...rest, status: 'sent', sentTo });
      out.sent += 1;
    } else if (sentTo.length !== (row.sentTo ?? []).length || errorsChanged) {
      // Persist partial progress and the latest error, stay queued.
      const { lastErrors: _prev, ...rest } = row;
      await conversions.put({ ...rest, sentTo, ...(Object.keys(lastErrors).length > 0 ? { lastErrors } : {}) });
    }
  }
  return out;
}

export async function listConversions(tenantId: string, orgId: string, limit = 200): Promise<ConversionEvent[]> {
  return (await conversions.listForTenantIndexed(tenantId))
    .filter((c) => c.orgId === orgId)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Test-only. */
export async function __resetPixels(): Promise<void> {
  for (const p of await pixels.list()) await pixels.delete(p.id);
  for (const c of await conversions.list()) await conversions.delete(c.id);
}
