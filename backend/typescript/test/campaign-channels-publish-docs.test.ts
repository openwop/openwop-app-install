/**
 * Campaign Studio publish-to-documents handoff (ADR 0166) — the three publish nodes
 * (publish-ad-variants / publish-creative-briefs / publish-social-posts) over the
 * documents feature surface. Covers: the draft→Markdown mappers; fail-closed when the
 * surface is absent; empty-draft rejection; the real createDraftDocument delegation
 * creating a DRAFT document + version; replay idempotency (a re-run reuses the same
 * doc+version, no duplicate container); tenant isolation; and the empty-content guard.
 * The ADR 0167 dispatch branch: a pending spend approval, a real platform rejection and
 * a bad platform all FAIL — only an honest config-not-ready degrades to the handoff.
 *
 * Sabotage that turns it red: drop the documents capability check or the empty-items
 * guard; change a markdown mapper; drop the surface's empty/oversize guards or its
 * deterministic `doc:${idemBase}` id; key the surface on a fixed tenant; dispatch without
 * an adAccountId; drop an ADR 0223 input; let `requires_approval`, a platform failure or
 * a typo'd platform fall through to the document handoff; fail on no_connection /
 * no_developer_token.
 *
 * CCH-FORK-1 (BLOCKED-ON-PRODUCT, `it.fails` below): `publishToDocument` keys its
 * document on `${runId}:${nodeId}`, so a `:fork` mints a SECOND draft document — the
 * EMWF-10 shape ADR 0655 D7 fixed for the email node only.
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

type Captured = Record<string, unknown>;
/** A named object field from node outputs (shape-checked, no cast). */
const outObj = (out: { outputs?: Record<string, unknown> }, key: string): Record<string, unknown> => {
  const v = out.outputs?.[key];
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new Error(`no ${key} in outputs: ${JSON.stringify(out.outputs)}`);
};
const published = { outcome: 'published', platform: 'meta', platformCampaignId: 'c1', platformAdSetId: 's1', platformAdId: 'a1', reviewStatus: 'pending_review', paused: true, reused: false };

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
    const calls: Captured[] = [];
    const docs = { createDraftDocument: async (a: Captured) => { calls.push(a); return { document: { documentId: 'doc:x', kind: a.kind }, version: { version: 1 } }; } };
    const ctx = { features: { documents: docs, 'campaign-brief': briefSurface('org-5') }, inputs: { draft: adDraft }, runId: 'r1', nodeId: 'n1' };
    const out = await publishAd(ctx);
    expect(out.status).toBe('success');
    const captured = calls[0];
    expect(captured?.orgId).toBe('org-5');
    expect(captured?.kind).toBe('campaign-ad-copy');
    // Deterministic idemBase: a re-run of the same node computes the SAME base, anchored
    // on the node. (Its runId component is CCH-FORK-1 — not pinned here.)
    await publishAd(ctx);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.idemBase).toBe(captured?.idemBase);
    expect(String(captured?.idemBase)).toMatch(/(^|:)n1(:|$)/);
    const content = String(captured?.content);
    expect(content).toContain('## Google');
    expect(content).toContain('| Pick faster | 40% faster checkout | Demo |');
    expect(content).toContain('## Meta');
  });

  it('maps creative_briefs and social_posts to their markdown shapes', async () => {
    const cap: Record<string, Captured> = {};
    const docs = { createDraftDocument: async (a: Captured) => { cap[String(a.kind)] = a; return { document: { documentId: 'd', kind: a.kind }, version: { version: 1 } }; } };
    await publishCreative({ features: { documents: docs, 'campaign-brief': briefSurface() }, inputs: { draft: creativeDraft }, runId: 'r2', nodeId: 'n2' });
    await publishSocial({ features: { documents: docs, 'campaign-brief': briefSurface() }, inputs: { draft: socialDraft }, runId: 'r3', nodeId: 'n3' });
    expect(String(cap['campaign-creative-briefs']?.content)).toContain('## Hero banner');
    expect(String(cap['campaign-creative-briefs']?.content)).toContain('**Scene:** A busy kitchen');
    expect(String(cap['campaign-social-calendar']?.content)).toContain('## LinkedIn');
    expect(String(cap['campaign-social-calendar']?.content)).toContain('#speed #retail'); // bare + #-prefixed normalized
  });
});

