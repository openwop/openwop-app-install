/**
 * ADR 0946 P0 — the VariantSet store, service and routes.
 *
 * Exit criteria: a set in another org's campaign is a uniform 404; a member
 * edit makes a new version and the old one reads `superseded`.
 *
 * Sabotage witnesses (each reddens a named case):
 * - drop the `head.version !== baseVersion` check → "a stale baseVersion is a 409";
 * - write v(N+1) with `put` instead of `putIfAbsent` → "two concurrent revisions: one wins";
 * - resolve media with `getAssetByIdForTenant` (no org) → "a member cannot reference another org's media";
 * - derive status without `version < headVersion` → "a member edit makes v2 and supersedes v1";
 * - skip the campaign-delete hook → "deleting the campaign deletes its sets".
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';
import { createAsset, getAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { createBrief as createCreativeBrief } from '../src/features/creative-briefs/creativeBriefsService.js';
import { renderForBrief } from '../src/features/creative-briefs/render/renderService.js';
import { recordVerdict, FIDELITY_RULESET_VERSION } from '../src/host/creativeFidelity/index.js';
import { createTemplate } from '../src/features/email/emailService.js';
import { createPage, listVersions, offerSeedVersion } from '../src/features/cms/cmsService.js';
import { deleteCampaign, eraseCampaignAuthor, getCampaign, mutateCampaign } from '../src/features/campaign-orchestration/campaignService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  createVariantSet, deleteVariantSetsForCampaign, eraseVariantSetAuthor, reviseVariantSet, variantSetHash, listVariantSets, listVariantSetVersions,
} from '../src/features/campaign-orchestration/variants/variantSetService.js';
import { eraseCampaignVariantSetSubject } from '../src/features/campaign-orchestration/variants/erasure.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import type { Concept, VariantMember, VariantSet } from '../src/features/campaign-orchestration/variants/types.js';
import type { CampaignBrief } from '../src/features/campaign-brief/types.js';
import type { MarketingCampaign } from '../src/features/campaign-orchestration/types.js';

let BASE: string;
let server: http.Server;
let n = 0;
const TOGGLES = ['campaign-orchestration', 'campaign-brief', 'campaign-orchestration.variant-factory', 'creative-briefs', 'email', 'cms', 'commerce'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: { reason?: string } }
type SetRes = { variantSet: VariantSet; changed?: boolean } & Partial<ErrBody>;
interface Client { call: <T>(m: string, p: string, b?: unknown) => Promise<Res<T>> }
function client(): Client {
  let cookie = '';
  return {
    call: async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
    },
  };
}
const uniqEmail = (): string => `vs-${Date.now()}-${n++}@acme.test`;
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z' };

async function newOrg(owner: Client, name = 'Acme'): Promise<string> {
  const org = await owner.call<{ orgId: string }>('POST', '/host/openwop-app/orgs', { name });
  expect(org.status).toBe(201);
  return org.body.orgId;
}
async function campaignIn(owner: Client, tenantId: string, orgId: string): Promise<MarketingCampaign> {
  const brief = await owner.call<{ brief: CampaignBrief }>('POST', '/host/openwop-app/campaign-brief/briefs', { orgId, name: 'Q4', productName: 'FlashPick' });
  expect(brief.status, JSON.stringify(brief.body)).toBe(201);
  await setKernel(tenantId, brief.body.brief.id, KERNEL);
  const fin = await owner.call<{ campaign: MarketingCampaign }>('POST', '/host/openwop-app/campaign-orchestration/finalize', { briefId: brief.body.brief.id });
  expect(fin.status, JSON.stringify(fin.body)).toBe(201);
  return fin.body.campaign;
}
async function setup(): Promise<{ owner: Client; tenantId: string; orgId: string; campaign: MarketingCampaign; userId: string }> {
  const owner = client();
  const tenantId = `user:vs-${Date.now()}-${n++}`;
  const login = await owner.call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email: uniqEmail(), tenantId });
  expect(login.status).toBe(201);
  const orgId = await newOrg(owner);
  return { owner, tenantId, orgId, campaign: await campaignIn(owner, tenantId, orgId), userId: login.body.user.userId };
}
async function image(tenantId: string, orgId: string, hash = 'a'.repeat(64)): Promise<string> {
  const a = await createAsset({ tenantId, orgId, name: 'hero.png', contentType: 'image/png', sizeBytes: 10, storageRef: `ref-${n++}`, serveToken: `tok-${n++}`, uploadedBy: 'u', contentHash: hash });
  return a.assetId;
}

const CONCEPTS: Concept[] = [
  { conceptId: 'c1', axes: { angle: 'Saves an hour a day', hook: 'benefit', visual: 'product_hero', format: 'static' }, rationale: 'Time is the top objection.' },
  { conceptId: 'c2', axes: { angle: 'Teams like yours switched', hook: 'social_proof', visual: 'ugc', format: 'video' }, rationale: 'Proof for late adopters.' },
];
const copyMember = (headline: string, memberId = 'm1') => ({ memberId, conceptId: 'c1', channel: 'meta.feed', kind: 'copy', ref: { copy: { headline, primaryText: 'Try it free.' } } });
const path = (campaignId: string, rest = ''): string => `/host/openwop-app/campaign-orchestration/campaigns/${campaignId}/variant-sets${rest}`;

describe('ADR 0946 P0 — VariantSet routes', () => {
  it('commits legacy media bytes rather than an opaque storage address', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const contentBase64 = Buffer.from('legacy image bytes').toString('base64');
    const stored = await mediaStorage.put(tenantId, { contentBase64, contentType: 'image/png' });
    const asset = await createAsset({ tenantId, orgId, name: 'legacy.png', contentType: 'image/png', ...stored, uploadedBy: 'u' });
    const r = await owner.call<SetRes>('POST', path(campaign.id), {
      concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: asset.assetId } }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.variantSet.members[0]?.contentHash).toBe(createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex'));
  });

  it('resolves real render, verdict and product ids and refuses mismatched owner records', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const product = await createProduct({ tenantId, orgId, createdBy: 'u', type: 'physical', name: 'Mug', variants: [{ name: 'Blue' }] });
    const brief = await createCreativeBrief(tenantId, orgId, 'u', { title: 'Mug', sceneDescription: 'A blue mug on a studio table.' });
    const render = await renderForBrief(tenantId, orgId, 'u', { briefId: brief.briefId, templateId: 'meta.feed.1x1' });
    const assetId = render.mediaAssetId;
    const output = await getAsset(tenantId, orgId, assetId);
    if (!output?.contentHash) throw new Error('Rendered asset hash missing');
    const verdictId = `fvd:variant-${n++}`;
    await recordVerdict({ tenantId, orgId, verdictId, assetId, assetSha256: output.contentHash, productId: product.productId, mode: 'composite', sources: [], checks: [], outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: new Date().toISOString() });
    const member = { conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: assetId }, renderId: render.renderId, fidelityVerdictId: verdictId, productRef: { productId: product.productId, variantId: product.variants[0]?.variantId } };
    const accepted = await owner.call<SetRes>('POST', path(campaign.id), { concepts: CONCEPTS, members: [member] });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.variantSet.members[0]).toMatchObject({ renderId: render.renderId, fidelityVerdictId: verdictId, productRef: member.productRef });
    const otherAssetId = await image(tenantId, orgId);
    const otherOrg = await newOrg(owner, 'Other catalog');
    const foreignProduct = await createProduct({ tenantId, orgId: otherOrg, createdBy: 'u', type: 'physical', name: 'Other mug' });
    const wrongBytesId = `fvd:wrong-bytes-${n++}`;
    await recordVerdict({ tenantId, orgId, verdictId: wrongBytesId, assetId, assetSha256: 'b'.repeat(64), productId: product.productId, mode: 'composite', sources: [], checks: [], outcome: 'pass', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: new Date().toISOString() });
    for (const bad of [
      { ...member, ref: { mediaAssetId: otherAssetId } },
      { ...member, fidelityVerdictId: wrongBytesId },
      { ...member, productRef: { productId: foreignProduct.productId } },
      { ...member, productRef: { productId: product.productId, variantId: 'missing-variant' } },
    ]) {
      const refused = await owner.call<ErrBody>('POST', path(campaign.id), { concepts: CONCEPTS, members: [bad] });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body.details?.reason).toBe('variant_ref_not_found');
    }
  });

  it('refuses a template reference when Email is disabled', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const template = await createTemplate({ tenantId, orgId, name: 'Launch', subject: 'Hi', body: 'Hello', createdBy: 'u' });
    const toggle = getToggleDefault('email');
    if (!toggle) throw new Error('Email toggle missing');
    await saveConfig({ ...toggle, status: 'off' }, 'test');
    try {
      const refused = await owner.call<ErrBody>('POST', path(campaign.id), { concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'email', kind: 'email', ref: { emailTemplateId: template.templateId, version: 1 } }] });
      expect(refused.status).toBe(403);
    } finally { await saveConfig({ ...toggle, status: 'on' }, 'test'); }
  });

  // The campaign-orchestration → creative-briefs read (renderId validation) stays
  // undeclared in the ADR 0439 ratchet; this is its off-leg: the whole route 404s.
  it('refuses a render reference when Creative Briefs is disabled', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const brief = await createCreativeBrief(tenantId, orgId, 'u', { title: 'Mug', sceneDescription: 'A blue mug on a studio table.' });
    const render = await renderForBrief(tenantId, orgId, 'u', { briefId: brief.briefId, templateId: 'meta.feed.1x1' });
    const toggle = getToggleDefault('creative-briefs');
    if (!toggle) throw new Error('Creative Briefs toggle missing');
    await saveConfig({ ...toggle, status: 'off' }, 'test');
    try {
      const refused = await owner.call<ErrBody & { details?: { feature?: string } }>('POST', path(campaign.id), { concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: render.mediaAssetId }, renderId: render.renderId }] });
      expect(refused.status, JSON.stringify(refused.body)).toBe(404);
      expect(refused.body.details?.feature).toBe('creative-briefs');
    } finally { await saveConfig({ ...toggle, status: 'on' }, 'test'); }
  });

  it('a member edit makes v2 and supersedes v1 (exit criterion)', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const img = await image(tenantId, orgId);
    const created = await owner.call<SetRes>('POST', path(campaign.id), {
      concepts: CONCEPTS,
      members: [copyMember('Save an hour'), { memberId: 'm2', conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: img } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const v1 = created.body.variantSet;
    expect(v1).toMatchObject({ version: 1, status: 'draft', campaignId: campaign.id, orgId, headVersion: 1 });
    expect(v1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v1.members.find((m) => m.memberId === 'm2')?.contentHash).toBe('a'.repeat(64));

    const edited = await owner.call<SetRes>('PUT', path(campaign.id, `/${v1.setId}`), {
      baseVersion: 1, concepts: CONCEPTS,
      members: [copyMember('Get an hour back'), { memberId: 'm2', conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: img } }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    expect(edited.body).toMatchObject({ changed: true, variantSet: { version: 2, revisedFrom: 1, status: 'draft', setId: v1.setId } });
    expect(edited.body.variantSet.hash).not.toBe(v1.hash);

    const old = await owner.call<SetRes>('GET', path(campaign.id, `/${v1.setId}/versions/1`));
    expect(old.body.variantSet).toMatchObject({ version: 1, status: 'superseded', headVersion: 2, hash: v1.hash });
    // The old version's content is untouched.
    expect((old.body.variantSet.members[0].ref as { copy: Record<string, string> }).copy.headline).toBe('Save an hour');

    const versions = await owner.call<{ versions: VariantSet[] }>('GET', path(campaign.id, `/${v1.setId}/versions`));
    expect(versions.body.versions.map((v) => [v.version, v.status])).toEqual([[2, 'draft'], [1, 'superseded']]);
    const list = await owner.call<{ variantSets: VariantSet[] }>('GET', path(campaign.id));
    expect(list.body.variantSets.map((s) => [s.setId, s.version])).toEqual([[v1.setId, 2]]);
  });

  it('an unchanged revision is a no-op that returns the head', async () => {
    const { owner, campaign } = await setup();
    const v1 = (await owner.call<SetRes>('POST', path(campaign.id), { concepts: CONCEPTS, members: [copyMember('Same')] })).body.variantSet;
    const again = await owner.call<SetRes>('PUT', path(campaign.id, `/${v1.setId}`), { baseVersion: 1, concepts: [...CONCEPTS].reverse(), members: [copyMember('Same')] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ changed: false, variantSet: { version: 1, hash: v1.hash } });
  });

  it('a stale baseVersion is a 409', async () => {
    const { owner, campaign } = await setup();
    const v1 = (await owner.call<SetRes>('POST', path(campaign.id), { concepts: CONCEPTS, members: [copyMember('A')] })).body.variantSet;
    expect((await owner.call('PUT', path(campaign.id, `/${v1.setId}`), { baseVersion: 1, concepts: CONCEPTS, members: [copyMember('B')] })).status).toBe(201);
    const stale = await owner.call<ErrBody>('PUT', path(campaign.id, `/${v1.setId}`), { baseVersion: 1, concepts: CONCEPTS, members: [copyMember('C')] });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason).toBe('variant_set_stale');
  });

  it('a set in another org\'s campaign is a uniform 404, including through a crafted path', async () => {
    const { owner, tenantId, campaign } = await setup();
    const v1 = (await owner.call<SetRes>('POST', path(campaign.id), { concepts: CONCEPTS, members: [copyMember('A')] })).body.variantSet;
    // Same tenant, a second org and campaign the owner also holds: the set is
    // not reachable through the other campaign's path.
    const otherOrg = await newOrg(owner, 'Other');
    const other = await campaignIn(owner, tenantId, otherOrg);
    const crafted = await owner.call<ErrBody>('GET', path(other.id, `/${v1.setId}`));
    expect(crafted.status).toBe(404);
    expect((await owner.call('PUT', path(other.id, `/${v1.setId}`), { baseVersion: 1, concepts: CONCEPTS, members: [copyMember('X')] })).status).toBe(404);
    // A same-tenant non-member and a cross-tenant stranger both see 404.
    const member = client();
    expect((await member.call('POST', '/host/openwop-app/test/login', { email: uniqEmail(), tenantId })).status).toBe(201);
    expect((await member.call<ErrBody>('GET', path(campaign.id, `/${v1.setId}`))).status).toBe(404);
    expect((await member.call<ErrBody>('POST', path(campaign.id), { concepts: CONCEPTS })).status).toBe(404);
    const stranger = client();
    await stranger.call('POST', '/host/openwop-app/test/login', { email: uniqEmail() });
    const r = await stranger.call<ErrBody>('GET', path(campaign.id, `/${v1.setId}`));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('a member cannot reference another org\'s media', async () => {
    const { owner, tenantId, campaign } = await setup();
    const otherOrg = await newOrg(owner, 'Other');
    const foreign = await image(tenantId, otherOrg);
    const r = await owner.call<ErrBody>('POST', path(campaign.id), {
      concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: foreign } }],
    });
    expect(r.status).toBe(400);
    expect(r.body.details?.reason).toBe('variant_ref_not_found');
  });

  it('resolves email and landing refs in the campaign\'s org and hashes their content', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const tpl = await createTemplate({ tenantId, orgId, name: 'Launch', subject: 'Hi', body: 'Hello', createdBy: 'u' });
    const page = await createPage({ tenantId, orgId, title: 'Landing', createdBy: 'u' });
    await offerSeedVersion(page, { title: 'Landing B', sections: [] }, 'u');
    const pv = (await listVersions(tenantId, orgId, page.pageId))[0];
    const r = await owner.call<SetRes>('POST', path(campaign.id), {
      concepts: CONCEPTS,
      members: [
        { memberId: 'e', conceptId: 'c1', channel: 'email', kind: 'email', ref: { emailTemplateId: tpl.templateId, version: 1 } },
        { memberId: 'l', conceptId: 'c2', channel: 'landing', kind: 'landing', ref: { pageId: page.pageId, pageVersion: pv.version } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const byId = new Map(r.body.variantSet.members.map((m) => [m.memberId, m]));
    expect(byId.get('e')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(byId.get('l')?.ref).toEqual({ pageId: page.pageId, pageVersion: pv.version });
    // The same template version from another org does not resolve.
    const otherOrg = await newOrg(owner, 'Other');
    const foreign = await createTemplate({ tenantId, orgId: otherOrg, name: 'X', subject: 'X', body: 'X', createdBy: 'u' });
    const bad = await owner.call<ErrBody>('POST', path(campaign.id), {
      concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'email', kind: 'email', ref: { emailTemplateId: foreign.templateId, version: 1 } }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.details?.reason).toBe('variant_ref_not_found');
  });

  it('refuses invalid content with a typed 400, never a silent drop', async () => {
    const { owner, tenantId, orgId, campaign } = await setup();
    const bad = async (body: unknown): Promise<number> => (await owner.call('POST', path(campaign.id), body)).status;
    expect(await bad({ concepts: [] })).toBe(400);
    expect(await bad({ concepts: [{ ...CONCEPTS[0], axes: { ...CONCEPTS[0].axes, hook: 'shock' } }] })).toBe(400);
    expect(await bad({ concepts: [{ ...CONCEPTS[0], extra: 1 }] })).toBe(400);
    expect(await bad({ concepts: [CONCEPTS[0], CONCEPTS[0]] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [{ ...copyMember('A'), conceptId: 'nope' }] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [{ ...copyMember('A'), contentHash: 'f'.repeat(64) }] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [{ ...copyMember('A'), kind: 'image' }] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [{ ...copyMember('A'), channel: 'Meta Feed' }] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [copyMember('A'), copyMember('B')] })).toBe(400);
    // An image member must reference an image.
    const doc = await createAsset({ tenantId, orgId, name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, storageRef: 'r', serveToken: `t-${n++}`, uploadedBy: 'u' });
    expect(await bad({ concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'meta.feed', kind: 'image', ref: { mediaAssetId: doc.assetId } }] })).toBe(400);
    expect(await bad({ concepts: CONCEPTS, members: [{ conceptId: 'c1', channel: 'landing', kind: 'landing', ref: { pageId: 'nope', pageVersion: 1 } }] })).toBe(400);
    expect((await owner.call<{ variantSets: VariantSet[] }>('GET', path(campaign.id))).body.variantSets).toEqual([]);
  });

  it('a read-only member gets 403 on write', async () => {
    const { owner, campaign, orgId } = await setup();
    const viewer = client();
    const email = uniqEmail();
    const login = await viewer.call<{ user: { userId: string } }>('POST', '/host/openwop-app/test/login', { email, tenantId: campaign.tenantId });
    expect(login.status).toBe(201);
    const add = await owner.call('POST', `/host/openwop-app/orgs/${orgId}/members`, { displayName: 'Viewer', subject: login.body.user.userId, roles: ['viewer'] });
    expect(add.status, 'add viewer').toBeLessThan(300);
    expect((await viewer.call('GET', path(campaign.id))).status).toBe(200);
    expect((await viewer.call('POST', path(campaign.id), { concepts: CONCEPTS })).status).toBe(403);
  });

  it('404s when the variant-factory sub-toggle is off, with the parent on', async () => {
    const { owner, campaign } = await setup();
    const d = getToggleDefault('campaign-orchestration.variant-factory');
    if (!d) throw new Error('sub-toggle default not registered');
    expect(d.status).toBe('off');
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect((await owner.call('GET', path(campaign.id))).status).toBe(404);
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('deleting the campaign deletes its sets', async () => {
    const { owner, tenantId, campaign } = await setup();
    await owner.call<SetRes>('POST', path(campaign.id), { concepts: CONCEPTS, members: [copyMember('A')] });
    expect(await listVariantSets(tenantId, campaign.id)).toHaveLength(1);
    expect((await owner.call('DELETE', `/host/openwop-app/campaign-orchestration/campaigns/${campaign.id}`)).status).toBe(200);
    expect(await listVariantSets(tenantId, campaign.id)).toHaveLength(0);
  });
});

describe('ADR 0946 P0 — VariantSet service', () => {
  it('the hash ignores order and covers content', () => {
    const c = CONCEPTS;
    const m = (h: string, id: string): VariantMember => ({ memberId: id, conceptId: 'c1', channel: 'meta.feed', kind: 'copy', ref: { copy: { headline: h } }, contentHash: h });
    expect(variantSetHash(c, [m('a', 'x'), m('b', 'y')])).toBe(variantSetHash([...c].reverse(), [m('b', 'y'), m('a', 'x')]));
    expect(variantSetHash(c, [m('a', 'x')])).not.toBe(variantSetHash(c, [m('A', 'x')]));
  });

  it('a re-executed create or revise (same id, same content) returns its own row, never a duplicate', async () => {
    const { tenantId, campaign } = await setup();
    const fresh = await getCampaign(tenantId, campaign.id);
    if (!fresh) throw new Error('campaign missing');
    const content = (h: string) => ({ concepts: CONCEPTS, members: [{ memberId: 'm', conceptId: 'c1', channel: 'meta.feed', kind: 'copy' as const, ref: { copy: { headline: h } }, contentHash: h }] });
    const a = await createVariantSet(fresh, content('a'), 'u', { setId: 'vs_run1_node1', runId: 'run1' });
    const again = await createVariantSet(fresh, content('a'), 'u', { setId: 'vs_run1_node1', runId: 'run1' });
    expect(again).toMatchObject({ setId: a.setId, version: 1, hash: a.hash });
    await expect(createVariantSet(fresh, content('b'), 'u', { setId: 'vs_run1_node1' })).rejects.toMatchObject({ httpStatus: 409 });
    const r1 = await reviseVariantSet(fresh, a.setId, 1, content('b'), 'u');
    // The replayed revision arrives with base 1 after v2 landed: the same
    // content from the same base finds v2; different content is still a 409.
    const r2 = await reviseVariantSet(fresh, a.setId, 1, content('b'), 'u');
    await expect(reviseVariantSet(fresh, a.setId, 1, content('c'), 'u')).rejects.toMatchObject({ httpStatus: 409 });
    expect(r1?.set.version).toBe(2);
    expect(r2).toMatchObject({ changed: false, set: { version: 2 } });
    expect(await listVariantSets(tenantId, campaign.id)).toHaveLength(1);
  });

  it('two concurrent revisions of the same version: one wins, one is a 409', async () => {
    const { tenantId, campaign } = await setup();
    const fresh = await getCampaign(tenantId, campaign.id);
    if (!fresh) throw new Error('campaign missing');
    const content = (h: string) => ({ concepts: CONCEPTS, members: [{ memberId: 'm', conceptId: 'c1', channel: 'meta.feed', kind: 'copy' as const, ref: { copy: { headline: h } }, contentHash: h }] });
    const v1 = await createVariantSet(fresh, content('a'), 'u');
    const results = await Promise.allSettled([
      reviseVariantSet(fresh, v1.setId, 1, content('b'), 'u'),
      reviseVariantSet(fresh, v1.setId, 1, content('c'), 'u'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as { httpStatus: number }).httpStatus).toBe(409);
  });
});

describe('ADR 0946 P0 — subject erasure', () => {
  it('does not restore a retired campaign discovered before concurrent deletion', async () => {
    const { tenantId, campaign, userId } = await setup();
    const storage = hostExtStorage();
    const list = storage.kvList.bind(storage);
    let raced = false;
    const fault = vi.spyOn(storage, 'kvList').mockImplementation(async (prefix) => {
      const captured = await list(prefix);
      if (!raced && prefix === `hostext:campaign-orchestration:campaign:${tenantId}::`) {
        raced = true;
        await deleteCampaign(tenantId, campaign.id);
      }
      return captured;
    });
    try {
      expect(await eraseCampaignAuthor(tenantId, new Set([userId]), ERASED_USER_REF)).toBe(0);
      expect(raced).toBe(true);
      expect(await getCampaign(tenantId, campaign.id)).toBeNull();
      const raw = await storage.kvGet(`hostext:campaign-orchestration:campaign:${tenantId}::${campaign.id}`);
      expect(JSON.parse(raw ?? 'null')).toMatchObject({ retired: true, id: campaign.id });
    } finally { fault.mockRestore(); }
  });

  it('keeps concurrent campaign edits when tombstoning a discovered author', async () => {
    const { tenantId, campaign, userId } = await setup();
    const storage = hostExtStorage();
    const list = storage.kvList.bind(storage);
    let raced = false;
    const fault = vi.spyOn(storage, 'kvList').mockImplementation(async (prefix) => {
      const captured = await list(prefix);
      if (!raced && prefix === `hostext:campaign-orchestration:campaign:${tenantId}::`) {
        raced = true;
        await mutateCampaign(tenantId, campaign.id, (current) => ({ ...current, name: 'Concurrent edit', version: 7 }));
      }
      return captured;
    });
    try {
      expect(await eraseCampaignAuthor(tenantId, new Set([userId]), ERASED_USER_REF)).toBe(1);
      expect(raced).toBe(true);
      expect(await getCampaign(tenantId, campaign.id)).toMatchObject({ name: 'Concurrent edit', version: 7, createdBy: ERASED_USER_REF });
    } finally { fault.mockRestore(); }
  });

  it('does not restore a variant version removed after its discovery read', async () => {
    const { tenantId, campaign } = await setup();
    const created = await createVariantSet(campaign, { concepts: CONCEPTS, members: [] }, 'user:erase-me');
    const storage = hostExtStorage();
    const read = storage.kvGet.bind(storage);
    let raced = false;
    const key = `hostext:campaign-orchestration:variantset:${tenantId}::${campaign.id}::${created.setId}::v000001`;
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (id) => {
      const captured = await read(id);
      if (!raced && id === key) {
        raced = true;
        await deleteVariantSetsForCampaign(tenantId, campaign.id);
      }
      return captured;
    });
    try {
      expect(await eraseVariantSetAuthor(tenantId, new Set(['user:erase-me']), ERASED_USER_REF)).toBe(0);
      expect(raced).toBe(true);
      expect(await listVariantSetVersions(tenantId, campaign.id, created.setId)).toEqual([]);
      expect(await storage.kvGet(key)).toBeNull();
    } finally { fault.mockRestore(); }
  });

  it('reports retryable erasure contention rather than claiming an unchanged author was erased', async () => {
    const { tenantId, campaign } = await setup();
    const created = await createVariantSet(campaign, { concepts: CONCEPTS, members: [] }, 'user:erase-me');
    const storage = hostExtStorage();
    const swap = storage.kvCompareAndSwap.bind(storage);
    const key = `hostext:campaign-orchestration:variantset:${tenantId}::${campaign.id}::${created.setId}::v000001`;
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === key) return { swapped: false, actual: await storage.kvGet(key) };
      return swap(...args);
    });
    try {
      await expect(eraseVariantSetAuthor(tenantId, new Set(['user:erase-me']), ERASED_USER_REF)).rejects.toMatchObject({ httpStatus: 409 });
      expect((await listVariantSetVersions(tenantId, campaign.id, created.setId))[0]?.createdBy).toBe('user:erase-me');
    } finally { fault.mockRestore(); }
  });

  it('tombstones the author on every version and on the campaign, keeping the rows and hash', async () => {
    const { tenantId, campaign, userId } = await setup();
    expect(campaign.createdBy).toBe(userId);
    const fresh = await getCampaign(tenantId, campaign.id);
    if (!fresh) throw new Error('campaign missing');
    const content = (h: string) => ({ concepts: CONCEPTS, members: [{ memberId: 'm', conceptId: 'c1', channel: 'meta.feed', kind: 'copy' as const, ref: { copy: { headline: h } }, contentHash: h }] });
    const v1 = await createVariantSet(fresh, content('a'), 'user:erase-me');
    await reviseVariantSet(fresh, v1.setId, 1, content('b'), 'user:erase-me');
    const report = await eraseCampaignVariantSetSubject(tenantId, 'user:erase-me');
    expect(report.rowsTouched).toBe(2);
    const versions = await listVariantSetVersions(tenantId, campaign.id, v1.setId);
    expect(versions.map((v) => v.createdBy)).toEqual([ERASED_USER_REF, ERASED_USER_REF]);
    expect(versions[1].hash).toBe(v1.hash);
    expect((await eraseCampaignVariantSetSubject('other-tenant', 'user:erase-me')).rowsTouched).toBe(0);
    // The campaign's author.
    expect((await eraseCampaignVariantSetSubject(tenantId, userId)).rowsTouched).toBe(1);
    expect((await getCampaign(tenantId, campaign.id))?.createdBy).toBe(ERASED_USER_REF);
  });
});
