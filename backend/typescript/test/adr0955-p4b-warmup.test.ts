/**
 * ADR 0955 P4b — warm-up caps: a new sender's marketing volume grows along a ramp, and over the
 * day's ceiling the broadcast DEFERS (409 warmup_deferred, campaign kept), never drops.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the batch not capped by the remaining allowance                        → "caps the pass"
 *  - the ceiling check removed (the second pass sends anyway)               → "defers"
 *  - the ramp day not advancing (day 0 forever)                              → "next day"
 *  - the toggle check removed (warm-up on for every workspace)               → "off by default"
 *  - the deferral leaving the campaign anything but `sending` (dropped/closed) → "caps the pass"
 *
 * Probes (wave 73, scripts/test-probe.mjs): w73g3-p4b-cap, -ceiling, -day, -toggle, -resumeat
 * (all witnessed), w73g3-p4b-kept (the campaign-kept read-back). "off by default" asserts the
 * REGISTRY default and the gate's own read, so it holds under any case order (the second case's
 * `finally` saves `off`, which reads the same). The toggle is a global config row: the second case
 * sets it on and restores it in `finally`.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { warmupRemaining } from '../src/features/crm/senderHealth.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { createCampaign, createTemplate, emailWarmupOn, getCampaign, listSends, sendCampaign, setSenderAddress, type EmailProvider } from '../src/features/email/emailService.js';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  process.env.OPENWOP_EMAIL_WARMUP_RAMP = '2,5';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['email', 'crm', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(() => { delete process.env.OPENWOP_EMAIL_WARMUP_RAMP; });

const setWarmup = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('email.warmup'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function workspaceWith(n: number): Promise<{ t: string; campaignId: string }> {
  const t = `org:p4b-${randomBytes(3).toString('hex')}`;
  await setSenderAddress(t, t, 'news@mailco.test', 'u');
  for (let i = 0; i < n; i++) {
    const c = await createContact({ tenantId: t, name: `C${i}`, email: `c${i}-${randomBytes(2).toString('hex')}@x.test` });
    await recordConsent({ tenantId: t, subjectKey: c.contactId, categories: { 'marketing.email': true }, source: 'test' });
  }
  const tpl = await createTemplate({ tenantId: t, orgId: t, name: 'T', subject: 'S', body: 'B', createdBy: 'u' });
  return { t, campaignId: (await createCampaign({ tenantId: t, orgId: t, templateId: tpl.templateId, createdBy: 'u' })).campaignId };
}
const provider: EmailProvider = { id: 'capture', async send() { /* delivered */ } };
const sentCount = async (t: string, id: string) => (await listSends(t, id)).filter((r) => r.status === 'sent').length;

describe('ADR 0955 D7 — warm-up caps', () => {
  it('off by default: no ceiling', async () => {
    expect(getToggleDefault('email.warmup')?.status).toBe('off');
    const { t, campaignId } = await workspaceWith(4);
    expect(await emailWarmupOn(t)).toBe(false);
    await sendCampaign(t, t, campaignId, { provider });
    expect(await sentCount(t, campaignId)).toBe(4);
  });

  it('caps the pass, defers over the ceiling, and opens the next day', async () => {
    await setWarmup('on');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
      const { t, campaignId } = await workspaceWith(6);
      await sendCampaign(t, t, campaignId, { provider });
      expect(await sentCount(t, campaignId)).toBe(2); // day 1 ceiling
      await expect(sendCampaign(t, t, campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'warmup_deferred', resumeAt: '2026-10-21T00:00:00.000Z', cap: 2 } });
      expect(await sentCount(t, campaignId)).toBe(2); // nothing dropped, nothing more sent
      expect((await getCampaign(t, t, campaignId))?.status).toBe('sending'); // the campaign is kept, not closed
      vi.setSystemTime(new Date('2026-10-21T09:00:00Z'));
      expect(await warmupRemaining(t, t)).toMatchObject({ day: 1, cap: 5, remaining: 5 });
      await sendCampaign(t, t, campaignId, { provider });
      expect(await sentCount(t, campaignId)).toBe(6);
      vi.setSystemTime(new Date('2026-10-22T09:00:00Z'));
      expect((await warmupRemaining(t, t)).cap).toBe(Number.POSITIVE_INFINITY); // past the ramp
    } finally { vi.useRealTimers(); await setWarmup('off'); }
  });
});