describe('real documents surface delegation — DRAFT doc, idempotent, tenant-isolated', () => {
  beforeEach(async () => { await __resetDocumentsStore(); });

  it('creates a real DRAFT document + version from an ad draft, and a replay reuses both (no dup)', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-A' });
    const ctx = { features: { documents, 'campaign-brief': briefSurface('o1') }, inputs: { draft: adDraft }, runId: 'run-A', nodeId: 'n1' };
    const first = await publishAd(ctx);
    expect(first.status).toBe('success');
    const docId = String(outObj(first, 'document').documentId);
    const stored = await getDocument('t1', 'o1', docId);
    expect(stored?.status).toBe('draft'); // documents are created as drafts
    expect(stored?.kind).toBe('campaign-ad-copy');
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(await listVersions('t1', 'o1', docId)).toHaveLength(1);

    // Replay: same deterministic id → same doc, one container, one version.
    const second = await publishAd(ctx);
    expect(outObj(second, 'document').documentId).toBe(docId);
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(await listVersions('t1', 'o1', docId)).toHaveLength(1);
  });

  // CCH-FORK-1 — BLOCKED-ON-PRODUCT. Correct behaviour: a `:fork` re-runs the node under a
  // NEW runId with the same node + brief, and must reuse the draft document it already
  // made (the EMWF-10 fix shape). Today the idemBase carries the runId, so the fork mints
  // a second document. Flip to `it` when the node anchors its key on nodeId + brief.
  it.fails('CCH-FORK-1: a fork (new runId, same node + brief) reuses the same draft document', async () => {
    const run = async (runId: string): Promise<unknown> => {
      const documents = buildDocumentsSurface({ tenantId: 't1', runId });
      const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, inputs: { draft: adDraft, briefId: 'b1' }, runId, nodeId: 'n1' });
      expect(out.status, JSON.stringify(out)).toBe('success'); // setup guard: both runs publish
      return outObj(out, 'document').documentId;
    };
    const original = await run('run-FORK');
    const forked = await run('run-FORK-fork');
    expect(await listDocuments('t1', 'o1')).toHaveLength(1);
    expect(forked).toBe(original);
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
    expect(res).toMatchObject({ error: { code: 'empty_content' } });
    expect(await listDocuments('t1', 'o1')).toHaveLength(0); // nothing created
  });

  it('the surface refuses oversize content BEFORE creating a container (no orphan)', async () => {
    const documents = buildDocumentsSurface({ tenantId: 't1', runId: 'run-D' });
    const res = await documents.createDraftDocument({ orgId: 'o1', kind: 'campaign-ad-copy', title: 'X', content: 'x'.repeat(1_000_001), idemBase: 'run-D:n1' });
    expect(res).toMatchObject({ error: { code: 'content_too_large' } });
    expect(await listDocuments('t1', 'o1')).toHaveLength(0); // container never created
  });
});

