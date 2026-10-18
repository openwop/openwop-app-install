/**
 * ADR 0861 D6 addendum / ADR 0859 OQ-1 (owner decision 2026-10-11) — the approval
 * card names the locales whose translations are OUTDATED, as information. It is
 * derived from `pageTranslationStatus` (the editor's translation-status read) at
 * queue and repin time, rides the approval row to every inbox, and NEVER blocks the
 * decision.
 *
 * Sabotage: dropping the field from `queueContentApproval` reds the disclosure legs;
 * a decide-side refusal on it reds the approve leg.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { getApproval } from '../src/host/approvalService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  delete process.env.OPENWOP_DEMO_MODE;
  await enableToggle('cms-localization', 'on');
});
afterAll(async () => { await enableToggle('cms-approval-gate', 'off'); await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const APPROVALS = '/host/openwop-app/approvals';
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('cmsot'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

describe('ADR 0861 D6 addendum — outdated translations on the approval card', () => {
  it('names the outdated locales, updates on resubmit, and approval still succeeds', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const tenantId = `org:cmsot-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId as string;
    const admin = client(); const adminId = await signup(admin, tenantId);
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'A', subject: adminId, roles: ['admin'] })).status).toBeLessThan(300);
    expect((await owner.put(u(orgId, '/language-settings'), { supportedLocales: ['es', 'fr', 'de'] })).status).toBe(200);

    const created = await owner.post(u(orgId, '/pages'), {
      title: 'Pricing',
      sections: [{ type: 'hero', data: { heading: 'Welcome' }, localizations: { es: { heading: 'Bienvenido' }, fr: { heading: 'Bienvenue' }, de: { heading: 'Willkommen' } } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId as string;
    const sec = created.body.sections[0];
    // The base moves; es and fr are re-confirmed for nothing, so they are outdated. de is
    // then re-translated, so it is current — a positive control that the list filters.
    const moved = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ ...sec, data: { heading: 'Welcome back' }, localizations: { ...sec.localizations, de: { heading: 'Willkommen zurück' } } }],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const st = await owner.get(u(orgId, `/pages/${pageId}/translation-status`));
    expect(st.body.counts.es.outdated, 'precondition: the editor reads es as outdated').toBe(1);
    expect(st.body.counts.de.current).toBe(1);

    expect((await owner.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const review = (await owner.get(u(orgId, `/pages/${pageId}/review`))).body.review;
    const approvalId = review.approvalId as string;
    expect(review.outdatedTranslationLocales).toEqual(['es', 'fr']);
    expect((await getApproval(approvalId))?.outdatedTranslationLocales).toEqual(['es', 'fr']);
    const inbox = await admin.get(APPROVALS);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const rows = inbox.body.items as Array<{ approvalId: string; outdatedTranslationLocales?: string[] }>;
    expect(rows.find((r) => r.approvalId === approvalId)?.outdatedTranslationLocales, 'the inbox row carries it').toEqual(['es', 'fr']);

    // Fix es and resubmit: the repin REPLACES the list.
    const cur = (await owner.get(u(orgId, `/pages/${pageId}`))).body;
    const fixed = await owner.patch(u(orgId, `/pages/${pageId}`), {
      sections: cur.sections.map((s: { localizations: Record<string, unknown> }) => ({ ...s, localizations: { ...s.localizations, es: { heading: 'Bienvenido de nuevo' } } })),
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((await owner.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect((await getApproval(approvalId))?.outdatedTranslationLocales).toEqual(['fr']);

    // Information, not a block: the other manager approves with fr still outdated.
    const ok = await admin.post(`${APPROVALS}/${approvalId}/claim`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await owner.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });
});
