/**
 * Campaign workspace fields + templates (ADR 0216 / campaign gap plan C8):
 *   - budget + UTM sanitize on create/update; budget is PROTECTED (post-approval
 *     edit demotes to draft), UTM is not;
 *   - finalize carries budget/utm onto the campaign;
 *   - duplicate-as-template: fresh draft, kernel dropped, provenance audited;
 *   - parentCampaignId: same-org validation, self-reference rejected.
 *
 * Sabotage-witnessed (/grade-tests w30): dropping `budget` from the protected
 * fields, the perChannel channel allowlist, the closed UTM key set, budget on
 * finalize, the same-org parent check (a parent in a SECOND org of the same
 * tenant), clearing the parent, `delete copy.kernel` (the source HAS a kernel),
 * and the duplicate's draft status each turn a case red.
 * Ceiling: the self-parent leg is DOUBLE-GUARDED — the route's cycle walk seeds
 * `seen` with the campaign itself, so removing the `parent.id === campaign.id`
 * clause alone still 400s (probe w30g3-wf-parent-self vacuous by design).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

const FINALIZE_KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-brief', 'campaign-orchestration']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The route bodies this suite reads (each field it touches is asserted). */
interface Brief { id: string; name: string; status: string; version: number; kernel?: unknown; budget?: { totalMinor?: number }; utm?: { source?: string; campaign?: string } }
interface Campaign { id: string; parentCampaignId?: string; budget?: unknown; utm: { campaign?: string } }
interface Body { orgId: string; brief: Brief; campaign: Campaign }
interface Res { status: number; body: Body }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const parsed = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as Body; // JSON boundary
    return { status: res.status, body: parsed };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  // Explicit tenant so a test can set the kernel via the service (no kernel HTTP route).
  const tenantId = `user:cwf-${Date.now()}-${n++}`;
  const r = await owner.post('/host/openwop-app/test/login', { email: `cwf-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const B = '/host/openwop-app/campaign-brief/briefs';
const ORCH = '/host/openwop-app/campaign-orchestration';

const BRIEF_BODY = (orgId: string) => ({
  orgId, name: 'Summer Launch', productName: 'Solstice', objective: 'Grow', personaIds: ['p1'],
  messaging: { primaryValueProp: 'Fresh' },
  channels: [{ type: 'ad_variants', enabled: true, config: {} }],
  budget: { totalMinor: 150000.9, currency: 'usd', perChannel: { ad_variants: 90000, bogus_channel: 5 } },
  utm: { source: 'newsletter', campaign: 'summer-launch', bogus: 'x' },
});

describe('ADR 0216 — budget + UTM + templates + hierarchy', () => {
  it('sanitizes budget/utm on create; utm edits are unprotected, budget edits demote', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(B, BRIEF_BODY(orgId));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const brief = created.body.brief;
    expect(brief.budget).toEqual({ totalMinor: 150000, currency: 'USD', perChannel: { ad_variants: 90000 } });
    expect(brief.utm).toEqual({ source: 'newsletter', campaign: 'summer-launch' });

    // Confirm, then a UTM-only edit: NOT protected — status stays confirmed.
    expect((await owner.patch(`${B}/${brief.id}`, { status: 'confirmed' })).body.brief.status).toBe('confirmed');
    const utmEdit = await owner.patch(`${B}/${brief.id}`, { utm: { source: 'social', campaign: 'summer-launch' } });
    expect(utmEdit.status).toBe(200);
    expect(utmEdit.body.brief.status).toBe('confirmed');
    expect(utmEdit.body.brief.utm?.source).toBe('social');

    // A budget edit IS protected — demotes to draft + bumps the revision.
    const budgetEdit = await owner.patch(`${B}/${brief.id}`, { budget: { totalMinor: 200000 } });
    expect(budgetEdit.status).toBe(200);
    expect(budgetEdit.body.brief.status).toBe('draft');
    expect(budgetEdit.body.brief.version).toBe(2);
  });

  it('finalize carries budget/utm onto the campaign; parentCampaignId validates same-org + not-self', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const b1 = (await owner.post(B, BRIEF_BODY(orgId))).body.brief;
    const b2 = (await owner.post(B, { ...BRIEF_BODY(orgId), name: 'Child push' })).body.brief;
    // ORCH-1: finalize requires an approved messaging kernel.
    await setKernel(tenantId, b1.id, FINALIZE_KERNEL);
    await setKernel(tenantId, b2.id, FINALIZE_KERNEL);
    expect((await owner.patch(`${B}/${b1.id}`, { status: 'confirmed' })).body.brief.status).toBe('confirmed');
    expect((await owner.patch(`${B}/${b2.id}`, { status: 'confirmed' })).body.brief.status).toBe('confirmed');
    const parent = (await owner.post(`${ORCH}/finalize`, { briefId: b1.id })).body.campaign;
    const child = (await owner.post(`${ORCH}/finalize`, { briefId: b2.id })).body.campaign;
    // A campaign in a SECOND org of the SAME tenant (the owner belongs to both),
    // so the same-org rule — not a tenant guard — is what refuses it.
    const other = await owner.post('/host/openwop-app/orgs', { name: 'Other' });
    expect(other.status).toBe(201);
    const b3 = (await owner.post(B, BRIEF_BODY(other.body.orgId))).body.brief;
    await setKernel(tenantId, b3.id, FINALIZE_KERNEL);
    expect((await owner.patch(`${B}/${b3.id}`, { status: 'confirmed' })).body.brief.status).toBe('confirmed');
    const foreignOrg = await owner.post(`${ORCH}/finalize`, { briefId: b3.id });
    expect(foreignOrg.status).toBe(201);
    expect(parent.budget).toEqual({ totalMinor: 150000, currency: 'USD', perChannel: { ad_variants: 90000 } });
    expect(parent.utm.campaign).toBe('summer-launch');

    // Self-reference rejected; another org's campaign rejected; sibling accepted; clearing works.
    const self = await owner.patch(`${ORCH}/campaigns/${parent.id}`, { parentCampaignId: parent.id });
    expect(self.status).toBe(400);
    const crossOrg = await owner.patch(`${ORCH}/campaigns/${child.id}`, { parentCampaignId: foreignOrg.body.campaign.id });
    expect(crossOrg.status).toBe(400);
    const linked = await owner.patch(`${ORCH}/campaigns/${child.id}`, { parentCampaignId: parent.id });
    expect(linked.status).toBe(200);
    expect(linked.body.campaign.parentCampaignId).toBe(parent.id);
    const cleared = await owner.patch(`${ORCH}/campaigns/${child.id}`, { parentCampaignId: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.campaign.parentCampaignId).toBeUndefined();
  });

  it('duplicate-as-template: fresh draft, kernel dropped, version reset, provenance audited', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const src = (await owner.post(B, BRIEF_BODY(orgId))).body.brief;
    // The source HAS a kernel, so "kernel dropped" is something the copy can fail.
    await setKernel(tenantId, src.id, FINALIZE_KERNEL);
    const confirmed = await owner.patch(`${B}/${src.id}`, { status: 'confirmed' });
    expect(confirmed.body.brief.status).toBe('confirmed');
    expect(confirmed.body.brief.kernel).toBeTruthy();
    const dup = await owner.post(`${B}/${src.id}/duplicate`, {});
    expect(dup.status).toBe(201);
    const copy = dup.body.brief;
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('Summer Launch (copy)');
    expect(copy.status).toBe('draft');
    expect(copy.version).toBe(1);
    expect(copy.kernel).toBeUndefined();
    expect(copy.budget?.totalMinor).toBe(150000); // content copied
    // Provenance: the copy's `created` audit row names its source.
    const storage = __hostExtStorage();
    if (!storage) throw new Error('host-ext storage not initialized');
    await vi.waitFor(async () => {
      const rows = await storage.listAudit({ actionPrefix: 'campaign.brief.', resource: copy.id, limit: 50 });
      const created = rows.find((r) => r.action === 'campaign.brief.created');
      expect((created?.payload as { duplicatedFrom?: string } | undefined)?.duplicatedFrom).toBe(src.id);
    });
    const named = await owner.post(`${B}/${src.id}/duplicate`, { name: 'Autumn Launch' });
    expect(named.body.brief.name).toBe('Autumn Launch');
  });
});
