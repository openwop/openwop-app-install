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
 * generate → approve edge or its `falsy(skipped)` condition; generate a channel the
 * brief does not enable, or skip one it does; stop writing `channelResult`; remove
 * `directions` from the creative_briefs schema.
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
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { buildChainBackedDefinition, getChainBackedWorkflow, _resetChainBackedWorkflowsForTest } from '../src/host/chainBackedWorkflows.js';
import { registerLegacyDefsChainBacked } from '../src/features/index.js';

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
  it('exports generate + content-quality-check + create-creative-briefs + the five publish nodes + render-concepts', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.campaign-channels.nodes.content-quality-check',
      'feature.campaign-channels.nodes.create-creative-briefs', // ADR 1020 D14
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

  // ADR 1020 D2/D3 — a bag that records every write, fresh per case.
  const bag = () => { const m = new Map<string, unknown>(); return { m, variables: { set: (k: string, v: unknown) => { m.set(k, v); }, get: (k: string) => m.get(k) } }; };
  // `enabledChannels` is what the real surface spreads from `validateBrief`.
  const briefWithChannels = (enabledChannels: string[]) => ({
    assembleContext: async () => ({ ...(await goodBriefSurface.assembleContext()), enabledChannels }),
  });

  it('skips a channel the brief does not enable: no model call, top-level skipped, channelResult written (ADR 1020 D3)', async () => {
    let called = 0;
    const b = bag();
    const out = await nodePack['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefWithChannels(['landing_page']) },
      callAI: async () => { called += 1; return { data: {} }; },
      variables: b.variables,
      config: { skipDisabledChannel: true },
      inputs: { briefId: 'b1', channel: 'social_posts' },
    });
    expect(out).toMatchObject({ status: 'success', outputs: { skipped: true, reason: 'channel_disabled', channel: 'social_posts' } });
    expect(called).toBe(0);
    expect(b.m.get('channelResult')).toEqual({ channel: 'social_posts', skipped: true, reason: 'channel_disabled' });
  });

  it('WITHOUT the opt-in (a tenant copy of an older chain, whose approval is unconditional) a disabled channel still generates', async () => {
    let called = 0;
    const out = await nodePack['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefWithChannels(['landing_page']) },
      callAI: async () => { called += 1; return { data: { posts: [{ platform: 'linkedin', content: 'Pick faster' }] } }; },
      inputs: { briefId: 'b1', channel: 'social_posts' },
    });
    expect(out.status).toBe('success');
    expect(out.outputs?.skipped).toBeUndefined();
    expect(called).toBeGreaterThan(0);
  });

  it('a stale kernel fails kernel_stale, not "generate the kernel" (ADR 1020 D8)', async () => {
    const out = await nodePack['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': { assembleContext: async () => ({ ...(await goodBriefSurface.assembleContext()), kernel: null, kernelStale: true }) } },
      callAI: async () => ({ data: {} }),
      inputs: { briefId: 'b1', channel: 'landing_page' },
    });
    expect(out).toMatchObject({ status: 'failed', error: { code: 'kernel_stale' } });
  });

  it('generates an enabled channel and reports the draft through channelResult (ADR 1020 D2)', async () => {
    const b = bag();
    const out = await nodePack['feature.campaign-channels.nodes.generate']({
      features: { 'campaign-brief': briefWithChannels(['landing_page']) },
      callAI: async () => ({ data: { title: 'Pick faster', sections: [{ type: 'hero', heading: 'H', body: 'B' }] } }),
      variables: b.variables,
      inputs: { briefId: 'b1', channel: 'landing_page' },
    });
    expect(out.status).toBe('success');
    expect(out.outputs?.skipped).toBeUndefined();
    const result = b.m.get('channelResult') as { channel: string; draft: { title: string } };
    expect(result.channel).toBe('landing_page');
    expect(result.draft.title).toBe('Pick faster');
  });

  it('content-quality-check flags a draft with no content', async () => {
    const out = await nodePack['feature.campaign-channels.nodes.content-quality-check']({ inputs: { draft: { channel: 'social_posts' }, channel: 'social_posts' } });
    expect(out.status).toBe('success');
    expect(Number(at(out.outputs, 'report', 'overallScore'))).toBeLessThan(70);
    expect(at(out.outputs, 'report', 'passesThreshold')).toBe(false);
  });
});

