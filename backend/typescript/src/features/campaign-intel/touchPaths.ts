/**
 * ADR 0956 D1 — touch paths, computed at READ time from the analytics events.
 *
 * PURE: the caller passes the events, the session→contact links and the
 * campaign resolver. There is deliberately no derived path store. A cache of
 * these rows would be confidential-pii with its own eraser, retention purger
 * and rebuild sweep, and it could serve an erased touch between sweeps. Reading
 * the source rows means the analytics eraser and retention purger are the only
 * copies to clean (the ADR 0956 P1 correction records this).
 *
 * - A touch is an event carrying UTMs, an ad click id, or an email-click token
 *   (`owx`, ADR 0226). The converting hit is itself a touch when it carries one.
 * - The unit is the CONTACT when the conversion's session is deterministically
 *   linked to one (ADR 0226/0857, never probabilistic), else the session. A
 *   conversion with no session is a path of its own hit.
 * - Touches count only within the lookback window before (or at) the conversion.
 * - Consecutive identical touches from one session collapse to the first: a
 *   site that re-sends UTMs on every page view would otherwise multiply a
 *   single visit's credit under the linear and decay models.
 */
import type { AnalyticsEvent, ClickIds } from '../analytics/analyticsService.js';

export type ClickIdKind = keyof ClickIds;

export interface Touch {
  at: string;
  /** The campaign this touch maps to, or null when its utm_campaign matches none. */
  campaignId: string | null;
  utmCampaign?: string;
  channel: string;
  source?: string;
  medium?: string;
  content?: string;
  /** `utm_id` — our ad reference on a published ad's landing link (ADR 0956 D6). */
  utmId?: string;
  clickIdKind?: ClickIdKind;
  sessionKey?: string;
}

export interface TouchPath {
  conversionEventId: string;
  conversionAt: string;
  unit: { kind: 'contact' | 'session' | 'event'; id: string };
  touches: Touch[];
  /** The conversion's value in ISO minor units, when it carries one. */
  value: { minor: number; currency: string } | null;
}

export interface PathCoverage {
  conversions: number;
  contactPaths: number;
  /** Paths from one session only, including a session-less conversion whose
   *  own hit is its only touch. */
  sessionPaths: number;
  /** Conversions with no touch in the window (nothing to credit). */
  noTouch: number;
}

const CLICK_ID_CHANNEL: Record<ClickIdKind, string> = { gclid: 'paid:google', fbclid: 'paid:meta', ttclid: 'paid:tiktok', li_fat_id: 'paid:linkedin' };
const CLICK_ID_ORDER: readonly ClickIdKind[] = ['gclid', 'fbclid', 'ttclid', 'li_fat_id'];

function isTouch(e: AnalyticsEvent): boolean {
  return e.utm !== undefined || e.clickIds !== undefined || e.owx !== undefined;
}

function toTouch(e: AnalyticsEvent, resolveCampaign: (utmCampaign: string) => string | null): Touch {
  const clickIdKind = e.clickIds ? CLICK_ID_ORDER.find((k) => e.clickIds?.[k]) : undefined;
  const medium = e.utm?.medium?.toLowerCase();
  const channel = e.owx ? 'email' : clickIdKind ? CLICK_ID_CHANNEL[clickIdKind] : medium ?? 'unknown';
  return {
    at: e.ts,
    campaignId: e.utm?.campaign ? resolveCampaign(e.utm.campaign) : null,
    channel,
    ...(e.utm?.campaign ? { utmCampaign: e.utm.campaign } : {}),
    ...(e.utm?.source ? { source: e.utm.source } : {}),
    ...(medium ? { medium } : {}),
    ...(e.utm?.content ? { content: e.utm.content } : {}),
    ...(e.utm?.id ? { utmId: e.utm.id } : {}),
    ...(clickIdKind ? { clickIdKind } : {}),
    ...(e.sessionKey ? { sessionKey: e.sessionKey } : {}),
  };
}

const sameTouch = (a: Touch, b: Touch): boolean =>
  a.sessionKey !== undefined && a.sessionKey === b.sessionKey && a.utmCampaign === b.utmCampaign && a.source === b.source
  && a.medium === b.medium && a.content === b.content && a.utmId === b.utmId && a.clickIdKind === b.clickIdKind && a.channel === b.channel;

