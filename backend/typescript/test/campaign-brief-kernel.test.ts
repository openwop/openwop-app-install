/**
 * Campaign Brief — context assembler + surface + kernel node (ADR 0156 Phase 3).
 * Pure assembler unit tests + surface tenant-isolation + the kernel node over a
 * stubbed 3-surface ctx (campaign-brief + brand + kb) and a stub ctx.callAI.
 * BRIEF-1 (order-insensitive protected-field diff) and R2 CB-SP-9 (model output
 * alone never advances status) are sabotage-witnessed regression pins here.
 *
 * Wave 30 (grade-tests): fixtures are full typed rows (no casts); the node set is
 * pinned to the pack MANIFEST (module ↔ pack.json parity), not a hand list. Two
 * product defects are pinned as `it.fails` (CB-SEEDS-1, CB-KERNEL-1) — each flips
 * red when the product is fixed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createPersona, __clearPersonas } from '../src/features/campaign-brief/personaService.js';
import { createBrief, updateBrief, setKernel, getBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
import { assembleBriefContextText } from '../src/features/campaign-brief/briefContext.js';
import { buildCampaignBriefSurface } from '../src/features/campaign-brief/surface.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import type { CampaignBrief, Persona } from '../src/features/campaign-brief/types.js';

const TENANT = 'tenant-kernel';
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }

describe('briefContext.assembleBriefContextText (pure)', () => {
  it('composes product, audience (buyer-stage guidance), and messaging', () => {
    const brief: CampaignBrief = {
      id: 'b1', tenantId: TENANT, orgId: 'o1', name: 'Q4', objective: 'Leads', personaIds: ['p1'],
      productName: 'FlashPick', productDescription: 'Grocery automation', industryVertical: 'Grocery',
      channels: [], status: 'draft', kernelStale: false, createdBy: 'u1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
      messaging: { primaryValueProp: 'Pick faster', toneOverride: '', proofPoints: ['40% faster'], ctaStrategy: 'Demo' },
    };
    const personas: Persona[] = [{
      id: 'p1', tenantId: TENANT, orgId: 'o1', name: 'Ops Director', role: 'Ops', buyerStage: 'product_aware', painPoints: ['labor'],
      objections: ['cost'], goals: ['save'], demographics: 'Mid-market', createdBy: 'u1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    }];
    const text = assembleBriefContextText(brief, personas);
    expect(text).toContain('# Campaign: Q4');
    expect(text).toContain('FlashPick');
    expect(text).toContain('Ops Director');
    expect(text).toContain('handle objections'); // product_aware guidance
    expect(text).toContain('40% faster');
  });
});

describe('campaign-brief surface', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearPersonas();
    await __clearBriefs();
  });

  it('assembleContext returns context + enabled channels; isolates tenants', async () => {
    const persona = await createPersona(TENANT, 'o1', 'u1', { name: 'Ops', buyerStage: 'problem_aware' });
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick', personaIds: [persona.id],
      messaging: { primaryValueProp: 'Faster' },
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    const out = as<{ found: boolean; contextText: string; enabledChannels: string[]; valid: boolean }>(await surface.assembleContext({ briefId: brief.id }));
    expect(out.found).toBe(true);
    expect(out.contextText).toContain('Ops');
    expect(out.enabledChannels).toEqual(['landing_page']);

    const foreign = buildCampaignBriefSurface({ tenantId: 'other' });
    expect(as<{ found: boolean }>(await foreign.assembleContext({ briefId: brief.id })).found).toBe(false);
  });
});

describe('feature.campaign-brief.nodes — node pack', () => {
  it('exports the full ADR 0156/0356/0403 node set', () => {
    // Module ↔ manifest parity: every declared node has a handler and vice versa.
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'packs', 'feature.campaign-brief.nodes', 'pack.json'), 'utf8')) as { nodes: Array<{ typeId: string }> };
    const declared = manifest.nodes.map((n) => n.typeId).sort();
    expect(declared).toHaveLength(13);
    expect(Object.keys(nodePack).sort()).toEqual(declared);
  });

  it('fails closed with host_capability_missing when the surface is absent', async () => {
    await expect(nodePack['feature.campaign-brief.nodes.validate']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('generate-kernel composes brand + kb + callAI and persists', async () => {
    const calls: Record<string, unknown> = {};
    const features = {
      'campaign-brief': {
        assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId: 'o1', brandId: 'brand-1', kbCollectionId: 'kb-1', productName: 'FlashPick', industryVertical: 'Grocery' }, contextText: 'CONTEXT', valid: true, enabledChannels: ['landing_page'] }),
        setKernel: async (a: unknown) => { calls.setKernel = a; return { brief: { id: 'b1' } }; },
      },
      brand: { resolveVoice: async () => ({ voice: 'VOICE' }) },
      // Real kb.rag citations carry `documentId` (KB-CODE-1); the legacy `docId`
      // shape is still read as a fallback — pin both.
      kb: { rag: async () => ({ augmentedPrompt: 'GROUNDED', citations: [{ documentId: 'doc-7', title: 'D7' }, { docId: 'doc-legacy' }] }) },
    };
    const callAI = async (req: { messages: Array<{ content: string }> }) => {
      calls.prompt = req.messages[0].content;
      return { data: { headline: 'Pick faster', supportingStatement: 'Save hours', proofPoints: ['40%'], primaryCta: 'Demo', tone: 'confident' } };
    };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, callAI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    const kernel = out.outputs?.kernel as Record<string, unknown>;
    expect(kernel.headline).toBe('Pick faster');
    expect(kernel.sourceDocIds).toEqual(['doc-7', 'doc-legacy']); // KB citation tracing (real shape + legacy fallback)
    expect(String(calls.prompt)).toContain('VOICE'); // brand voice composed
    expect(String(calls.prompt)).toContain('GROUNDED'); // KB grounding composed
    expect((calls.setKernel as { briefId: string }).briefId).toBe('b1'); // persisted
  });

  it('generate-kernel fails closed when the brief is missing', async () => {
    const features = { 'campaign-brief': { assembleContext: async () => ({ found: false }), setKernel: async () => ({}) } };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, callAI: async () => ({}), inputs: { briefId: 'nope' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('brief_not_found');
  });
});

// CB-SEEDS-1 (BLOCKED-ON-PRODUCT, wave 30) — extract-seeds returns
// `status:'success'` with `proposals: {}` when the model returns NOTHING: invalid
// model output reported as success-with-empty (CLAUDE.md non-negotiable). Correct:
// a typed failure (ideally after ONE error-fed repair, the extract-voc pattern).
// Fix direction: in packs/feature.campaign-brief.nodes/index.mjs extractBriefSeeds,
// return `{ status:'failed', error:{ code:'generation_empty' } }` when `data` is not
// an object; then drop `.fails`.
describe('CB-SEEDS-1 — extract-seeds never reports an empty model reply as success', () => {
  it.fails('an empty model reply is a typed failure', async () => {
    const callAI = async () => ({ data: undefined });
    const kb = { rag: async () => ({ augmentedPrompt: '[0] FlashPick buyers are ops directors.', citations: [{ documentId: 'd1' }], coverage: 'ok' }) };
    const out = await nodePack['feature.campaign-brief.nodes.extract-seeds']({ features: { kb }, callAI, inputs: { orgId: 'o1', collectionId: 'c1' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBeTruthy();
  });
});

// CB-KERNEL-1 (BLOCKED-ON-PRODUCT, wave 30) — surface.setKernel persists
// `args.kernel as MessagingKernel` with NO validation, so any surface caller can
// write a malformed kernel onto the brief (and it advances status when the brief
// validates). Model output must reach durable state only through closed-world
// validation. Correct: a typed 422 and the stored brief untouched. Fix direction:
// validate the kernel shape (string headline/supportingStatement/primaryCta/tone,
// string[] proofPoints, bounded lengths) in surface.setKernel / briefService.setKernel;
// then drop `.fails`.
describe('CB-KERNEL-1 — the kernel write is closed-world', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });

  it.fails('a malformed kernel is refused and never persisted', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', { name: 'Camp', productName: 'FlashPick' });
    const surface = buildCampaignBriefSurface({ tenantId: TENANT });
    await expect(surface.setKernel!({ briefId: brief.id, kernel: { headline: 42, proofPoints: 'not-an-array' } }))
      .rejects.toMatchObject({ code: 'validation_error' });
    expect((await getBrief(TENANT, brief.id))!.kernel).toBeUndefined();
  });
});

describe('protected-field re-approval (BRIEF-1) — order-insensitive diff', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBriefs();
  });

  const KERNEL = {
    headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
    tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
  };

  it('does NOT demote a confirmed brief when a re-send only reorders open channel.config keys', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: { a: '1', b: '2', c: '3' } }],
    });
    await setKernel(TENANT, brief.id, KERNEL);
    await updateBrief(TENANT, brief.id, { status: 'confirmed' }, 'u1');

    // Re-send the SAME content with config keys in a different order.
    const updated = await updateBrief(TENANT, brief.id, {
      channels: [{ type: 'landing_page', enabled: true, config: { c: '3', a: '1', b: '2' } }],
    }, 'u1');

    expect(updated!.status).toBe('confirmed'); // NOT demoted to draft
    expect(updated!.kernelStale).not.toBe(true); // kernel still valid
    const reread = await getBrief(TENANT, brief.id);
    expect(reread!.status).toBe('confirmed');
  });

  it('R2 CB-SP-9: setKernel does NOT promote an INVALID brief to validated — model output alone cannot advance status', async () => {
    // No personas, no value prop — validateBrief fails. The old setKernel
    // force-promoted status:'validated' anyway, purely on model output, while
    // the tool/pack/prompt adverts all said generation never auto-approves.
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const after = await setKernel(TENANT, brief.id, KERNEL);
    expect(after!.status).toBe('draft'); // NOT promoted
    expect(after!.kernel).toBeTruthy(); // the kernel still saves — it is reviewable content

    // Polarity: a brief that actually VALIDATES still promotes.
    const valid = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp2', productName: 'FlashPick',
      personaIds: ['p1'],
      messaging: { primaryValueProp: 'Fast', proofPoints: [], ctaStrategy: '' },
      channels: [{ type: 'landing_page', enabled: true, config: {} }],
    });
    const promoted = await setKernel(TENANT, valid.id, KERNEL);
    expect(promoted!.status).toBe('validated');
  });

  it('STILL demotes when a protected field genuinely changes', async () => {
    const brief = await createBrief(TENANT, 'o1', 'u1', {
      name: 'Camp', productName: 'FlashPick',
      channels: [{ type: 'landing_page', enabled: true, config: { a: '1' } }],
    });
    await setKernel(TENANT, brief.id, KERNEL);
    await updateBrief(TENANT, brief.id, { status: 'confirmed' }, 'u1');

    const updated = await updateBrief(TENANT, brief.id, { name: 'Renamed' }, 'u1');
    expect(updated!.status).toBe('draft'); // demoted — re-approval required
    expect(updated!.kernelStale).toBe(true);
  });
});

describe('vendor.openwop-app.campaign-brief.agents — agent pack', () => {
  it('loads the Brief Strategist with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.campaign-brief.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('vendor.openwop-app.campaign-brief.agents.brief-strategist');
    // CFP-1: the Strategist now carries the REAL registered agent tools
    // (`openwop:campaign-brief.<verb>`) — `generate-kernel` ignites the
    // messaging-kernel builtin workflow (assemble → callAI → setKernel → human gate).
    expect([...(loaded[0].toolAllowlist ?? [])].sort()).toEqual([
      'openwop:campaign-brief.generate-kernel',
      'openwop:campaign-brief.get-brief',
      'openwop:campaign-brief.research.run',
      'openwop:campaign-brief.validate',
    ]);
  });
});
