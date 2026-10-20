/**
 * ADR 0907 D5/D7 — the ONE conversion-delivery path. The manual dispatch route
 * and the scheduled dispatch node both call `deliverQueuedConversions`, so
 * which platforms receive a row, how a row maps onto each platform's API, and
 * (P4) the send-time consent re-check cannot drift between the two callers.
 *
 * Targets are the org's ACTIVE pixels on a platform whose conversion sender is
 * honest-ON (`adsSenderEnabled`, D2). Per row, a platform applies only when it
 * can take that row: Google needs a conversion action mapped for the event
 * name and a click id or hashed identifier. A row is `sent` when every
 * applicable target has it; until then it stays queued and a retry resumes
 * where it stopped (never double-fires a platform).
 *
 * D7 — consent is RE-CHECKED at send, not only at intake: a row can sit queued
 * for an hour, and the visitor may withdraw marketing consent (or be erased) in
 * between. Withdrawn ⇒ the row is DROPPED, nothing sent. Unreadable, or a row
 * with no visitor key to check ⇒ the row is HELD (not sent, not lost) and the
 * next run asks again. The check is `marketingAllowedOrUnreadable`, the same
 * function the public intake calls.
 */
import type { AdsAdapter } from '../../host/adsAdapter.js';
import { adsSenderEnabled, conversionOutsideWindow, type GoogleConsent } from '../../host/adsWire.js';
import {
  dispatchQueuedConversionsDetailed, listPixels, listConversions, marketingAllowedOrUnreadable,
  type ConversionAdmission, type ConversionEvent, type DispatchOutcome, type PixelConfig, type PixelPlatform,
} from './pixelService.js';

/** ADR 0907 D7 — the sub-toggle the SCHEDULED delivery node checks (off by default). */
export const SCHEDULED_CONVERSIONS_TOGGLE = 'campaign-connectors.scheduled-conversions';

/** Platforms with a wired conversions API (LinkedIn's is ADR 0907 P5, not built). */
export const CONVERSION_PLATFORMS: readonly PixelPlatform[] = ['meta', 'tiktok', 'google'];

/** The conversion senders that may send right now. */
export const enabledConversionPlatforms = (): PixelPlatform[] => CONVERSION_PLATFORMS.filter((p) => adsSenderEnabled(p));

/** Google's EEA consent signals for a row. A row exists only because the
 *  visitor granted MARKETING consent at intake, which in this app covers both
 *  sharing user data for ads and ad personalisation (ad pixels are marketing). */
const GRANTED: GoogleConsent = { adUserData: 'GRANTED', adPersonalization: 'GRANTED' };

/** Can `platform` take this row at all? */
export function conversionApplies(platform: PixelPlatform, row: ConversionEvent, pixel: PixelConfig | undefined): boolean {
  if (!pixel || !pixel.active) return false;
  if (platform !== 'google') return true;
  const action = pixel.conversionActions?.[row.eventName];
  return !!pixel.googleCustomerId && !!action && !!(row.gclid || row.gbraid || row.wbraid || row.emailHash || row.phoneHashE164);
}

/** The send-time consent decision for one row (D7). */
export async function admitByConsent(tenantId: string, row: ConversionEvent): Promise<ConversionAdmission> {
  if (!row.visitor) return 'hold'; // nothing to check against — never send unverified
  const allowed = await marketingAllowedOrUnreadable(tenantId, row.visitor, 'conversions-send');
  return allowed === true ? 'send' : allowed === 'unreadable' ? 'hold' : 'drop';
}

export async function deliverQueuedConversions(adapter: AdsAdapter, tenantId: string, orgId: string): Promise<DispatchOutcome> {
  const pixels = new Map((await listPixels(tenantId, orgId)).filter((p) => p.active).map((p) => [p.platform, p]));
  const transport = async (platform: PixelPlatform, event: ConversionEvent): Promise<void> => {
    const pixel = pixels.get(platform);
    if (!pixel) throw new Error('no_pixel');
    const { id: _id, tenantId: _t, orgId: _o, at, status: _s, sentTo: _st, visitor: _v, ...signals } = event;
    const google = platform === 'google' && pixel.googleCustomerId && pixel.conversionActions?.[event.eventName]
      ? { google: { customerId: pixel.googleCustomerId, conversionAction: pixel.conversionActions[event.eventName]! }, consent: GRANTED }
      : {};
    const out = await adapter.sendConversion({ ...signals, platform, pixelId: pixel.pixelId, eventTimeIso: at, ...google });
    if (out.outcome !== 'sent') throw new Error(out.outcome === 'failed' ? out.error : out.outcome);
  };
  return dispatchQueuedConversionsDetailed(tenantId, orgId, transport, {
    platforms: enabledConversionPlatforms(),
    applies: (platform, row) => conversionApplies(platform, row, pixels.get(platform)),
    admit: (row) => admitByConsent(tenantId, row),
    // A backlog older than the platform's window is never flushed to it.
    expired: (platform, row) => conversionOutsideWindow(platform, row.at),
  });
}

/** ADR 0907 D7 — the conversions health card's read model. Counts are over the
 *  rows the queue read returns (newest 200, the list route's bound); `capped`
 *  says when that bound was hit so the card never claims an exact total. */
export interface ConversionHealth {
  queued: number;
  sent: number;
  /** Rows marked `expired` — older than every remaining platform's window. */
  expired: number;
  capped: boolean;
  platforms: Array<{
    platform: PixelPlatform;
    /** The org has an active pixel on this platform. */
    configured: boolean;
    /** The conversion sender may send (D2). */
    live: boolean;
    delivered: number;
    /** Queued rows this platform has not yet accepted. */
    pending: number;
    lastError?: { error: string; at: string };
  }>;
}

export async function conversionHealth(tenantId: string, orgId: string): Promise<ConversionHealth> {
  const LIMIT = 200;
  const rows = await listConversions(tenantId, orgId, LIMIT);
  const active = new Set((await listPixels(tenantId, orgId)).filter((p) => p.active).map((p) => p.platform));
  const live = new Set(enabledConversionPlatforms());
  return {
    queued: rows.filter((r) => r.status === 'queued').length,
    sent: rows.filter((r) => r.status === 'sent').length,
    expired: rows.filter((r) => r.status === 'expired').length,
    capped: rows.length >= LIMIT,
    platforms: CONVERSION_PLATFORMS.map((platform) => {
      let lastError: { error: string; at: string } | undefined;
      for (const r of rows) {
        const e = r.lastErrors?.[platform];
        if (e && (!lastError || e.at > lastError.at)) lastError = e;
      }
      return {
        platform, configured: active.has(platform), live: live.has(platform),
        delivered: rows.filter((r) => r.sentTo?.includes(platform)).length,
        pending: rows.filter((r) => r.status === 'queued' && !r.sentTo?.includes(platform)).length,
        ...(lastError ? { lastError } : {}),
      };
    }),
  };
}
