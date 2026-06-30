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
import { createBrief, __clearBriefs } from '../src/features/campaign-brief/briefService.js';
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
  it('exports validate + generate-kernel', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.campaign-brief.nodes.generate-kernel',
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
      kb: { rag: async () => ({ augmentedPrompt: 'GROUNDED', citations: [{ docId: 'doc-7' }] }) },
    };
    const callAI = async (req: { messages: Array<{ content: string }> }) => {
      calls.prompt = req.messages[0].content;
      return { data: { headline: 'Pick faster', supportingStatement: 'Save hours', proofPoints: ['40%'], primaryCta: 'Demo', tone: 'confident' } };
    };
    const out = await nodePack['feature.campaign-brief.nodes.generate-kernel']({ features, callAI, inputs: { briefId: 'b1' } });
    expect(out.status).toBe('success');
    const kernel = out.outputs?.kernel as Record<string, unknown>;
    expect(kernel.headline).toBe('Pick faster');
    expect(kernel.sourceDocIds).toEqual(['doc-7']); // KB citation tracing
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

describe('feature.campaign-brief.agents — agent pack', () => {
  it('loads the Brief Strategist with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.campaign-brief.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('feature.campaign-brief.agents.brief-strategist');
    expect(loaded[0].toolAllowlist).toContain('openwop:feature.campaign-brief.nodes.generate-kernel');
  });
});
