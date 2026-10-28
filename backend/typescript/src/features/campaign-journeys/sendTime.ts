/**
 * ADR 0955 D5 — deterministic, explainable send-time choice.
 *
 * From the contact's opens and clicks in the last 90 days (the per-contact engagement index,
 * one prefix read), in the recipient's zone:
 *  1. at least 5 events ⇒ the modal HOUR-OF-WEEK, if its next occurrence is within 24 h;
 *  2. else (≥ 5 events, but that hour is further away) ⇒ the modal HOUR-OF-DAY, next occurrence;
 *  3. else ⇒ the journey's default time of day (`defaultTime`, "HH:MM", default 10:00).
 * Ties break toward the earliest bucket, so the same inputs always give the same answer. The
 * choice is then clamped into the client's send window (D4) — the window wins over the
 * preference, because quiet hours are a rule and the preference is a guess.
 *
 * > ADR 0955 correction (P3): D5's middle rung, "the client cohort's modal hour", is NOT built.
 * > It needs a per-client engagement rollup that does not exist; computing it per send would be
 * > the O(tenant) read P0 removed. ADR 0957 (reporting) owns per-client rollups; when one exists
 * > this function takes it as an input. Until then the basis skips straight to the default.
 *
 * Pure (`chooseSendTime`) so replay and the tests can recompute it; the node records the output.
 */
import { localClock, parseClockTime } from '../../host/localClock.js';
import { getSendPolicy, nextSendWindow, zonesFor, type SendWindow, type WindowChannel } from './sendPolicy.js';
import { getContact } from '../crm/contactsService.js';
import { listContactEngagement } from '../email/engagementService.js';
import { resolveEnrollmentOrg } from './journeyService.js';

export type SendTimeBasis = 'contact_hour_of_week' | 'contact_hour_of_day' | 'default';

export interface SendTimeChoice {
  sendAt: Date;
  basis: SendTimeBasis;
  /** Engagement counts by local hour-of-week (`0` = Sunday 00:xx … `167` = Saturday 23:xx), only the non-zero buckets. */
  histogram: Record<string, number>;
  /** The zone the hours were read in. */
  zone: string | null;
}

const HOUR = 3_600_000;
const MIN_EVENTS = 5;
const MAX_DELAY = 24 * HOUR;

/** The next instant ≥ `now` whose local (weekday?, hour, minute) matches, scanning a 5-minute grid. */
function nextLocal(now: Date, zone: string, minuteOfDay: number, weekday: number | null): Date | null {
  const step = 5 * 60_000;
  const start = Math.ceil(now.getTime() / step) * step;
  for (let t = start; t - now.getTime() <= 8 * 24 * HOUR; t += step) {
    const c = localClock(new Date(t), zone);
    if (c && c.minuteOfDay === minuteOfDay && (weekday === null || c.weekday === weekday)) return new Date(t);
  }
  return null;
}

/** Index of the largest count; ties → the lowest index. -1 when all are zero. */
function modal(counts: readonly number[]): number {
  let best = -1;
  for (let i = 0; i < counts.length; i++) if (counts[i]! > 0 && (best < 0 || counts[i]! > counts[best]!)) best = i;
  return best;
}

export function chooseSendTime(input: {
  now: Date;
  events: ReadonlyArray<{ at: string }>;
  zones: readonly string[];
  window?: SendWindow;
  defaultTime?: string;
}): SendTimeChoice | null {
  // The hours are read in ONE zone: the recipient's when known, else the first of the
  // country's zones; the window clamp below still intersects ALL of them.
  const zone = input.zones[0] ?? null;
  const byHourOfWeek = new Array<number>(168).fill(0);
  if (zone) {
    for (const e of input.events) {
      const c = localClock(new Date(e.at), zone);
      if (c) byHourOfWeek[c.weekday * 24 + Math.floor(c.minuteOfDay / 60)]! += 1;
    }
  }
  const histogram: Record<string, number> = {};
  byHourOfWeek.forEach((n, i) => { if (n > 0) histogram[String(i)] = n; });
  const total = byHourOfWeek.reduce((a, b) => a + b, 0);

  let target: Date | null = null;
  let basis: SendTimeBasis = 'default';
  if (zone && total >= MIN_EVENTS) {
    const how = modal(byHourOfWeek);
    const at = nextLocal(input.now, zone, (how % 24) * 60, Math.floor(how / 24));
    if (at && at.getTime() - input.now.getTime() <= MAX_DELAY) { target = at; basis = 'contact_hour_of_week'; }
    else {
      const byHour = new Array<number>(24).fill(0);
      byHourOfWeek.forEach((n, i) => { byHour[i % 24]! += n; });
      const hod = modal(byHour);
      target = nextLocal(input.now, zone, hod * 60, null);
      basis = 'contact_hour_of_day';
    }
  }
  if (!target) {
    basis = 'default';
    const minute = parseClockTime(input.defaultTime ?? '10:00') ?? 600;
    target = zone ? nextLocal(input.now, zone, minute, null) : input.now;
  }
  if (!target) return null;
  // The window wins (D4). No zone at all ⇒ there is no window to honour honestly: refuse.
  if (input.window) {
    if (input.zones.length === 0) return null;
    const clamped = nextSendWindow({ now: target, window: input.window, zones: input.zones });
    if (!clamped) return null;
    target = clamped;
  }
  return { sendAt: target, basis, histogram, zone };
}

/**
 * The journey's send time for one contact: their last 90 days of opens and clicks (one prefix
 * read on the per-contact index), the client's window and zones (D4). Typed refusals instead of
 * a guess: `contact_not_found`, `timezone_unknown` (no zone and a window to honour).
 */
export async function journeySendTime(
  tenantId: string, orgId: string, contactId: string, channel: WindowChannel,
  opts: { defaultTime?: string; now?: Date } = {},
): Promise<{ ok: true; sendAt: string; basis: SendTimeBasis; histogram: Record<string, number>; zone: string | null } | { ok: false; code: 'contact_not_found' | 'timezone_unknown' }> {
  const now = opts.now ?? new Date();
  const o = await resolveEnrollmentOrg(tenantId, orgId);
  const contact = await getContact(contactId);
  if (!contact || contact.tenantId !== tenantId) return { ok: false, code: 'contact_not_found' };
  const policy = await getSendPolicy(tenantId, o);
  const res = zonesFor({ contactTimezone: contact.customFields?.timezone, ...(policy.defaultTimezone ? { defaultTimezone: policy.defaultTimezone } : {}), ...(contact.phone ? { phone: contact.phone } : {}) });
  const window = policy.windows[channel];
  const events = (await listContactEngagement(tenantId, contactId, { sinceIso: new Date(now.getTime() - 90 * 24 * HOUR).toISOString() }))
    .filter((e) => e.kind === 'opened' || e.kind === 'clicked');
  const choice = chooseSendTime({ now, events, zones: res.zones, ...(window ? { window } : {}), ...(opts.defaultTime ? { defaultTime: opts.defaultTime } : {}) });
  if (!choice) return { ok: false, code: 'timezone_unknown' };
  return { ok: true, sendAt: choice.sendAt.toISOString(), basis: choice.basis, histogram: choice.histogram, zone: choice.zone };
}
