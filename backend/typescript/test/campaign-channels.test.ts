/**
 * Campaign Channels (ADR 0157) — the generate + content-quality nodes over a
 * stubbed 3-surface ctx, the five channel child workflows (a generate → HITL
 * approval-gate DAG — nothing reaches publish without a human), the agent pack
 * loading (CFP-1), and the creative_briefs prompt↔schema parity (CRB-SP-6).
 * The agent's exact tool allowlist is pinned in `campaign-agent-tools.test.ts`
 * › "the generator allowlist is exactly [channels, generate]" (not duplicated here).
 *
 * Sabotage that turns it red: accept an unknown channel; generate without a kernel;
 * drop the brand-voice or KB-grounding prompt leg; pass every quality check; drop the
 * generate → approve edge or the per-item `itemsFrom`; remove `directions` from the
 * creative_briefs schema.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack, CHANNEL_SPEC } from '../../../packs/feature.campaign-channels.nodes/index.mjs';

/** Walk a JSON-schema-ish object by keys; throws on a missing / non-object hop (no casts). */
const at = (root: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((cur, k) => {
  if (typeof cur !== 'object' || cur === null || !(k in cur)) throw new Error(`missing schema path segment: ${k}`);
  return (cur as Record<string, unknown>)[k];
}, root);
import { CHANNEL_WORKFLOWS, CHANNEL_WORKFLOW_IDS } from '../src/features/campaign-channels/channelWorkflows.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const goodBriefSurface = {
  assembleContext: async () => ({
    found: true,
    brief: { id: 'b1', orgId: 'o1', brandId: 'brand-1', kbCollectionId: 'kb-1', productName: 'FlashPick', industryVertical: 'Grocery' },
    kernel: { headline: 'Pick faster', proofPoints: ['40%'], primaryCta: 'Demo', tone: 'confident' },
    contextText: 'CONTEXT', valid: true, enabledChannels: ['landing_page'],
  }),
};

