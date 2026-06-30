/**
 * Campaign Studio publish-to-documents handoff (ADR 0166) — the three publish nodes
 * (publish-ad-variants / publish-creative-briefs / publish-social-posts) over the
 * documents feature surface. Covers: the draft→Markdown mappers; fail-closed when the
 * surface is absent; empty-draft rejection; the real createDraftDocument delegation
 * creating a DRAFT document + version; replay idempotency (a re-run reuses the same
 * doc+version, no duplicate container); tenant isolation; and the empty-content guard.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { nodes as nodePack } from '../../../packs/feature.campaign-channels.nodes/index.mjs';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildDocumentsSurface } from '../src/features/documents/surface.js';
import { listDocuments, getDocument, listVersions, __resetDocumentsStore } from '../src/features/documents/documentsService.js';

let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
afterAll(async () => { await storage.close(); __resetHostExtPersistence(); });

const publishAd = nodePack['feature.campaign-channels.nodes.publish-ad-variants'];
const publishCreative = nodePack['feature.campaign-channels.nodes.publish-creative-briefs'];
const publishSocial = nodePack['feature.campaign-channels.nodes.publish-social-posts'];

const briefSurface = (orgId = 'o1') => ({
  assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId }, kernel: { headline: 'H' } }),
});

const adDraft = {
  channel: 'ad_variants', briefId: 'b1',
  platformSets: [
    { platform: 'Google', variants: [{ headline: 'Pick faster', description: '40% faster checkout', cta: 'Demo' }] },
    { platform: 'Meta', variants: [{ headline: 'Shop quick', description: 'Save time', cta: 'Shop' }] },
  ],
};
const creativeDraft = {
  channel: 'creative_briefs', briefId: 'b1',
  briefs: [{ format: 'Hero banner', sceneDescription: 'A busy kitchen', composition: 'Centered', messagingContext: 'Speed' }],
};
const socialDraft = {
  channel: 'social_posts', briefId: 'b1',
  posts: [
    { platform: 'LinkedIn', content: 'We ship faster.', hashtags: ['speed', '#retail'] },
    { platform: 'LinkedIn', content: 'Second post.', hashtags: [] },
  ],
};

describe('publish-to-documents — mappers + fail-closed', () => {
  it('fails closed when ctx.features.documents is absent', async () => {
    const out = await publishAd({ features: {}, inputs: { draft: adDraft } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('host_capability_missing');
  });

  it('rejects an empty draft (no items)', async () => {
    const docs = { createDraftDocument: async () => ({ document: {} }) };
    const out = await publishAd({ features: { documents: docs, 'campaign-brief': briefSurface() }, inputs: { draft: { platformSets: [], briefId: 'b1' } } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('empty_draft');
  });

  it('maps ad_variants → markdown table per platform, resolves orgId, deterministic idemBase', async () => {
    let captured: any;
    const docs = { createDraftDocument: async (a: any) => { captured = a; return { document: { documentId: 'doc:x', kind: a.kind }, version: { version: 1 } }; } };
    const out = await publishAd({ features: { documents: docs, 'campaign-brief': briefSurface('org-5') }, inputs: { draft: adDraft }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(captured.orgId).toBe('org-5');
    expect(captured.kind).toBe('campaign-ad-copy');
    expect(captured.idemBase).toBe('r1:n1');
    expect(captured.content).toContain('## Google');
    expect(captured.content).toContain('| Pick faster | 40% faster checkout | Demo |');
    expect(captured.content).toContain('## Meta');
  });

  it('maps creative_briefs and social_posts to their markdown shapes', async () => {
    const cap: Record<string, any> = {};
    const docs = { createDraftDocument: async (a: any) => { cap[a.kind] = a; return { document: { documentId: 'd', kind: a.kind }, version: { version: 1 } }; } };
    await publishCreative({ features: { documents: docs, 'campaign-brief': briefSurface() }, inputs: { draft: creativeDraft }, runId: 'r2', nodeId: 'n2' });
    await publishSocial({ features: { documents: docs, 'campaign-brief': briefSurface() }, inputs: { draft: socialDraft }, runId: 'r3', nodeId: 'n3' });
    expect(cap['campaign-creative-briefs'].content).toContain('## Hero banner');
    expect(cap['campaign-creative-briefs'].content).toContain('**Scene:** A busy kitchen');
    expect(cap['campaign-social-calendar'].content).toContain('## LinkedIn');
    expect(cap['campaign-social-calendar'].content).toContain('#speed #retail'); // bare + #-prefixed normalized
  });
});

describe('real documents surface delegation — DRAFT doc, idempotent, tenant-isolated', () => {
  beforeEach(async () => { await __resetDocumentsStore(); });

  it('creates a real DRAFT document + version from an ad draft, and a replay reuses both (no dup)', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-A' });
    const ctx = { features: { documents, 'campaign-brief': briefSurface('o1') }, inputs: { draft: adDraft }, runId: 'run-A', nodeId: 'n1' };
    const first = await publishAd(ctx);
    expect(first.status).toBe('success');
    const docId = (first.outputs as any).document.documentId;
    const stored = await getDocument('t1', 'o1', docId);
    expect(stored?.status).toBe('draft'); // documents are created as drafts
    expect(stored?.kind).toBe('campaign-ad-copy');
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(await listVersions('t1', 'o1', docId)).toHaveLength(1);

    // Replay: same deterministic id → same doc, one container, one version.
    const second = await publishAd(ctx);
    expect((second.outputs as any).document.documentId).toBe(docId);
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(await listVersions('t1', 'o1', docId)).toHaveLength(1);
  });

  it('keys the write on the scope tenant — another tenant sees nothing', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-B' });
    await publishSocial({ features: { documents, 'campaign-brief': briefSurface('o1') }, inputs: { draft: socialDraft }, runId: 'run-B', nodeId: 'n1' });
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(await listDocuments('t2', 'o1')).toHaveLength(0);
  });

  it('the surface refuses empty content (no orphan container)', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-C' });
    const res = await documents.createDraftDocument({ orgId: 'o1', kind: 'campaign-ad-copy', title: 'X', content: '   ', idemBase: 'run-C:n1' });
    expect((res as any).error?.code).toBe('empty_content');
    expect(await listDocuments('t1', 'o1')).toHaveLength(0); // nothing created
  });

  it('the surface refuses oversize content BEFORE creating a container (no orphan)', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-D' });
    const res = await documents.createDraftDocument({ orgId: 'o1', kind: 'campaign-ad-copy', title: 'X', content: 'x'.repeat(1_000_001), idemBase: 'run-D:n1' });
    expect((res as any).error?.code).toBe('content_too_large');
    expect(await listDocuments('t1', 'o1')).toHaveLength(0); // container never created
  });
});

describe('publish-ad-variants — real dispatch branch (ADR 0167) vs document fallback', () => {
  const adWithMeta = {
    channel: 'ad_variants', briefId: 'b1',
    platformSets: [{ platform: 'Meta', variants: [{ headline: 'Pick faster', description: '40% faster', cta: 'LEARN_MORE' }] }],
  };

  it('dispatches via ctx.ads when an adAccountId is targeted + a connection exists', async () => {
    let captured: any;
    const ads = { publishAd: async (a: any) => { captured = a; return { outcome: 'published', platform: 'meta', platformCampaignId: 'c1', platformAdSetId: 's1', platformAdId: 'a1', reviewStatus: 'pending_review', paused: true, reused: false }; } };
    const out = await publishAd({ features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', campaignName: 'Summer' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect((out.outputs as any).dispatched.platformCampaignId).toBe('c1');
    expect(captured.platform).toBe('meta');
    expect(captured.briefId).toBe('b1');
    expect(captured.adAccountId).toBe('12345');
    expect(captured.copy).toMatchObject({ headline: 'Pick faster', ctaText: 'LEARN_MORE' });
  });

  it('routes platform by an explicit allow-set: google→google, tiktok→tiktok, anything-else→meta (never silently wrong)', async () => {
    const seen: string[] = [];
    const ads = { publishAd: async (a: any) => { seen.push(a.platform); return { outcome: 'published', platform: a.platform, platformCampaignId: 'c', platformAdSetId: 's', platformAdId: 'a', reviewStatus: 'pending_review', paused: true, reused: false }; } };
    const run = (platform: any) => publishAd({ features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', platform }, runId: 'r1', nodeId: 'n1' });
    await run('google'); await run('tiktok'); await run('TikTok'); await run('bogus'); await run(undefined);
    expect(seen).toEqual(['google', 'tiktok', 'tiktok', 'meta', 'meta']); // a bad/missing value falls back to meta, never to the wrong platform
  });

  it('falls back to the document handoff when ctx.ads reports no_connection (honest degradation)', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'no_connection' }) };
    const documents = { createDraftDocument: async () => { docCalled = true; return { document: { documentId: 'd', kind: 'campaign-ad-copy' }, version: { version: 1 } }; } };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(docCalled).toBe(true); // fell back to the ADR 0166 document
    expect((out.outputs as any).document).toBeTruthy();
  });

  it('treats no_developer_token (operator config not ready) as honest degradation → document handoff', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'failed', error: 'no_developer_token' }) };
    const documents = { createDraftDocument: async () => { docCalled = true; return { document: { documentId: 'd' }, version: { version: 1 } }; } };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', platform: 'google' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success'); // config-not-ready degrades, does not fail the user
    expect(docCalled).toBe(true);
  });

  it('surfaces a real dispatch failure (does NOT silently fall back)', async () => {
    const ads = { publishAd: async () => ({ outcome: 'failed', error: 'platform rejected' }) };
    const out = await publishAd({ features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('ad_dispatch_failed');
  });

  it('no adAccountId → document handoff (default, dispatch never attempted)', async () => {
    let adsCalled = false;
    const ads = { publishAd: async () => { adsCalled = true; return { outcome: 'no_connection' }; } };
    const documents = { createDraftDocument: async () => ({ document: { documentId: 'd' }, version: { version: 1 } }) };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(adsCalled).toBe(false); // no account targeted → never dispatched
    expect((out.outputs as any).document).toBeTruthy();
  });
});
