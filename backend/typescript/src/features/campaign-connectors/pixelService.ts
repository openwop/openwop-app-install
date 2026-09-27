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

export const PIXEL_PLATFORMS = ['meta', 'google', 'tiktok'] as const;
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number];

export interface PixelConfig {
  id: string; // `${tenantId}:${orgId}:${platform}`
  tenantId: string; orgId: string;
  platform: PixelPlatform;
  pixelId: string;
  active: boolean;
  updatedAt: string;
}

const pixels = new DurableCollection<PixelConfig>('campaign-connectors:pixel', (p) => p.id, undefined, (p) => p.tenantId);

export async function upsertPixel(tenantId: string, orgId: string, input: { platform: unknown; pixelId: unknown; active?: unknown }): Promise<PixelConfig> {
  const platform = String(input.platform ?? '');
  if (!(PIXEL_PLATFORMS as readonly string[]).includes(platform)) {
    throw new OpenwopError('validation_error', `platform must be one of: ${PIXEL_PLATFORMS.join(', ')}`, 400, { field: 'platform' });
  }
  const pixelId = cleanString(input.pixelId, 100);
  if (!pixelId) throw new OpenwopError('validation_error', 'A pixelId is required.', 400, { field: 'pixelId' });
  const row: PixelConfig = {
    id: `${tenantId}:${orgId}:${platform}`, tenantId, orgId,
    platform: platform as PixelPlatform, pixelId,
    active: input.active !== false, updatedAt: new Date().toISOString(),
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
  value?: number;
  currency?: string;
  visitor?: string;
  at: string;
  status: 'queued' | 'sent';
  sentTo?: PixelPlatform[];
}

const conversions = new DurableCollection<ConversionEvent>('campaign-connectors:conversion', (c) => c.id, undefined, (c) => c.tenantId);

// FM-D1-RET (ADR 0297 / grade-data) — conversion rows carry a pseudonymous
// emailHash + visitor key, so they ride the tenant's confidential-pii
// retention window (the intent-ledger pattern): purge on ingest age (`at` —
// relay rows are append-only, so create-age is the honest key).
registerRetentionPurger({
  feature: 'campaign-connectors-conversions',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('campaign-connectors-conversions', await conversions.list(), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.at, id: c.id }),
      (id) => conversions.delete(id));
  },
});

export function hashEmail(raw: string): string {
  return createHash('sha256').update(raw.trim().toLowerCase()).digest('hex');
}

/** Accept one conversion for relay. Dedup by (org, eventId): a re-post of the
 *  same eventId returns the existing row untouched. */
export async function relayConversion(tenantId: string, orgId: string, input: {
  eventId?: unknown; eventName: unknown; email?: unknown; value?: unknown; currency?: unknown; visitor?: unknown;
}): Promise<{ event: ConversionEvent; deduped: boolean }> {
  const eventName = cleanString(input.eventName, 100);
  if (!eventName) throw new OpenwopError('validation_error', 'An eventName is required.', 400, { field: 'eventName' });
  const eventId = cleanString(input.eventId, 100) || randomUUID();
  const id = `${tenantId}:${orgId}:${eventId}`;
  const existing = await conversions.get(id);
  if (existing && existing.tenantId === tenantId) return { event: existing, deduped: true };
  const email = typeof input.email === 'string' && input.email.trim() ? input.email : undefined;
  const value = Number(input.value);
  const row: ConversionEvent = {
    id, tenantId, orgId, eventId, eventName,
    ...(email ? { emailHash: hashEmail(email) } : {}),
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

/** Dispatch queued conversions through an injected transport to every ACTIVE
 *  pixel platform of the org. No transport (the wired v1 default) leaves rows
 *  honestly queued. Returns how many rows were marked sent. */
export async function dispatchQueuedConversions(tenantId: string, orgId: string, transport: ConversionTransport | null, opts: { platforms?: readonly PixelPlatform[] } = {}): Promise<number> {
  if (!transport) return 0;
  let targets = (await publicPixelsForOrg(tenantId, orgId)).map((p) => p.platform);
  // Platform filter (ADR 0297 D1 follow-on): conversions APIs are wired for a
  // SUBSET of pixel platforms — unfiltered targets would leave rows queued
  // forever behind an unsupported platform.
  if (opts.platforms) targets = targets.filter((p) => opts.platforms!.includes(p));
  if (targets.length === 0) return 0;
  let sent = 0;
  for (const row of (await conversions.listForTenantIndexed(tenantId)).filter((c) => c.orgId === orgId && c.status === 'queued')) {
    // Resume from prior partial deliveries (grade-code GC-D1-1): platforms that
    // already accepted this event are SKIPPED on retry — never double-fired.
    const delivered = new Set<PixelPlatform>(row.sentTo ?? []);
    for (const platform of targets) {
      if (delivered.has(platform)) continue;
      try { await transport(platform, row); delivered.add(platform); } catch { /* keep queued for the rest */ }
    }
    const sentTo = [...delivered];
    if (targets.every((t) => delivered.has(t))) {
      await conversions.put({ ...row, status: 'sent', sentTo });
      sent += 1;
    } else if (sentTo.length !== (row.sentTo ?? []).length) {
      await conversions.put({ ...row, sentTo }); // persist partial progress, stay queued
    }
  }
  return sent;
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