const byTime = (a: AnalyticsEvent, b: AnalyticsEvent): number => a.ts.localeCompare(b.ts) || a.eventId.localeCompare(b.eventId);

/** A conversion's value in ISO minor units: `props.valueMinor` (an integer) or a
 *  commerce `props.total` (major units), each with a 3-letter `props.currency`. */
export function conversionValue(e: AnalyticsEvent, currencyExponent: (currency: string) => number): { minor: number; currency: string } | null {
  const currency = typeof e.props?.currency === 'string' && /^[A-Za-z]{3}$/.test(e.props.currency) ? e.props.currency.toUpperCase() : null;
  if (!currency) return null;
  const vm = e.props?.valueMinor;
  if (typeof vm === 'number' && Number.isSafeInteger(vm) && vm >= 0) return { minor: vm, currency };
  const total = e.props?.total;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
    const minor = Math.round(total * 10 ** currencyExponent(currency));
    return Number.isSafeInteger(minor) ? { minor, currency } : null;
  }
  return null;
}

export interface BuildPathsInput {
  events: readonly AnalyticsEvent[];
  contactBySession: ReadonlyMap<string, string>;
  lookbackDays: number;
  resolveCampaign: (utmCampaign: string) => string | null;
  currencyExponent: (currency: string) => number;
}

export function buildTouchPaths(input: BuildPathsInput): { paths: TouchPath[]; coverage: PathCoverage } {
  const sorted = [...input.events].sort(byTime);
  // Touches per session (in time order); a session's contact joins sessions into one unit.
  const touchesBySession = new Map<string, AnalyticsEvent[]>();
  const sessionsByContact = new Map<string, Set<string>>();
  for (const e of sorted) {
    if (!e.sessionKey) continue;
    const contact = input.contactBySession.get(e.sessionKey);
    if (contact) {
      const set = sessionsByContact.get(contact) ?? new Set<string>();
      set.add(e.sessionKey);
      sessionsByContact.set(contact, set);
    }
    if (isTouch(e)) {
      const arr = touchesBySession.get(e.sessionKey) ?? [];
      arr.push(e);
      touchesBySession.set(e.sessionKey, arr);
    }
  }
  const windowMs = Math.min(Math.max(input.lookbackDays, 1), 90) * 86_400_000;
  const coverage: PathCoverage = { conversions: 0, contactPaths: 0, sessionPaths: 0, noTouch: 0 };
  const paths: TouchPath[] = [];
  for (const conv of sorted) {
    if (conv.type !== 'conversion') continue;
    coverage.conversions += 1;
    const contact = conv.sessionKey ? input.contactBySession.get(conv.sessionKey) : undefined;
    let candidates: AnalyticsEvent[];
    let unit: TouchPath['unit'];
    if (contact) {
      unit = { kind: 'contact', id: contact };
      candidates = [...(sessionsByContact.get(contact) ?? [])].flatMap((s) => touchesBySession.get(s) ?? []).sort(byTime);
    } else if (conv.sessionKey) {
      unit = { kind: 'session', id: conv.sessionKey };
      candidates = touchesBySession.get(conv.sessionKey) ?? [];
    } else {
      unit = { kind: 'event', id: conv.eventId };
      candidates = isTouch(conv) ? [conv] : [];
    }
    const convMs = Date.parse(conv.ts);
    const touches: Touch[] = [];
    for (const e of candidates) {
      const t = Date.parse(e.ts);
      // At or before the conversion (the converting hit included), inside the window.
      if (t > convMs || convMs - t > windowMs || (t === convMs && e.eventId !== conv.eventId && byTime(e, conv) > 0)) continue;
      const touch = toTouch(e, input.resolveCampaign);
      const prev = touches[touches.length - 1];
      if (prev && sameTouch(prev, touch)) continue;
      touches.push(touch);
    }
    if (touches.length === 0) coverage.noTouch += 1;
    else if (unit.kind === 'contact') coverage.contactPaths += 1;
    else coverage.sessionPaths += 1;
    paths.push({ conversionEventId: conv.eventId, conversionAt: conv.ts, unit, touches, value: conversionValue(conv, input.currencyExponent) });
  }
  return { paths, coverage };
}