describe('feature.campaign-channels.nodes — generate', () => {
  it('exports generate + content-quality-check + the five publish nodes + render-concepts', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.campaign-channels.nodes.content-quality-check',
      'feature.campaign-channels.nodes.generate',
      'feature.campaign-channels.nodes.publish-ad-variants',
      'feature.campaign-channels.nodes.publish-creative-briefs',
      'feature.campaign-channels.nodes.publish-email-sequence',
      'feature.campaign-channels.nodes.publish-landing-page',
      'feature.campaign-channels.nodes.publish-social-posts',
      'feature.campaign-channels.nodes.render-concepts',
    ]);
  });

  it('fails closed without the campaign-brief surface', async () => {
    await expect(nodePack['feature.campaign-channels.nodes.generate']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('rejects an unknown channel', async () => {
    const out = await nodePack['feature.campaign-channels.nodes.generate']({ features: { 'campaign-brief': goodBriefSurface }, inputs: { briefId: 'b1', channel: 'tiktok' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('invalid_channel');
  });

  it('requires the kernel before generating', async () => {
    const noKernel = { 'campaign-brief': { assembleContext: async () => ({ found: true, brief: { id: 'b1', orgId: 'o1' }, kernel: null, contextText: 'C' }) } };
    const out = await nodePack['feature.campaign-channels.nodes.generate']({ features: noKernel, callAI: async () => ({}), inputs: { briefId: 'b1', channel: 'landing_page' } });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('kernel_required');
  });

  it('generates a landing page, composes voice + grounding, bundles quality + compliance', async () => {
    const calls: Record<string, unknown> = {};
    const features = {
      'campaign-brief': goodBriefSurface,
      brand: {
        resolveVoice: async () => ({ voice: 'VOICE' }),
        checkComplianceDeterministic: async (a: Record<string, unknown>) => { calls.compliance = a; return { report: { deterministicScore: 90, hasBannedPhrase: false } }; },
      },
      kb: { rag: async () => ({ augmentedPrompt: 'GROUNDED', citations: [{ docId: 'doc-1' }] }) },
    };
    const callAI = async (req: { messages: Array<{ content: string }> }) => {
      calls.prompt = req.messages[0].content;
      return { data: { title: 'Pick faster', sections: [{ type: 'hero', heading: 'H', body: 'B [src_1]' }], citations: [{ docId: 'doc-1', marker: '[src_1]' }] } };
    };
    const out = await nodePack['feature.campaign-channels.nodes.generate']({ features, callAI, inputs: { briefId: 'b1', channel: 'landing_page' } });
    expect(out.status).toBe('success');
    expect(out.outputs).toMatchObject({ draft: { channel: 'landing_page', title: 'Pick faster' }, complianceReport: { deterministicScore: 90 } });
    expect(Number(at(out.outputs, 'qualityReport', 'overallScore'))).toBeGreaterThan(0);
    // The compliance check ran over THIS draft, for this brand + channel.
    expect(calls.compliance).toMatchObject({ brandId: 'brand-1', channel: 'landing_page' });
    expect(String(at(calls.compliance, 'content'))).toContain('Pick faster');
    expect(String(calls.prompt)).toContain('VOICE');
    expect(String(calls.prompt)).toContain('GROUNDED');
    expect(String(calls.prompt)).toContain('Pick faster'); // kernel echoed
  });

  it('content-quality-check flags a draft with no content', async () => {
    const out = await nodePack['feature.campaign-channels.nodes.content-quality-check']({ inputs: { draft: { channel: 'social_posts' }, channel: 'social_posts' } });
    expect(out.status).toBe('success');
    expect(Number(at(out.outputs, 'report', 'overallScore'))).toBeLessThan(70);
    expect(at(out.outputs, 'report', 'passesThreshold')).toBe(false);
  });
});

describe('campaign-channels — channel workflows', () => {
  it('builds five channel workflows with stable ids', () => {
    expect(CHANNEL_WORKFLOWS).toHaveLength(5);
    expect(CHANNEL_WORKFLOW_IDS).toEqual([
      'campaign-studio.channel.landing-page',
      'campaign-studio.channel.ad-variants',
      'campaign-studio.channel.email-sequence',
      'campaign-studio.channel.creative-briefs',
      'campaign-studio.channel.social-posts',
    ]);
  });

  it('each workflow is a valid generate → approve DAG with a briefId variable', () => {
    for (const wf of CHANNEL_WORKFLOWS) {
      const nodeIds = wf.nodes.map((n) => n.nodeId);
      expect(nodeIds).toEqual(['generate', 'approve']);
      expect(wf.nodes[0].typeId).toBe('feature.campaign-channels.nodes.generate');
      expect(wf.nodes[1].typeId).toBe('core.approvalGate');
      expect(wf.edges).toEqual([{ edgeId: 'e_generate_approve', sourceNodeId: 'generate', targetNodeId: 'approve' }]);
      expect(wf.variables?.[0]?.name).toBe('briefId');
    }
  });

  it('array channels carry itemsFrom (per-item refine); landing page does not', () => {
    const lp = CHANNEL_WORKFLOWS.find((w) => w.workflowId.endsWith('landing-page'));
    const email = CHANNEL_WORKFLOWS.find((w) => w.workflowId.endsWith('email-sequence'));
    expect(lp?.nodes[1]?.config).toBeDefined();
    expect(lp?.nodes[1]?.config).not.toHaveProperty('itemsFrom');
    expect(email?.nodes[1]?.config).toMatchObject({ itemsFrom: 'emails' });
  });
});

describe('campaign-channels — agent pack', () => {
  it('loads the Channel Generator agent through the real manifest loader', () => {
    // CFP-1: the exact allowlist is pinned in campaign-agent-tools.test.ts and the
    // resolution tripwire is test/agent-allowlist-resolution.test.ts; this case pins
    // that the pack LOADS (the loader validates the manifest) as exactly one agent.
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'vendor.openwop-app.campaign-channels.agents'));
    expect(loaded.map((a) => a.agentId)).toEqual(['vendor.openwop-app.campaign-channels.agents.channel-generator']);
  });
});

describe('R2 CRB-SP-6 — creative_briefs prompt↔schema parity (the promptCatalogParity discipline)', () => {
  it('every field the system prompt promises is expressible in the response schema', () => {
    // The prompt demanded "2-3 direction variants per format" while the schema
    // (additionalProperties:false) had no `directions` property — the model
    // could never return them, the landing code's `vb.directions` was dead, and
    // every generated managed brief arrived direction-less, immediately
    // triggering the app's own "No creative directions" warning.
    const spec = CHANNEL_SPEC.creative_briefs;
    expect(spec?.system).toMatch(/direction variants/);
    expect(spec?.itemsKey).toBe('briefs');
    const dirItems = at(spec?.schema, 'properties', 'briefs', 'items', 'properties', 'directions', 'items');
    expect(at(dirItems, 'properties')).toHaveProperty('label');
    expect(at(dirItems, 'required')).toContain('label');
    // Both halves of the entity's own SSoT claim ("2-3 creative-direction
    // variants") are now structurally reachable: prompt promises, schema admits.
  });
});
