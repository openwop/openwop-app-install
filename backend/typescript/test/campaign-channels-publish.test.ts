/**
 * Campaign Studio publish last-mile (ADR 0162) — the two publish nodes
 * (publish-landing-page / publish-email-sequence) over the cms + email feature
 * surfaces. Covers: the draft→entity mappers; fail-closed when the owning surface
 * is absent; org resolution from the brief; the real-surface delegation creating
 * DRAFT-only entities; replay idempotency (a re-run never duplicates); and tenant
 * isolation (the write keys on the scope tenant, never on args).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { nodes as nodePack } from '../../../packs/feature.campaign-channels.nodes/index.mjs';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildCmsSurface } from '../src/features/cms/surface.js';
import { buildEmailSurface } from '../src/features/email/surface.js';
import { listPages, getPage, __resetCms } from '../src/features/cms/cmsService.js';
import { listTemplates, listCampaigns, __resetEmailStore } from '../src/features/email/emailService.js';

let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
afterAll(async () => { await storage.close(); __resetHostExtPersistence(); });

const publishLP = nodePack['feature.campaign-channels.nodes.publish-landing-page'];
const publishEmail = nodePack['feature.campaign-channels.nodes.publish-email-sequence'];

const briefSurface = (orgId = 'o1') => ({
  assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId }, kernel: { headline: 'H' } }),
});

const landingDraft = {
  channel: 'landing_page', briefId: 'b1', title: 'Pick Faster',
  sections: [
    { type: 'hero', heading: 'Pick faster', body: 'The fastest checkout.', ctaText: 'Get a demo' },
    { type: 'features', heading: 'Why us', body: 'We are 40% faster.' },
    { type: 'cta', heading: 'Ready?', body: 'Start today', ctaText: 'Sign up' },
  ],
};

const emailDraft = {
  channel: 'email_sequence', briefId: 'b1',
  emails: [
    { position: 1, subjectLines: ['Welcome', 'Hi there'], body: 'Email one body', ctaText: 'Learn more', sendDelayDays: 0 },
    { position: 2, subjectLines: ['Following up'], body: 'Email two body', sendDelayDays: 3 },
  ],
};

describe('publish-landing-page — mapper + fail-closed', () => {
  it('fails closed when ctx.features.cms is absent', async () => {
    const out = await publishLP({ features: {}, inputs: { draft: landingDraft } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
  });

  it('fails when the org cannot be resolved (no orgId, no brief surface)', async () => {
    const out = await publishLP({ features: { cms: { createDraftPage: async () => ({}) } }, inputs: { draft: { sections: [{ heading: 'x' }] } } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('org_required');
  });

  it('maps first section → hero, rest → richText (+ cta), and resolves orgId from the brief', async () => {
    let captured: any;
    const cms = { createDraftPage: async (a: any) => { captured = a; return { pageId: 'page:x', slug: 'pick-faster', status: 'draft', title: a.title }; } };
    const out = await publishLP({ features: { cms, 'campaign-brief': briefSurface('org-7') }, inputs: { draft: landingDraft }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(captured.orgId).toBe('org-7');
    expect(captured.pageId).toBe('page:r1:n1'); // deterministic idem key
    const types = captured.sections.map((s: any) => s.type);
    expect(types).toEqual(['hero', 'richText', 'richText', 'cta']);
    expect(captured.sections[0].data).toMatchObject({ heading: 'Pick faster', subheading: 'The fastest checkout.', ctaLabel: 'Get a demo' });
    expect(captured.sections[3].data).toMatchObject({ label: 'Sign up' });
  });
});

describe('publish-email-sequence — mapper + fail-closed', () => {
  it('fails closed when ctx.features.email is absent', async () => {
    const out = await publishEmail({ features: {}, inputs: { draft: emailDraft } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
  });

  it('rejects an empty sequence', async () => {
    const out = await publishEmail({ features: { email: { createDraftCampaign: async () => ({}) }, 'campaign-brief': briefSurface() }, inputs: { draft: { emails: [], briefId: 'b1' } } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('empty_sequence');
  });

  it('passes the emails + a deterministic idemBase through to the surface', async () => {
    let captured: any;
    const email = { createDraftCampaign: async (a: any) => { captured = a; return { campaignIds: ['c1', 'c2'], templateIds: ['t1', 't2'], steps: 2 }; } };
    const out = await publishEmail({ features: { email, 'campaign-brief': briefSurface('org-9') }, inputs: { draft: emailDraft, stage: 'lead' }, runId: 'r2', nodeId: 'n2' });
    expect(out.status).toBe('success');
    expect(captured.orgId).toBe('org-9');
    expect(captured.idemBase).toBe('r2:n2');
    expect(captured.stage).toBe('lead');
    expect(captured.emails).toHaveLength(2);
  });
});

describe('real cms surface delegation — DRAFT-only + idempotent + tenant-isolated', () => {
  beforeEach(async () => { await __resetCms(); });

  it('creates a real DRAFT page, and a replay returns the SAME page (no duplicate)', async () => {
    const cms = buildCmsSurface({ tenantId: 't1', runId: 'run-A' });
    const sections = [{ type: 'hero', data: { heading: 'Hello' } }];
    const first = await cms.createDraftPage({ orgId: 'o1', title: 'My Page', sections, pageId: 'page:run-A:n1' });
    expect(first.status).toBe('draft'); // never published by the surface
    const pages1 = await listPages('t1', 'o1');
    expect(pages1).toHaveLength(1);

    // Replay: same deterministic pageId → same page, store unchanged.
    const second = await cms.createDraftPage({ orgId: 'o1', title: 'My Page', sections, pageId: 'page:run-A:n1' });
    expect(second.pageId).toBe(first.pageId);
    expect(await listPages('t1', 'o1')).toHaveLength(1);
    const stored = await getPage('t1', 'o1', String(first.pageId));
    expect(stored?.status).toBe('draft');
  });

  it('end-to-end: the publish node maps a full draft through the REAL surface without any section throwing', async () => {
    // The mapper output (hero + richText + empty-ish richText + cta) must survive
    // cmsService.buildSectionData's per-type validation — no required-field throw.
    const cms = buildCmsSurface({ tenantId: 't1', runId: 'run-E2E' });
    const out = await publishLP({ features: { cms, 'campaign-brief': briefSurface('o1') }, inputs: { draft: landingDraft }, runId: 'run-E2E', nodeId: 'n1' });
    expect(out.status).toBe('success');
    const stored = await getPage('t1', 'o1', (out.outputs as any).page.pageId);
    expect(stored?.status).toBe('draft');
    expect(stored?.sections.map((s) => s.type)).toEqual(['hero', 'richText', 'richText', 'cta']);
    expect(stored?.sections[0].data).toMatchObject({ heading: 'Pick faster' });
  });

  it('keys the write on the scope tenant — a different tenant cannot see the page', async () => {
    const cms = buildCmsSurface({ tenantId: 't1', runId: 'run-B' });
    await cms.createDraftPage({ orgId: 'o1', title: 'Tenant1 Page', sections: [{ type: 'hero', data: { heading: 'H' } }], pageId: 'page:run-B:n1' });
    expect(await listPages('t1', 'o1')).toHaveLength(1);
    expect(await listPages('t2', 'o1')).toHaveLength(0); // tenant isolation
  });
});

describe('real email surface delegation — one draft template+campaign per step, idempotent, unsent', () => {
  beforeEach(async () => { await __resetEmailStore(); });

  it('publishes a 2-email sequence as 2 draft templates + 2 draft campaigns (nothing orphaned, nothing sent)', async () => {
    const email = buildEmailSurface({ tenantId: 't1', runId: 'run-E' });
    const res = await email.createDraftCampaign({ orgId: 'o1', name: 'Drip', emails: emailDraft.emails, stage: 'lead', idemBase: 'run-E:n1' });
    expect(res.steps).toBe(2);
    const tpls = await listTemplates('t1', 'o1');
    const cmps = await listCampaigns('t1', 'o1');
    expect(tpls).toHaveLength(2);
    expect(cmps).toHaveLength(2);
    // every campaign references a real template (no orphans) and is DRAFT (unsent)
    for (const c of cmps) {
      expect(c.status).toBe('draft');
      expect(tpls.some((t) => t.templateId === c.templateId)).toBe(true);
    }
    // subject = first variant; stage carried onto the audience
    expect(tpls.some((t) => t.subject === 'Welcome')).toBe(true);
    expect(cmps.every((c) => c.audience.stage === 'lead')).toBe(true);
  });

  it('a replay reuses the same templates + campaigns (deterministic ids, no duplicates)', async () => {
    const email = buildEmailSurface({ tenantId: 't1', runId: 'run-E' });
    const a = await email.createDraftCampaign({ orgId: 'o1', name: 'Drip', emails: emailDraft.emails, idemBase: 'run-E:n1' });
    const b = await email.createDraftCampaign({ orgId: 'o1', name: 'Drip', emails: emailDraft.emails, idemBase: 'run-E:n1' });
    expect(b.templateIds).toEqual(a.templateIds);
    expect(b.campaignIds).toEqual(a.campaignIds);
    expect(await listTemplates('t1', 'o1')).toHaveLength(2);
    expect(await listCampaigns('t1', 'o1')).toHaveLength(2);
  });

  it('ignores an invalid stage rather than writing a bad audience', async () => {
    const email = buildEmailSurface({ tenantId: 't1', runId: 'run-F' });
    await email.createDraftCampaign({ orgId: 'o1', name: 'Drip', emails: [emailDraft.emails[0]], stage: 'not-a-stage', idemBase: 'run-F:n1' });
    const cmps = await listCampaigns('t1', 'o1');
    expect(cmps[0].audience.stage).toBeUndefined();
  });
});
