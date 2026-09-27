/**
 * Campaign Brief — context assembler + surface + kernel node (ADR 0156 Phase 3).
 * Pure assembler unit tests + surface tenant-isolation + the kernel node over a
 * stubbed 3-surface ctx (campaign-brief + brand + kb) and a stub ctx.callAI.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
    const brief = {
      name: 'Q4', objective: 'Leads', productName: 'FlashPick', productDescription: 'Grocery automation', industryVertical: 'Grocery',
      messaging: { primaryValueProp: 'Pick faster', toneOverride: '', proofPoints: ['40% faster'], ctaStrategy: 'Demo' },
    } as unknown as CampaignBrief;
    const personas = [{ name: 'Ops Director', role: 'Ops', buyerStage: 'product_aware', painPoints: ['labor'], objections: ['cost'], goals: ['save'], demographics: 'Mid-market' }] as unknown as Persona[];
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
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.campaign-brief.nodes.build-targeting',
      'feature.campaign-brief.nodes.extract-seeds',
      'feature.campaign-brief.nodes.extract-voc',
      'feature.campaign-brief.nodes.generate-angles',
      'feature.campaign-brief.nodes.generate-kernel',
      'feature.campaign-brief.nodes.get-brief',
      'feature.campaign-brief.nodes.get-targeting-pack',
      'feature.campaign-brief.nodes.list-angles',
      'feature.campaign-brief.nodes.list-briefs',
      'feature.campaign-brief.nodes.list-hooks',
      'feature.campaign-brief.nodes.list-personas',
      'feature.campaign-brief.nodes.list-targeting-packs',
      'feature.campaign-brief.nodes.validate',
    ]);
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

describe('feature.campaign-brief.agents — agent pack', () => {
  it('loads the Brief Strategist with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.campaign-brief.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('feature.campaign-brief.agents.brief-strategist');
    // CFP-1: the Strategist now carries the REAL registered agent tools
    // (`openwop:campaign-brief.<verb>`) — `generate-kernel` ignites the
    // messaging-kernel builtin workflow (assemble → callAI → setKernel → human gate).
    expect(loaded[0].toolAllowlist).toContain('openwop:campaign-brief.generate-kernel');
  });
});
