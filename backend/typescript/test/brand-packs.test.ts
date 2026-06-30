/**
 * Brand packs (ADR 0155 Phase 3) — the node pack's behaviour over a stubbed
 * `ctx.features.brand` surface (incl. the LLM blend via a stub ctx.callAI) + the
 * agent pack manifest loading (systemPromptRef + tool-allowlist). Mirrors
 * priority-matrix-packs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { nodes as nodePack } from '../../../packs/feature.brand.nodes/index.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const AGENT_PACK = join(REPO_ROOT, 'packs', 'feature.brand.agents');

describe('feature.brand.nodes — node pack', () => {
  it('exports the four brand node fns', () => {
    expect(Object.keys(nodePack).sort()).toEqual([
      'feature.brand.nodes.compliance-check',
      'feature.brand.nodes.get-app-identity',
      'feature.brand.nodes.list-brands',
      'feature.brand.nodes.resolve-voice',
    ]);
  });

  it('get-app-identity reads the app identity over the surface', async () => {
    const features = { brand: { getAppIdentity: async () => ({ identity: { productName: 'Acme' } }) } };
    const out = await nodePack['feature.brand.nodes.get-app-identity']({ features });
    expect(out).toMatchObject({ status: 'success', outputs: { identity: { productName: 'Acme' } } });
    await expect(nodePack['feature.brand.nodes.get-app-identity']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('fails closed with host_capability_missing when the surface is absent', async () => {
    await expect(nodePack['feature.brand.nodes.list-brands']({ features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
  });

  it('resolve-voice shapes the output and fails on a missing brand', async () => {
    const features = { brand: { checkComplianceDeterministic: async () => ({}), resolveVoice: async (a: { brandId: string }) => (a.brandId === 'b1' ? { voice: 'VOICE BLOCK' } : { voice: null }) } };
    const ok = await nodePack['feature.brand.nodes.resolve-voice']({ features, inputs: { brandId: 'b1' } });
    expect(ok).toEqual({ status: 'success', outputs: { voice: 'VOICE BLOCK' } });
    const miss = await nodePack['feature.brand.nodes.resolve-voice']({ features, inputs: { brandId: 'nope' } });
    expect(miss.status).toBe('failed');
    expect(miss.error?.code).toBe('brand_not_found');
  });

  it('compliance-check degrades to the deterministic score with no ctx.callAI', async () => {
    const features = {
      brand: {
        checkComplianceDeterministic: async () => ({ report: { deterministicScore: 90, issues: [], hasBannedPhrase: false, passesThreshold: true, checkedAt: 'now' } }),
        resolveVoice: async () => ({ voice: 'V' }),
      },
    };
    const out = await nodePack['feature.brand.nodes.compliance-check']({ features, inputs: { brandId: 'b1', content: 'clean copy' } });
    expect(out.status).toBe('success');
    const report = out.outputs?.report as Record<string, unknown>;
    expect(report.overallScore).toBe(90);
    expect(report.llmScore).toBeUndefined();
  });

  it('compliance-check blends 60/40 when ctx.callAI returns a tone score', async () => {
    const features = {
      brand: {
        checkComplianceDeterministic: async () => ({ report: { deterministicScore: 100, issues: [], hasBannedPhrase: false, passesThreshold: true, checkedAt: 'now' } }),
        resolveVoice: async () => ({ voice: 'V' }),
      },
    };
    const callAI = async () => ({ data: { score: 50, issues: [{ description: 'too casual' }] } });
    const out = await nodePack['feature.brand.nodes.compliance-check']({ features, callAI, inputs: { brandId: 'b1', content: 'hey there' } });
    const report = out.outputs?.report as Record<string, unknown>;
    expect(report.llmScore).toBe(50);
    expect(report.overallScore).toBe(80); // 100*0.6 + 50*0.4
    expect((report.issues as unknown[]).length).toBe(1);
  });

  it('compliance-check caps a banned-phrase score ≤30 even with a high LLM score', async () => {
    const features = {
      brand: {
        checkComplianceDeterministic: async () => ({ report: { deterministicScore: 30, issues: [{ category: 'banned-phrase', severity: 'error', description: 'banned' }], hasBannedPhrase: true, passesThreshold: false, checkedAt: 'now' } }),
        resolveVoice: async () => ({ voice: 'V' }),
      },
    };
    const callAI = async () => ({ data: { score: 100 } });
    const out = await nodePack['feature.brand.nodes.compliance-check']({ features, callAI, inputs: { brandId: 'b1', content: 'revolutionary' } });
    const report = out.outputs?.report as Record<string, unknown>;
    expect(report.overallScore).toBeLessThanOrEqual(30);
    expect(report.passesThreshold).toBe(false);
  });
});

describe('feature.brand.agents — agent pack', () => {
  it('loads the Brand Steward with its tool-allowlist', () => {
    const loaded = loadAgentsFromManifest(AGENT_PACK);
    expect(loaded.length).toBe(1);
    const steward = loaded[0];
    expect(steward.agentId).toBe('feature.brand.agents.brand-steward');
    expect(steward.toolAllowlist).toEqual([
      'openwop:feature.brand.nodes.list-brands',
      'openwop:feature.brand.nodes.resolve-voice',
      'openwop:feature.brand.nodes.compliance-check',
    ]);
  });
});
