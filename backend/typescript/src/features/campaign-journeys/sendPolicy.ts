/**
 * ADR 0955 D4 — per-client send windows (quiet hours for marketing), and the pure function
 * that finds the next instant a journey may send.
 *
 * A window is evaluated in the RECIPIENT's time zone. The zone comes from, in order: the
 * contact's `timezone` custom field (an IANA zone), the client's `defaultTimezone`, then the
 * phone number's country. When the source is a country with several zones (+1 is six US
 * zones), the window is the INTERSECTION across them — the conservative choice: a send lands
 * inside the window wherever in that country the person is. No usable source is
 * `timezone_unknown`, a typed refusal the operator fixes by setting a default; it is never a
 * guess.
 *
 * Defaults are conservative and operator-editable (ADR 0955 Q2): SMS 09:00–20:00 local
 * (inside TCPA's 08:00–21:00), email unrestricted. This is configuration, not legal advice.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { isValidTimeZone, localClock, parseClockTime } from '../../host/localClock.js';

export type WindowChannel = 'email' | 'sms';
export interface SendWindow { start: string; end: string }

export interface ChannelSendPolicy {
  /** `${tenantId}::${orgId}` (`''` = the workspace itself). */
  key: string;
  tenantId: string;
  orgId: string;
  defaultTimezone?: string;
  windows: Partial<Record<WindowChannel, SendWindow>>;
  updatedBy: string;
  updatedAt: string;
}

export const DEFAULT_WINDOWS: Readonly<Partial<Record<WindowChannel, SendWindow>>> = Object.freeze({ sms: { start: '09:00', end: '20:00' } });

const policies = new DurableCollection<ChannelSendPolicy>('campaign-journeys:send-policy', (p) => p.key, undefined, (p) => p.tenantId);
const keyOf = (tenantId: string, orgId: string): string => `${tenantId}::${orgId}`;

/** The stored policy, or the conservative default (never null: every send has a window). */
export async function getSendPolicy(tenantId: string, orgId: string): Promise<Omit<ChannelSendPolicy, 'key' | 'updatedBy' | 'updatedAt'> & { stored: boolean }> {
  const row = await policies.get(keyOf(tenantId, orgId));
  if (row && row.tenantId === tenantId && row.orgId === orgId) {
    return { tenantId, orgId, ...(row.defaultTimezone ? { defaultTimezone: row.defaultTimezone } : {}), windows: row.windows, stored: true };
  }
  return { tenantId, orgId, windows: { ...DEFAULT_WINDOWS }, stored: false };
}

function validWindow(w: unknown, field: string): SendWindow {
  const o = (w ?? {}) as Record<string, unknown>;
  const start = parseClockTime(o.start);
  const end = parseClockTime(o.end);
  if (start === null || end === null || start >= end || start % 5 !== 0 || end % 5 !== 0) {
    throw new OpenwopError('validation_error', `\`${field}\` needs start < end, "HH:MM" on a 5-minute boundary, within one day.`, 400, { field });
  }
  return { start: o.start as string, end: o.end as string };
}

export async function setSendPolicy(input: { tenantId: string; orgId: string; defaultTimezone?: unknown; windows?: unknown; updatedBy: string }): Promise<ChannelSendPolicy> {
  if (input.defaultTimezone !== undefined && input.defaultTimezone !== null && input.defaultTimezone !== '' && !isValidTimeZone(input.defaultTimezone)) {
    throw new OpenwopError('validation_error', '`defaultTimezone` must be an IANA zone, e.g. "America/Chicago".', 400, { field: 'defaultTimezone' });
  }
  const w = (input.windows ?? {}) as Record<string, unknown>;
  const windows: Partial<Record<WindowChannel, SendWindow>> = {};
  for (const ch of ['sms', 'email'] as const) if (w[ch] !== undefined && w[ch] !== null) windows[ch] = validWindow(w[ch], `windows.${ch}`);
  // SMS always has a window: dropping it would mean "any hour", which the policy must not allow.
  if (!windows.sms) windows.sms = { ...DEFAULT_WINDOWS.sms! };
  const row: ChannelSendPolicy = {
    key: keyOf(input.tenantId, input.orgId), tenantId: input.tenantId, orgId: input.orgId,
    ...(isValidTimeZone(input.defaultTimezone) ? { defaultTimezone: input.defaultTimezone } : {}),
    windows, updatedBy: input.updatedBy, updatedAt: new Date().toISOString(),
  };
  await policies.put(row);
  return row;
}