describe('publish-ad-variants — real dispatch branch (ADR 0167) vs document fallback', () => {
  const adWithMeta = {
    channel: 'ad_variants', briefId: 'b1',
    platformSets: [{ platform: 'Meta', variants: [{ headline: 'Pick faster', description: '40% faster', cta: 'LEARN_MORE' }] }],
  };

  it('dispatches via ctx.ads when an adAccountId is targeted + a connection exists', async () => {
    let captured: Captured = {};
    const ads = { publishAd: async (a: Captured) => { captured = a; return published; } };
    const out = await publishAd({ features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', campaignName: 'Summer' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(outObj(out, 'dispatched').platformCampaignId).toBe('c1');
    expect(captured.platform).toBe('meta');
    expect(captured.briefId).toBe('b1');
    expect(captured.adAccountId).toBe('12345');
    expect(captured.copy).toMatchObject({ headline: 'Pick faster', ctaText: 'LEARN_MORE' });
  });

  it('threads the ADR 0223 creative-affecting inputs (pageId / identityId / mediaAssetId) through to ctx.ads', async () => {
    let captured: Captured = {};
    const ads = { publishAd: async (a: Captured) => { captured = a; return published; } };
    const out = await publishAd({
      features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads,
      inputs: { draft: adWithMeta, adAccountId: '12345', pageId: 'page-77', identityId: 'ident-9', mediaAssetId: 'masset:1' }, runId: 'r1', nodeId: 'n1',
    });
    expect(out.status).toBe('success');
    expect(captured.pageId).toBe('page-77');
    expect(captured.identityId).toBe('ident-9');
    expect(captured.mediaAssetId).toBe('masset:1');
  });

  it('routes platform by an explicit allow-set: known pass, EMPTY→meta, a non-empty typo FAILS (grade-code AUDIT-10)', async () => {
    const seen: string[] = [];
    const ads = { publishAd: async (a: Captured) => { seen.push(String(a.platform)); return { ...published, platform: a.platform }; } };
    const run = (platform: string | undefined) => publishAd({ features: { documents: { createDraftDocument: async () => ({}) }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', platform }, runId: 'r1', nodeId: 'n1' });
    await run('google'); await run('tiktok'); await run('TikTok'); await run('linkedin'); await run(undefined); await run('');
    expect(seen).toEqual(['google', 'tiktok', 'tiktok', 'linkedin', 'meta', 'meta']); // known + empty/missing → meta
    // A NON-EMPTY typo must FAIL (not silently dispatch to meta) — the fix.
    const bad = await run('bogus');
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('unknown_platform');
    expect(seen).toHaveLength(6); // the typo never reached the adapter
  });

  it('falls back to the document handoff when ctx.ads reports no_connection (honest degradation)', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'no_connection' }) };
    const documents = { createDraftDocument: async () => { docCalled = true; return { document: { documentId: 'd', kind: 'campaign-ad-copy' }, version: { version: 1 } }; } };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(docCalled).toBe(true); // fell back to the ADR 0166 document
    expect(outObj(out, 'document').documentId).toBe('d');
  });

  it('treats no_developer_token (operator config not ready) as honest degradation → document handoff', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'failed', error: 'no_developer_token' }) };
    const documents = { createDraftDocument: async () => { docCalled = true; return { document: { documentId: 'd' }, version: { version: 1 } }; } };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', platform: 'google' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success'); // config-not-ready degrades, does not fail the user
    expect(docCalled).toBe(true);
    expect(outObj(out, 'document').documentId).toBe('d');
  });

  it('surfaces a real dispatch failure (does NOT silently fall back)', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'failed', error: 'platform rejected' }) };
    const out = await publishAd({ features: { documents: { createDraftDocument: async () => { docCalled = true; return {}; } }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345' }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('failed');
    expect(out.error).toEqual({ code: 'ad_dispatch_failed', message: 'platform rejected' });
    expect(docCalled).toBe(false);
  });

  // The money gate (campaign gap plan B3): a dispatch pending SPEND approval must surface
  // the pending approval — never report success through the document handoff.
  it('a dispatch pending spend approval FAILS with spend_approval_pending (does NOT silently fall back)', async () => {
    let docCalled = false;
    const ads = { publishAd: async () => ({ outcome: 'requires_approval', approvalId: 'appr:spend-1' }) };
    const out = await publishAd({ features: { documents: { createDraftDocument: async () => { docCalled = true; return { document: { documentId: 'd' }, version: { version: 1 } }; } }, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta, adAccountId: '12345', dailyBudgetMinor: 5000 }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('spend_approval_pending');
    expect(out.error?.message).toContain('appr:spend-1'); // the operator can find the approval
    expect(docCalled).toBe(false);
  });

  it('no adAccountId → document handoff (default, dispatch never attempted)', async () => {
    let adsCalled = false;
    const ads = { publishAd: async () => { adsCalled = true; return { outcome: 'no_connection' }; } };
    const documents = { createDraftDocument: async () => ({ document: { documentId: 'd' }, version: { version: 1 } }) };
    const out = await publishAd({ features: { documents, 'campaign-brief': briefSurface('o1') }, ads, inputs: { draft: adWithMeta }, runId: 'r1', nodeId: 'n1' });
    expect(out.status).toBe('success');
    expect(adsCalled).toBe(false); // no account targeted → never dispatched
    expect(outObj(out, 'document').documentId).toBe('d');
  });
});
