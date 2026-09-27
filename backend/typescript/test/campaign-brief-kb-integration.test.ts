/**
 * Campaign-brief generate-kernel ↔ REAL kb surface integration (KB "Path to A+").
 *
 * KB-CODE-1 hid behind a seam: every node test mocked `ctx.features.kb.rag`
 * and the mock encoded the WRONG citation field (`docId`), so `sourceDocIds`
 * was always `[]` in production while the suite stayed green. This file pins
 * the citation wire shape END-TO-END with NO kb mock:
 *
 *   real kbService (local-mode embeddings) → buildKbSurface → the pack's
 *   generate-kernel node → kernel.sourceDocIds carries the REAL documentIds
 *   → the kernel PERSISTS on the brief via the real campaign-brief surface.
 *
 * Only the LLM dispatch (`ctx.callAI`) is canned — everything else is the
 * production composition (buildCampaignBriefSurface + buildKbSurface).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createCollection, ingestDocument } from '../src/features/kb/kbService.js';
import { buildKbSurface } from '../src/features/kb/surface.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { createBrief, getBrief, setKernel, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { emitCandidateHooks, promoteHook } from '../src/features/campaign-brief/hookBankService.js';
import { nodes as briefNodes } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import { nodes as channelNodes } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

const TENANT = 'kbint-tenant';
const ORG = 'org-kbint';

// Canned LLM only — the kernel text is irrelevant; the citations are the test.
const OK_AI = async () => ({
  data: { headline: 'H', supportingStatement: 'S', proofPoints: ['P'], primaryCta: 'C', tone: 't' },
});

describe('generate-kernel over the REAL kb surface (citation shape, KB-CODE-1 seam)', () => {
  let collectionId = '';
  let docIdA = '';
  let docIdB = '';

  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbint-')) });
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();

    const col = await createCollection(TENANT, ORG, 'u1', { name: 'Product knowledge' });
    collectionId = col.collectionId;
    const a = await ingestDocument(TENANT, ORG, 'u1', collectionId, {
      title: 'FlashPick value proposition',
      text: 'FlashPick robotic picking speeds grocery fulfillment. The value proposition is faster order fulfillment at lower cost.',
    });
    const b = await ingestDocument(TENANT, ORG, 'u1', collectionId, {
      title: 'FlashPick proof points',
      text: 'FlashPick proof points: robotic picking in grocery warehouses reduces labor cost by 40 percent and doubles pick rates.',
    });
    docIdA = a.documentId;
    docIdB = b.documentId;
    expect(docIdA).toBeTruthy();
    expect(docIdB).toBeTruthy();
  });

  it('the real kb surface emits `documentId` citations (the shape the node consumes)', async () => {
    const kb = buildKbSurface({ tenantId: TENANT });
    const r = (await kb.rag({ orgId: ORG, collectionId, query: 'FlashPick robotic picking grocery value proposition proof points', topK: 6 })) as {
      citations: Array<Record<string, unknown>>;
      coverage: string;
    };
    expect(r.coverage).toBe('ok');
    expect(r.citations.length).toBeGreaterThanOrEqual(2);
    for (const c of r.citations) {
      // The wire field is `documentId` — the mocked `docId` shape that hid
      // KB-CODE-1 does not exist on the real surface.
      expect(typeof c.documentId).toBe('string');
      expect(c.documentId).toBeTruthy();
      expect(c).not.toHaveProperty('docId');
    }
    const ids = r.citations.map((c) => c.documentId);
    expect(ids).toEqual(expect.arrayContaining([docIdA, docIdB]));
  });

  it('generate-kernel grounds through the REAL surfaces and records the REAL documentIds', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'FlashPick launch',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      kbCollectionId: collectionId,
      messaging: { primaryValueProp: 'Robots do the walking' },
    });

    const features = {
      'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }),
      kb: buildKbSurface({ tenantId: TENANT }),
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({
      features,
      callAI: OK_AI,
      inputs: { briefId: brief.id },
    });

    expect(out.status, JSON.stringify(out)).toBe('success');
    const kernel = out.outputs?.kernel as Record<string, unknown>;
    // THE pin: grounded generation traces the real ingested documents — the
    // exact end-to-end assertion the old mocked-seam tests could not make.
    expect(kernel.sourceDocIds).toEqual(expect.arrayContaining([docIdA, docIdB]));
    expect((kernel.sourceDocIds as string[]).length).toBeGreaterThanOrEqual(2);
    expect(out.outputs?.grounding).toMatchObject({ coverage: 'ok' });

    // And it persisted through the real setKernel — staleness propagation
    // (markKernelsStaleForDoc walks kernel.sourceDocIds) has a live substrate.
    const persisted = await getBrief(TENANT, brief.id);
    expect(persisted?.kernel?.sourceDocIds).toEqual(expect.arrayContaining([docIdA, docIdB]));
  });

  it('a brief bound to an EMPTY collection yields no sourceDocIds (no phantom citations)', async () => {
    const empty = await createCollection(TENANT, ORG, 'u1', { name: 'Empty' });
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'Ungrounded launch',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      kbCollectionId: empty.collectionId,
      messaging: { primaryValueProp: 'v' },
    });
    const features = {
      'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }),
      kb: buildKbSurface({ tenantId: TENANT }),
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({
      features,
      callAI: OK_AI,
      inputs: { briefId: brief.id },
    });
    // best-effort (default) proceeds ungrounded, honestly labeled.
    expect(out.status).toBe('success');
    expect((out.outputs?.kernel as Record<string, unknown>).sourceDocIds).toEqual([]);
    expect(out.outputs?.grounding).toMatchObject({ coverage: 'none' });
  });

  // KB-CODE-13: the surface projection used to OMIT groundingPolicy, so a
  // strict brief silently ran best-effort through the real surface. These two
  // pins go through the production composition — no mocked assembleContext.
  it('KB-CODE-13: a STRICT brief with no KB binding fails CLOSED through the real surface', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'Strict unbound',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      groundingPolicy: 'strict',
      messaging: { primaryValueProp: 'v' },
    });
    const features = {
      'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }),
      kb: buildKbSurface({ tenantId: TENANT }),
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({
      features,
      callAI: OK_AI,
      inputs: { briefId: brief.id },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('grounding_insufficient');
  });

  it('KB-CODE-13: a STRICT brief on an empty collection fails CLOSED (coverage none)', async () => {
    const empty = await createCollection(TENANT, ORG, 'u1', { name: 'Empty strict' });
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'Strict empty',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      kbCollectionId: empty.collectionId,
      groundingPolicy: 'strict',
      messaging: { primaryValueProp: 'v' },
    });
    const features = {
      'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }),
      kb: buildKbSurface({ tenantId: TENANT }),
    };
    const out = await briefNodes['feature.campaign-brief.nodes.generate-kernel']({
      features,
      callAI: OK_AI,
      inputs: { briefId: brief.id },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('grounding_insufficient');
  });

  // FU-CODE-1 — the seam CLASS behind KB-CODE-13: a pack reads `brief.<field>`
  // off the assembleContext projection; an omitted field is Array.isArray/
  // truthiness-guarded in the packs, so it silently no-ops instead of failing.
  // This contract test greps the pack sources for every `brief.<field>` read and
  // asserts each is a key of the REAL projection — the NEXT omitted field fails
  // here instead of shipping.
  it('FU-CODE-1 projection contract: every `brief.<field>` a pack reads is a key of the real projection', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'Projection contract',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      kbCollectionId: collectionId,
      competitors: ['AcmePick'],
      messaging: { primaryValueProp: 'v' },
    });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const asm = (await surface.assembleContext!({ briefId: brief.id })) as { found: boolean; brief: Record<string, unknown> };
    expect(asm.found).toBe(true);
    const projectionKeys = new Set(Object.keys(asm.brief));

    const reads = new Set<string>();
    for (const dir of ['feature.campaign-brief.nodes', 'feature.campaign-channels.nodes']) {
      const src = readFileSync(new URL(`../../../packs/${dir}/index.mjs`, import.meta.url), 'utf8');
      // Reads off the packs' LOCAL `brief` binding (`const brief = asm.brief ?? {}`).
      // The lookbehind excludes member chains like `res.brief.utm` / `asm.brief.orgId`
      // (OTHER surfaces: getBrief's full row, creative-briefs results) and pack-id
      // strings like `feature.campaign-brief.nodes.validate`.
      for (const m of src.matchAll(/(?<![.\w-])brief\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]!);
    }
    // Guard against regex rot: the known reads must actually be seen.
    expect([...reads]).toEqual(expect.arrayContaining(['competitors', 'personaIds', 'groundingPolicy', 'kbCollectionId', 'productName']));
    for (const field of reads) {
      expect(projectionKeys.has(field), `a pack reads brief.${field} but the assembleContext projection omits it`).toBe(true);
    }
  });

  // ADR 0403 P2 — `hooks` rides assembleContext as a TOP-LEVEL sibling of
  // `kernel` (the FU-CODE-1 regex only pins `brief.<field>` reads, so this
  // top-level key gets its own explicit pin): TESTED-only, capped, minimal
  // projection. A channels-pack consumption test lands with the Phase 4 chain.
  it('ADR 0403 projection pin: assembleContext exposes a top-level `hooks` array (tested-only)', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', { name: 'Hooks pin', productName: 'FlashPick' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const asm = (await surface.assembleContext!({ briefId: brief.id })) as Record<string, unknown>;
    expect(Array.isArray(asm.hooks), 'assembleContext must project `hooks` (ADR 0403 P2)').toBe(true);
  });

  it('FU-CODE-1: stored competitors reach the channel-generation prompt through the REAL surface', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', {
      name: 'Competitor launch',
      productName: 'FlashPick',
      industryVertical: 'grocery robotics',
      competitors: ['AcmePick', 'RoboGrab'],
      messaging: { primaryValueProp: 'v' },
    });
    await setKernel(TENANT, brief.id, {
      headline: 'H', supportingStatement: 'S', proofPoints: ['P'], primaryCta: 'C', secondaryCta: 'C2',
      tone: 't', channelTones: {}, sourceDocIds: [], generatedAt: new Date().toISOString(),
    });
    let prompt = '';
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }) },
      callAI: async (req: { messages: Array<{ content: string }> }) => {
        prompt = req.messages[0]!.content;
        return { data: { platformSets: [{ platform: 'google', variants: [{ headline: 'ok', description: 'ok' }] }] } };
      },
      inputs: { briefId: brief.id, channel: 'ad_variants' },
    });
    expect(out.status, JSON.stringify(out)).toBe('success');
    // The ADR 0355 P5 differentiation block is built from the PROJECTION's
    // competitors — this pins the production composition, not a mock.
    expect(prompt).toContain('COMPETITORS: differentiate against AcmePick, RoboGrab');
  });

  it('ADR 0403 P4: a TESTED hook reaches the channel-generation prompt through the REAL surface — a candidate does not', async () => {
    const brief = await createBrief(TENANT, ORG, 'u1', { name: 'Hook echo', productName: 'FlashPick', messaging: { primaryValueProp: 'v' } });
    await setKernel(TENANT, brief.id, {
      headline: 'H', supportingStatement: 'S', proofPoints: ['P'], primaryCta: 'C', secondaryCta: 'C2',
      tone: 't', channelTones: {}, sourceDocIds: [], generatedAt: new Date().toISOString(),
    });
    const { emitted } = await emitCandidateHooks(TENANT, ORG, 'angle-x', [
      { text: 'Stop recounting bins every morning', format: 'bold-claim' },
      { text: 'Unvetted candidate line', format: 'question' },
    ], 'u1');
    const testedId = emitted.find((h) => h.text.startsWith('Stop recounting'))!.id;
    await promoteHook(TENANT, ORG, testedId, 'tested');
    let prompt = '';
    const out = await channelNodes['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': buildCampaignBriefSurface({ tenantId: TENANT }) },
      callAI: async (req: { messages: Array<{ content: string }> }) => {
        prompt = req.messages[0]!.content;
        return { data: { platformSets: [{ platform: 'google', variants: [{ headline: 'ok', description: 'ok' }] }] } };
      },
      inputs: { briefId: brief.id, channel: 'ad_variants' },
    });
    expect(out.status, JSON.stringify(out)).toBe('success');
    expect(prompt).toContain('TESTED HOOKS');
    expect(prompt).toContain('Stop recounting bins every morning');
    // The tested-only projection keeps unvetted candidates OUT of generation.
    expect(prompt).not.toContain('Unvetted candidate line');
  });
});