/** Countries whose numbers map to a known set of zones. Several zones ⇒ intersect. */
const COUNTRY_ZONES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['+1', ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']],
  ['+44', ['Europe/London']], ['+353', ['Europe/Dublin']], ['+33', ['Europe/Paris']], ['+49', ['Europe/Berlin']],
  ['+34', ['Europe/Madrid']], ['+39', ['Europe/Rome']], ['+31', ['Europe/Amsterdam']], ['+32', ['Europe/Brussels']],
  ['+41', ['Europe/Zurich']], ['+46', ['Europe/Stockholm']], ['+47', ['Europe/Oslo']], ['+45', ['Europe/Copenhagen']],
  ['+351', ['Europe/Lisbon']], ['+48', ['Europe/Warsaw']], ['+91', ['Asia/Kolkata']], ['+81', ['Asia/Tokyo']],
  ['+65', ['Asia/Singapore']], ['+64', ['Pacific/Auckland']],
  ['+61', ['Australia/Perth', 'Australia/Adelaide', 'Australia/Sydney']],
  ['+55', ['America/Manaus', 'America/Sao_Paulo']],
  ['+52', ['America/Tijuana', 'America/Mexico_City', 'America/Cancun']],
];

export interface ZoneResolution { zones: string[]; basis: 'contact_timezone' | 'client_default' | 'phone_country' | 'unknown' }

/** Which zones a recipient may be in, by the D4 order. */
export function zonesFor(input: { contactTimezone?: unknown; defaultTimezone?: string; phone?: string }): ZoneResolution {
  if (isValidTimeZone(input.contactTimezone)) return { zones: [input.contactTimezone], basis: 'contact_timezone' };
  if (input.defaultTimezone && isValidTimeZone(input.defaultTimezone)) return { zones: [input.defaultTimezone], basis: 'client_default' };
  if (input.phone) {
    const match = [...COUNTRY_ZONES].sort((a, b) => b[0].length - a[0].length).find(([prefix]) => input.phone!.startsWith(prefix));
    if (match) return { zones: [...match[1]], basis: 'phone_country' };
  }
  return { zones: [], basis: 'unknown' };
}

const STEP_MS = 5 * 60_000;
const HORIZON_MS = 72 * 3_600_000;

function inWindowEverywhere(at: Date, zones: readonly string[], startMin: number, endMin: number): boolean {
  for (const z of zones) {
    const c = localClock(at, z);
    if (!c || c.minuteOfDay < startMin || c.minuteOfDay >= endMin) return false;
  }
  return true;
}

/**
 * The earliest instant ≥ `now` inside `window` in EVERY zone, scanning a 5-minute grid for up
 * to 72 h (windows are on 5-minute boundaries, and zone offsets are multiples of 15 minutes).
 * Pure: the same inputs give the same answer. `null` when no instant in 72 h fits all zones.
 */
export function nextSendWindow(input: { now: Date; window?: SendWindow; zones: readonly string[] }): Date | null {
  if (!input.window) return input.now;
  const startMin = parseClockTime(input.window.start);
  const endMin = parseClockTime(input.window.end);
  if (startMin === null || endMin === null || input.zones.length === 0) return null;
  if (inWindowEverywhere(input.now, input.zones, startMin, endMin)) return input.now;
  const first = Math.ceil(input.now.getTime() / STEP_MS) * STEP_MS;
  for (let t = first; t - input.now.getTime() <= HORIZON_MS; t += STEP_MS) {
    const at = new Date(t);
    if (inWindowEverywhere(at, input.zones, startMin, endMin)) return at;
  }
  return null;
}
