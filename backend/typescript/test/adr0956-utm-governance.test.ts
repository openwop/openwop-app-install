/**
 * ADR 0956 P0 (D5/D6) — tracked URLs and UTM governance:
 *   - host `buildTrackedUrl` + `lintTrackedUrl` (pure);
 *   - the per-org UTM policy routes (default, closed-world, CAS, org-scoped);
 *   - the lint route and the `utm-lint` node;
 *   - human-confirmed utm_campaign aliases and the unattributed triage list;
 *   - `publish-ad-variants` stamps through the host helper and refuses a link
 *     that breaks the client's policy BEFORE dispatch;
 *   - subject erasure tombstones the editor, keeps the org's configuration.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildTrackedUrl, lintTrackedUrl, DEFAULT_UTM_POLICY } from '../src/host/trackedUrl.js';
import { getUtmPolicy, listAliases, setAlias, setUtmPolicy, parseUtmPolicy } from '../src/features/campaign-intel/utmGovernance.js';
import { eraseCampaignIntelSubject } from '../src/features/campaign-intel/erasure.js';
import { buildAttribution } from '../src/features/campaign-intel/attribution.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { recordEvent } from '../src/features/analytics/analyticsService.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { nodes as channelNodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';
import { nodes as intelNodes } from '../../../packs/feature.campaign-intel.nodes/index.mjs';

describe('ADR 0956 D5 — buildTrackedUrl / lintTrackedUrl (pure)', () => {
  it('stamps the variant key as utm_content and our ad reference as utm_id; params already on the URL win', () => {
    const out = new URL(buildTrackedUrl('https://ex.com/p?utm_source=newsletter', { source: 'meta', medium: 'paid-social', campaign: 'launch' }, { fallbackCampaign: 'b1', variantKey: 'arm-b', adRef: 'ad-77' }));
    expect(out.searchParams.get('utm_source')).toBe('newsletter'); // the URL's own value wins
    expect(out.searchParams.get('utm_medium')).toBe('paid-social');
    expect(out.searchParams.get('utm_campaign')).toBe('launch');
    expect(out.searchParams.get('utm_content')).toBe('arm-b');
    expect(out.searchParams.get('utm_id')).toBe('ad-77');
  });

  it('a brief utm.content outranks the variant key', () => {
    const out = new URL(buildTrackedUrl('https://ex.com/', { content: 'hero' }, { fallbackCampaign: 'b1', variantKey: 'arm-b' }));
    expect(out.searchParams.get('utm_content')).toBe('hero');
  });

  it('preserves a protocol-relative destination and refuses executable or empty URLs even without a policy', () => {
    expect(buildTrackedUrl('//elsewhere.example/offer', undefined, { fallbackCampaign: 'launch' }))
      .toBe('//elsewhere.example/offer?utm_campaign=launch');
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', '']) {
      expect(() => buildTrackedUrl(url, undefined, { fallbackCampaign: 'launch' })).toThrow(/invalid/);
      expect(lintTrackedUrl(url, DEFAULT_UTM_POLICY)).toEqual([expect.objectContaining({ rule: 'invalid_url' })]);
    }
  });

  it('lints required params, the medium vocabulary and case', () => {
    expect(lintTrackedUrl('https://ex.com/?utm_source=meta&utm_medium=cpc&utm_campaign=launch', DEFAULT_UTM_POLICY)).toEqual([]);
    const v = lintTrackedUrl('https://ex.com/?utm_source=Meta&utm_medium=billboard', DEFAULT_UTM_POLICY);
    expect(v.map((x) => `${x.param}:${x.rule}`).sort()).toEqual(['utm_campaign:missing', 'utm_medium:not_allowed', 'utm_source:case']);
    // A relative link is linted, not reported invalid.
    expect(lintTrackedUrl('/p?utm_source=a&utm_medium=email&utm_campaign=c', DEFAULT_UTM_POLICY)).toEqual([]);
  });

  it('parseUtmPolicy is closed-world', () => {
    expect(() => parseUtmPolicy({ mediums: ['cpc'], extra: 1 })).toThrow(/Unknown field/);
    expect(() => parseUtmPolicy({ required: ['utm_nope'] })).toThrow(/required/);
    expect(() => parseUtmPolicy({ case: 'upper' })).toThrow(/case/);
    expect(parseUtmPolicy({ sources: ['Meta', 'Meta'] }).sources).toEqual(['meta']); // deduped + lowered
  });
});

interface Res { status: number; body: Record<string, unknown> }
let BASE = '';
let server: http.Server;
function client(): { call: (method: string, path: string, body?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
  };
}

const KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

async function makeCampaign(tenantId: string, orgId: string, name: string, utm: Record<string, string>): Promise<{ campaignId: string; briefId: string }> {
  const brief = await createBrief(tenantId, orgId, 'test', {
    name, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }], utm,
  });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, 'test');
  const campaign = await finalizeFromBrief(tenantId, { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm }, 'test');
  return { campaignId: campaign.id, briefId: brief.id };
}

async function setIntel(status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault('campaign-intel');
  if (!d) throw new Error('campaign-intel toggle default missing');
  await saveConfig({ ...d, status }, 'test');
}

describe('ADR 0956 D5 — UTM governance over HTTP + the publish path', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  // NOT a personal `user:` tenant: there every signed-in caller is an implicit owner.
  const tenantId = `utm-${Date.now()}`;
  let orgId = '';
  let ownerId = '';
  let peerId = '';
  const owner = client();
  const peer = client();

  it('setup: an owner with an org and a same-tenant non-member', async () => {
    await setIntel('on');
    const ownerLogin = await owner.call('POST', '/host/openwop-app/test/login', { email: `utm-o-${Date.now()}@acme.test`, tenantId });
    expect(ownerLogin.status).toBe(201);
    ownerId = String((ownerLogin.body.user as { userId: string }).userId);
    const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client A' });
    expect(org.status).toBe(201);
    orgId = String(org.body.orgId);
    const peerLogin = await peer.call('POST', '/host/openwop-app/test/login', { email: `utm-p-${Date.now()}@acme.test`, tenantId });
    expect(peerLogin.status).toBe(201);
    peerId = String((peerLogin.body.user as { userId: string }).userId);
  });

  it('policy: default at version 0, CAS on version, stale → 409, invalid → 400, non-member write → 403', async () => {
    const base = `/host/openwop-app/campaign-intel/orgs/${orgId}/utm-policy`;
    const dflt = await owner.call('GET', base);
    expect(dflt.status).toBe(200);
    expect(dflt.body).toMatchObject({ version: 0, isDefault: true });

    expect((await owner.call('PUT', base, { mediums: ['cpc'] })).status).toBe(400); // expectedVersion required
    expect((await owner.call('PUT', base, { mediums: ['cpc'], bogus: true, expectedVersion: 0 })).status).toBe(400);
    expect((await peer.call('PUT', base, { mediums: ['cpc'], expectedVersion: 0 })).status).toBe(403);

    const saved = await owner.call('PUT', base, { sources: ['meta', 'google'], mediums: ['cpc', 'paid-social'], expectedVersion: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, isDefault: false });

    const stale = await owner.call('PUT', base, { mediums: ['email'], expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('utm_policy_stale');
    expect((await getUtmPolicy(tenantId, orgId)).policy.mediums).toEqual(['cpc', 'paid-social']); // the stale write landed nothing
  });

  it('lint route: per-URL violations against the saved policy; bounded input', async () => {
    const base = `/host/openwop-app/campaign-intel/orgs/${orgId}/utm-lint`;
    const out = await owner.call('POST', base, { urls: ['https://ex.com/?utm_source=meta&utm_medium=cpc&utm_campaign=c', 'https://ex.com/?utm_source=tiktok&utm_medium=cpc&utm_campaign=c'] });
    expect(out.status).toBe(200);
    const results = out.body.results as Array<{ violations: Array<{ param: string; rule: string }> }>;
    expect(results[0]?.violations).toEqual([]);
    expect(results[1]?.violations).toEqual([expect.objectContaining({ param: 'utm_source', rule: 'not_allowed' })]);
    expect((await owner.call('POST', base, { urls: [] })).status).toBe(400);
  });

  it('aliases: join-key conflict 409, foreign campaign 400, and an aliased conversion is attributed; triage lists the rest', async () => {
    const mine = await makeCampaign(tenantId, orgId, 'Launch', { campaign: 'launch' });
    const foreign = await makeCampaign(tenantId, 'org-other', 'Theirs', { campaign: 'theirs' });
    const base = `/host/openwop-app/campaign-intel/orgs/${orgId}/utm-aliases`;

    const conflict = await owner.call('PUT', base, { utmCampaign: 'launch', campaignId: mine.campaignId });
    expect(conflict.status).toBe(409);
    expect(JSON.stringify(conflict.body)).toContain('utm_alias_conflicts_join_key');
    expect((await owner.call('PUT', base, { utmCampaign: 'Launch_2026', campaignId: foreign.campaignId })).status).toBe(400);
    expect((await peer.call('PUT', base, { utmCampaign: 'Launch_2026', campaignId: mine.campaignId })).status).toBe(403);

    for (const [key, n] of [['launch', 1], ['Launch_2026', 2], ['typo-x', 3]] as const) {
      for (let i = 0; i < n; i++) await recordEvent({ tenantId, orgId, raw: { type: 'conversion', path: '/thanks', sessionKey: `${key}-${i}`, utm: { campaign: key } } });
    }
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', path: '/thanks', sessionKey: 'none-0' } });

    const before = await buildAttribution(tenantId, orgId);
    expect(before.rows.find((r) => r.campaignId === mine.campaignId)?.webConversions).toBe(1);
    expect(before.unattributedByCampaign).toEqual([{ utmCampaign: 'typo-x', count: 3 }, { utmCampaign: 'Launch_2026', count: 2 }, { utmCampaign: null, count: 1 }]);

    const ok = await owner.call('PUT', base, { utmCampaign: 'Launch_2026', campaignId: mine.campaignId });
    expect(ok.status).toBe(200);
    const after = await buildAttribution(tenantId, orgId);
    const row = after.rows.find((r) => r.campaignId === mine.campaignId);
    expect(row?.webConversions).toBe(3);
    expect(row?.lineage.aliasedConversions).toBe(2);
    expect(after.unattributedConversions).toBe(4);
    expect(after.unattributedByCampaign).toEqual([{ utmCampaign: 'typo-x', count: 3 }, { utmCampaign: null, count: 1 }]);

    expect((await owner.call('DELETE', `${base}/Launch_2026`)).status).toBe(200);
    expect((await owner.call('DELETE', `${base}/Launch_2026`)).status).toBe(404);
    expect((await buildAttribution(tenantId, orgId)).rows.find((r) => r.campaignId === mine.campaignId)?.webConversions).toBe(1);
  });

  it('trackedUrl: unlinted while campaign-intel is off; linted against the brief org policy when on', async () => {
    const { briefId } = await makeCampaign(tenantId, orgId, 'Tracked', { source: 'tiktok', medium: 'cpc', campaign: 'tracked' });
    const surface = buildCampaignBriefSurface({ tenantId });
    await setIntel('off');
    const off = await surface.trackedUrl({ briefId, url: 'https://ex.com/lp', variantKey: 'a', adRef: 'ad-1' });
    expect(off).toMatchObject({ linted: false, violations: [] });
    expect(String(off.url)).toContain('utm_id=ad-1');
    await setIntel('on');
    const on = await surface.trackedUrl({ briefId, url: 'https://ex.com/lp' });
    expect(on).toMatchObject({ linted: true, policyVersion: 1 });
    expect(on.violations).toEqual([expect.objectContaining({ param: 'utm_source', rule: 'not_allowed' })]);
  });

  it('trackedUrl is org-scoped: a run whose person cannot read the brief\'s client org gets a uniform not-found (cross-client witness)', async () => {
    const d = getToggleDefault('campaign-brief');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    const { briefId } = await makeCampaign(tenantId, orgId, 'Scoped', { source: 'meta', medium: 'cpc', campaign: 'scoped' });
    // Through the real seam, as a run would call it.
    const asOwner = buildFeatureSurfaces({ tenantId, actingUserId: ownerId })['campaign-brief']!;
    const ok = await asOwner.trackedUrl!({ briefId, url: 'https://ex.com/lp' });
    expect(String(ok.url)).toContain('utm_campaign=scoped');
    // The peer is in the same tenant but not a member of the brief's client org.
    const asPeer = buildFeatureSurfaces({ tenantId, actingUserId: peerId })['campaign-brief']!;
    await expect(asPeer.trackedUrl!({ briefId, url: 'https://ex.com/lp' })).rejects.toMatchObject({ code: 'not_found' });
    // Naming a different org than the brief's is the same not-found, never the brief.
    await expect(asOwner.trackedUrl!({ briefId, orgId: 'org-other', url: 'https://ex.com/lp' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('publish-ad-variants refuses a link that breaks the policy BEFORE dispatch, and passes a clean one with adRef', async () => {
    const bad = await makeCampaign(tenantId, orgId, 'Bad', { source: 'tiktok', medium: 'cpc', campaign: 'bad' });
    const good = await makeCampaign(tenantId, orgId, 'Good', { source: 'meta', medium: 'paid-social', campaign: 'good' });
    const surface = buildCampaignBriefSurface({ tenantId });
    const draft = (briefId: string) => ({ channel: 'ad_variants', briefId, platformSets: [{ platform: 'Meta', variants: [{ headline: 'H' }] }] });
    const sent: Array<Record<string, unknown>> = [];
    const ads = { publishAd: async (a: Record<string, unknown>) => { sent.push(a); return { outcome: 'published', platform: 'meta', platformCampaignId: 'c1', platformAdIds: [], status: 'paused' }; } };
    const publish = channelNodes['feature.campaign-channels.nodes.publish-ad-variants'];

    const refused = await publish({ features: { 'campaign-brief': surface, documents: { createDraftDocument: async () => ({}) } }, ads, inputs: { draft: draft(bad.briefId), adAccountId: '1', landingUrl: 'https://ex.com/lp' }, runId: 'r1', nodeId: 'n1' });
    expect(refused.status).toBe('failed');
    expect(refused.error?.code).toBe('utm_policy_violation');
    expect(refused.error).toMatchObject({ policyVersion: 1 });
    expect(sent).toHaveLength(0); // nothing reached the adapter

    const ok = await publish({ features: { 'campaign-brief': surface, documents: { createDraftDocument: async () => ({}) } }, ads, inputs: { draft: draft(good.briefId), adAccountId: '1', landingUrl: 'https://ex.com/lp', adRef: 'ad-9', variantKey: 'arm-a' }, runId: 'r1', nodeId: 'n2' });
    expect(ok.status).toBe('success');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.adRef).toBe('ad-9');
    expect(ok.outputs?.utmCheck).toEqual({ linted: true, policyVersion: 1 }); // the policy that judged it, for fork lineage
    const landing = new URL(String(sent[0]?.landingUrl));
    expect(landing.searchParams.get('utm_campaign')).toBe('good');
    expect(landing.searchParams.get('utm_content')).toBe('arm-a');
    expect(landing.searchParams.get('utm_id')).toBe('ad-9');

    // Version skew: a host without the helper fails typed, never sends an untracked link.
    const skew = await publish({ features: { 'campaign-brief': {}, documents: { createDraftDocument: async () => ({}) } }, ads, inputs: { draft: draft(good.briefId), adAccountId: '1', landingUrl: 'https://ex.com/lp' }, runId: 'r1', nodeId: 'n3' });
    expect(skew.error?.code).toBe('host_capability_missing');
    expect(sent).toHaveLength(1);
  });

  it('utm-lint node: typed failure with per-link results; success passes the results through', async () => {
    const node = intelNodes['feature.campaign-intel.nodes.utm-lint'];
    const optimizeBudget = async () => ({}); // ensureIntel's surface probe
    const ci = { optimizeBudget, utmLint: async (a: { orgId: string; urls: string[] }) => ({ policyVersion: 1, results: a.urls.map((url) => ({ url, violations: url.includes('bad') ? [{ param: 'utm_source', rule: 'missing', message: 'x' }] : [] })) }) };
    const fail = await node({ features: { 'campaign-intel': ci }, inputs: { orgId, urls: ['https://ex.com/bad', 'https://ex.com/ok'] } });
    expect(fail.status).toBe('failed');
    expect(fail.error?.code).toBe('utm_policy_violation');
    expect(fail.error).toMatchObject({ results: [expect.objectContaining({ url: 'https://ex.com/bad' })] }); // only the failing link
    const pass = await node({ features: { 'campaign-intel': ci }, inputs: { orgId, urls: ['https://ex.com/ok'] } });
    expect(pass.status).toBe('success');
    expect((await node({ features: { 'campaign-intel': { optimizeBudget } }, inputs: { orgId, urls: [] } })).error?.code).toBe('host_capability_missing');
  });

  it('erasure tombstones the editor and keeps the org configuration; it never sweeps unscoped', async () => {
    const T = `utm-erase-${Date.now()}`;
    const { campaignId } = await makeCampaign(T, 'org-e', 'E', { campaign: 'e-key' });
    await setUtmPolicy(T, 'org-e', parseUtmPolicy({ mediums: ['cpc'] }), 0, 'user:alice');
    await setAlias(T, 'org-e', 'e-typo', campaignId, 'user:alice');
    expect((await eraseCampaignIntelSubject(T, '')).rowsTouched).toBe(0);
    expect((await eraseCampaignIntelSubject(T, 'user:alice')).rowsTouched).toBe(2);
    const policy = await getUtmPolicy(T, 'org-e');
    expect(policy.policy.mediums).toEqual(['cpc']);
    const [alias] = await listAliases(T, 'org-e');
    expect(alias?.campaignId).toBe(campaignId);
    expect(alias?.createdBy).toBe(ERASED_USER_REF);
  });
});
