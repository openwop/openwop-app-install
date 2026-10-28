/**
 * ADR 0955 P3(a) — deterministic, explainable send-time choice (D5).
 *
 * Exit criterion (ADR 0955 phase table, P3): the same inputs give the same `sendAt`. The
 * ADR 0949 split registration and the variant-set pin (the rest of the P3 row) wait for ADR 0949
 * and ADR 0946, which are not merged; see the ADR's P3 note.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the 5-event floor removed (one open picks the hour)                      → "fewer than five"
 *  - ties broken toward the LAST bucket                                        → "ties"
 *  - the window clamp skipped                                                  → "the window wins"
 *  - the 24 h cap skipped (a far modal hour-of-week kept)                       → "within 24 h"
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { chooseSendTime } from '../src/features/campaign-journeys/sendTime.js';
import { setSendPolicy } from '../src/features/campaign-journeys/sendPolicy.js';
import { buildCampaignJourneysSurface } from '../src/features/campaign-journeys/surface.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { mintToken, recordOpen } from '../src/features/email/engagementService.js';
import * as pack from '../../../packs/feature.campaign-journeys.nodes/index.mjs';

const NY = ['America/New_York'];
// Tuesday 2026-10-20 is a Tuesday. 14:00Z = 10:00 EDT.
const tueAt = (h: number) => ({ at: `2026-10-20T${String(h + 4).padStart(2, '0')}:00:00Z` }); // h local EDT
const sms = { start: '09:00', end: '20:00' };

describe('ADR 0955 D5 — chooseSendTime', () => {
  it('fewer than five events: the default time; five or more: the modal hour-of-week', () => {
    const now = new Date('2026-10-20T13:00:00Z'); // 09:00 EDT Tue
    const few = chooseSendTime({ now, events: [tueAt(15)], zones: NY, defaultTime: '11:00' });
    expect(few).toMatchObject({ basis: 'default' });
    expect(few!.sendAt.toISOString()).toBe('2026-10-20T15:00:00.000Z'); // 11:00 EDT
    const five = chooseSendTime({ now, events: [tueAt(15), tueAt(15), tueAt(15), tueAt(12), tueAt(18)], zones: NY, defaultTime: '11:00' });
    expect(five).toMatchObject({ basis: 'contact_hour_of_week' });
    expect(five!.sendAt.toISOString()).toBe('2026-10-20T19:00:00.000Z'); // 15:00 EDT
    expect(five!.histogram).toEqual({ [String(2 * 24 + 15)]: 3, [String(2 * 24 + 12)]: 1, [String(2 * 24 + 18)]: 1 });
  });

  it('same inputs give the same sendAt (and ties go to the earliest bucket)', () => {
    const now = new Date('2026-10-20T13:00:00Z');
    const events = [tueAt(17), tueAt(17), tueAt(16), tueAt(16), tueAt(18)];
    const a = chooseSendTime({ now, events, zones: NY });
    const b = chooseSendTime({ now, events: [...events].reverse(), zones: NY });
    expect(a!.sendAt.toISOString()).toBe(b!.sendAt.toISOString());
    expect(a!.sendAt.toISOString()).toBe('2026-10-20T20:00:00.000Z'); // 16:00 EDT beats 17:00
  });

  it('within 24 h: a modal hour-of-week days away falls back to the modal hour-of-day', () => {
    const now = new Date('2026-10-20T13:00:00Z'); // Tuesday
    // Five Friday-15:00 events (2026-10-16 was a Friday): next Friday is > 24 h away.
    const fri = Array.from({ length: 5 }, () => ({ at: '2026-10-16T19:00:00Z' }));
    const c = chooseSendTime({ now, events: fri, zones: NY });
    expect(c).toMatchObject({ basis: 'contact_hour_of_day' });
    expect(c!.sendAt.toISOString()).toBe('2026-10-20T19:00:00.000Z'); // today 15:00 EDT
  });

  it('the window wins over the preference', () => {
    const now = new Date('2026-10-20T13:00:00Z');
    const late = Array.from({ length: 5 }, () => ({ at: '2026-10-21T02:00:00Z' })); // Tue 22:00 EDT, outside 09–20
    const c = chooseSendTime({ now, events: late, zones: NY, window: sms });
    expect(c!.sendAt.toISOString()).toBe('2026-10-21T13:00:00.000Z'); // next 09:00 EDT
    expect(chooseSendTime({ now, events: [], zones: [], window: sms })).toBeNull();
  });
});

describe('ADR 0955 D5 — the send-time node', () => {
  const T = `org:p3-${randomBytes(3).toString('hex')}`;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    const d = getToggleDefault('campaign-journeys'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    await setSendPolicy({ tenantId: T, orgId: '', defaultTimezone: 'America/New_York', updatedBy: 'a' });
  });

  it('reads the contact’s own opens, waits until the chosen time, and explains it', async () => {
    const c = await createContact({ tenantId: T, name: 'Opener', email: 'opener@example.test' });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let k = 0; k < 5; k++) {
        vi.setSystemTime(new Date('2026-10-13T20:00:00Z')); // a Tuesday, 16:00 EDT
        await recordOpen(await mintToken({ tenantId: T, campaignId: 'cmp', contactId: c.contactId, kind: 'open' }));
      }
      vi.setSystemTime(new Date('2026-10-20T13:00:00Z'));
      const ctx = { runId: 'r', nodeId: 'n', inputs: { contactId: c.contactId, channel: 'email' }, features: { 'campaign-journeys': buildCampaignJourneysSurface({ tenantId: T }) }, suspend: async (p: unknown) => { throw Object.assign(new Error('suspended'), { payload: p }); } };
      await expect(pack.sendTime(ctx)).rejects.toMatchObject({ payload: { kind: 'until', timestamp: '2026-10-20T20:00:00.000Z', resumeKey: 'send-time', explain: { sendAt: '2026-10-20T20:00:00.000Z', basis: 'contact_hour_of_week', zone: 'America/New_York' } } });
      // The host re-invokes the node AFTER the timer fired, so "today's 16:00" has just passed
      // and a recomputed time is next week's. The fixed key must still resume it (J955WF-8:
      // a time-derived key re-parked it forever).
      vi.setSystemTime(new Date('2026-10-20T20:00:07Z'));
      const resumed = { ...ctx, suspend: async (p: { resumeKey?: string }) => { if (p.resumeKey === 'send-time') return { elapsed: true }; throw Object.assign(new Error('re-parked'), { payload: p }); } };
      expect(await pack.sendTime(resumed)).toEqual({ status: 'success', outputs: { sendAt: '2026-10-20T20:00:07.000Z', waited: true, contactId: c.contactId } });
    } finally { vi.useRealTimers(); }
  });
});
