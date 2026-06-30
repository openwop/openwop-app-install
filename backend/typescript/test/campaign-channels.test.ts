/**
 * Campaign Channels (ADR 0157) — the generate + content-quality nodes over a
 * stubbed 3-surface ctx, the five channel child workflows (DAG validity), the
 * artifact-type registration, and the agent pack.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack } from '../../../packs/feature.campaign-channels.nodes/index.mjs';
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
  it('exports generate + content-quality-check + the five publish nodes', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.campaign-channels.nodes.content-quality-check',
      'feature.campaign-channels.nodes.generate',
      'feature.campaign-channels.nodes.publish-ad-variants',
      'feature.campaign-channels.nodes.publish-creative-briefs',
      'feature.campaign-channels.nodes.publish-email-sequence',
      'feature.campaign-channels.nodes.publish-landing-page',
      'feature.campaign-channels.nodes.publish-social-posts',
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
        checkComplianceDeterministic: async (a: unknown) => { calls.compliance = a; return { report: { deterministicScore: 90, hasBannedPhrase: false } }; },
      },
      kb: { rag: async () => ({ augmentedPrompt: 'GROUNDED', citations: [{ docId: 'doc-1' }] }) },
    };
    const callAI = async (req: { messages: Array<{ content: string }> }) => {
      calls.prompt = req.messages[0].content;
      return { data: { title: 'Pick faster', sections: [{ type: 'hero', heading: 'H', body: 'B [src_1]' }], citations: [{ docId: 'doc-1', marker: '[src_1]' }] } };
    };
    const out = await nodePack['feature.campaign-channels.nodes.generate']({ features, callAI, inputs: { briefId: 'b1', channel: 'landing_page' } });
    expect(out.status).toBe('success');
    const o = out.outputs as Record<string, any>;
    expect(o.draft.channel).toBe('landing_page');
    expect(o.draft.title).toBe('Pick faster');
    expect(o.qualityReport.overallScore).toBeGreaterThan(0);
    expect(o.complianceReport.deterministicScore).toBe(90);
    expect(String(calls.prompt)).toContain('VOICE');
    expect(String(calls.prompt)).toContain('GROUNDED');
    expect(String(calls.prompt)).toContain('Pick faster'); // kernel echoed
  });

  it('content-quality-check flags a draft with no content', async () => {
    const out = await nodePack['feature.campaign-channels.nodes.content-quality-check']({ inputs: { draft: { channel: 'social_posts' }, channel: 'social_posts' } });
    expect(out.status).toBe('success');
    const r = out.outputs?.report as Record<string, unknown>;
    expect(r.overallScore).toBeLessThan(70);
    expect(r.passesThreshold).toBe(false);
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
    expect((lp?.nodes[1].config as Record<string, unknown>).itemsFrom).toBeUndefined();
    expect((email?.nodes[1].config as Record<string, unknown>).itemsFrom).toBe('emails');
  });
});

describe('campaign-channels — agent pack', () => {
  it('loads the Channel Generator with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(join(REPO_ROOT, 'packs', 'feature.campaign-channels.agents'));
    expect(loaded.length).toBe(1);
    expect(loaded[0].agentId).toBe('feature.campaign-channels.agents.channel-generator');
    expect(loaded[0].toolAllowlist).toContain('openwop:feature.campaign-channels.nodes.generate');
  });
});