describe('campaign-channels — channel workflows (the chain-backed definitions that run)', () => {
  // ADR 1020 D7 / CS70WF-29 — assert the definitions the registrar actually builds
  // from the chain pack, not the in-tree source (which is now only ids + roles).
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  const defs = CHANNEL_WORKFLOW_IDS.map((id) => buildChainBackedDefinition(id));
  const bare = (id: string): string => id.replace(/^.*_/, '');

  it('builds five channel workflows with stable ids from the real loader', () => {
    expect(errors).toEqual([]);
    expect(CHANNEL_WORKFLOWS).toHaveLength(5);
    expect(CHANNEL_WORKFLOW_IDS).toEqual([
      'campaign-studio.channel.landing-page',
      'campaign-studio.channel.ad-variants',
      'campaign-studio.channel.email-sequence',
      'campaign-studio.channel.creative-briefs',
      'campaign-studio.channel.social-posts',
    ]);
    expect(defs.map((d) => d.workflowId)).toEqual([...CHANNEL_WORKFLOW_IDS]);
  });

  it('each is generate → approve, where a SKIPPED channel never reaches the approval (ADR 1020 D3)', () => {
    for (const wf of defs) {
      const creative = wf.workflowId === 'campaign-studio.channel.creative-briefs';
      // ADR 1020 D14 — creative_briefs creates its managed briefs only after the approval.
      expect(wf.nodes.map((n) => bare(n.nodeId))).toEqual(creative ? ['generate', 'approve', 'skipped', 'briefs'] : ['generate', 'approve', 'skipped']);
      expect(wf.nodes[0]!.typeId).toBe('feature.campaign-channels.nodes.generate');
      expect(wf.nodes[1]!.typeId).toBe('core.approvalGate');
      // A skipped channel ends on a no-op terminal: a run whose only terminal is
      // condition-skipped counts as FAILED (scheduler.ts inspectDisposition).
      expect(wf.nodes[2]!.typeId).toBe('core.noop');
      const edge = (to: string) => (wf.edges ?? []).find((e) => bare(e.targetNodeId) === to)!;
      expect(wf.edges ?? []).toHaveLength(creative ? 4 : 2);
      if (creative) {
        const create = wf.nodes[3]!;
        expect(create.typeId).toBe('feature.campaign-channels.nodes.create-creative-briefs');
        const into = (wf.edges ?? []).filter((e) => e.targetNodeId === create.nodeId);
        expect(into.map((e) => [bare(e.sourceNodeId), e.sourceOutput ?? null, e.targetInput ?? null]).sort()).toEqual([['approve', null, null], ['generate', 'draft', 'draft']]);
      }
      expect(edge('approve').condition).toEqual({ path: 'skipped', op: 'falsy' });
      expect(edge('skipped').condition).toEqual({ path: 'skipped', op: 'truthy' });
      expect(wf.variables?.map((v) => v.name)).toEqual(expect.arrayContaining(['briefId', 'channelResult']));
    }
  });

  it('the REGISTERED definitions carry the roles: draft secondary, approval primary, skip terminal primary', () => {
    // Asserted on what the boot registrar builds (not on the role-map constant),
    // so a registrar that stopped restoring roles reds this.
    _resetChainBackedWorkflowsForTest();
    registerLegacyDefsChainBacked(CHANNEL_WORKFLOWS);
    for (const id of CHANNEL_WORKFLOW_IDS) {
      const wf = getChainBackedWorkflow(id)!;
      expect(Object.fromEntries(wf.nodes.map((n) => [bare(n.nodeId), n.outputRole ?? null]))).toEqual(id.endsWith('creative-briefs')
        // The creative_briefs run's primary output is the creation summary (how many, where).
        ? { generate: 'secondary', approve: 'secondary', skipped: 'primary', briefs: 'primary' }
        : { generate: 'secondary', approve: 'primary', skipped: 'primary' });
    }
  });

  it('every generate opts in to the skip, the skip terminal says why, and array channels keep itemsFrom', () => {
    for (const wf of defs) {
      expect(wf.nodes[0]!.config).toMatchObject({ skipDisabledChannel: true });
      expect(String((wf.nodes[2]!.inputs as Record<string, unknown> | undefined)?.summary)).toMatch(/^Skipped: this brief does not enable the .+ channel/);
    }
    const byId = new Map(defs.map((d) => [d.workflowId, d]));
    expect(byId.get('campaign-studio.channel.landing-page')!.nodes[1]!.config).not.toHaveProperty('itemsFrom');
    expect(byId.get('campaign-studio.channel.email-sequence')!.nodes[1]!.config).toMatchObject({ itemsFrom: 'emails' });
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
