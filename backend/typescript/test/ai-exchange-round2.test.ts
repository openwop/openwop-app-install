/**
 * LLM-EXCHANGE-AUDIT round 2 — bounded error-fed repair on the remaining
 * single-shot generators (they previously failed on the first invalid reply):
 *  - XCH-PROD-2: production.plan-generate retries ONCE with the failure named;
 *  - XCH-CB-3: campaign-brief.generate-kernel retries ONCE the same way;
 *  - XCH-CORE-6: core.ai.extract retries ONCE before its honest confidence-0
 *    fallback (which previously shipped raw prose on the first miss);
 *  - XCH-RAG-1: rag multi-query prefers provider-native JSON (result.data),
 *    keeping the line-split as the text fallback.
 */
import { describe, expect, it } from 'vitest';
import { planGenerate } from '../../../packs/feature.production.nodes/index.mjs';
import { generateKernel } from '../../../packs/feature.campaign-brief.nodes/index.mjs';
import { extract } from '../../../packs/core.openwop.ai/index.mjs';
import { retrieverMultiQuery } from '../../../packs/core.openwop.rag/index.mjs';

describe('production.plan-generate bounded repair (XCH-PROD-2)', () => {
  const features = {
    production: {
      buildContext: async () => ({ teamCapabilitySection: 'TEAM: x', vendorSection: 'VENDORS: y', gaps: [] }),
      savePlan: async (p: Record<string, unknown>) => ({ planId: 'plan-1', ...p }),
    },
  };

  it('repairs once with the failure named, then persists the corrected plan', async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const replies = [
      { data: { nope: true } }, // invalid — no strategySummary
      { data: { strategySummary: 'Fixed.', recommendations: [] } },
    ];
    const ctx = {
      features,
      inputs: { orgId: 'o1', channels: ['email'] },
      callAI: async (req: { messages: Array<{ role: string; content: string }> }) => { calls.push(req); return replies[calls.length - 1]; },
    };
    const r = await planGenerate(ctx);
    expect(r.status).toBe('success');
    expect(calls.length).toBe(2);
    const feedback = calls[1]!.messages[calls[1]!.messages.length - 1]!.content;
    expect(feedback).toContain('INVALID');
    expect(feedback).toContain('strategySummary');
  });

  it('fails typed after the single repair attempt', async () => {
    const ctx = { features, inputs: { orgId: 'o1', channels: ['email'] }, callAI: async () => ({ data: { nope: true } }) };
    const r = await planGenerate(ctx);
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('generation_empty');
  });
});

describe('campaign-brief.generate-kernel bounded repair (XCH-CB-3)', () => {
  const features = {
    'campaign-brief': {
      assembleContext: async () => ({ found: true, contextText: 'CTX', brief: { briefId: 'b1', groundingPolicy: 'off' } }),
      getBrief: async () => ({ brief: { briefId: 'b1' } }),
      setKernel: async () => ({ ok: true }),
    },
  };

  it('repairs once and persists the corrected kernel', async () => {
    let calls = 0;
    const replies = [
      { data: { headline: 42 } }, // invalid — headline not a string
      { data: { headline: 'H', supportingStatement: 'S', proofPoints: [], primaryCta: 'Go', tone: 'bold' } },
    ];
    const ctx = {
      features,
      inputs: { briefId: 'b1' },
      callAI: async () => replies[Math.min(calls++, 1)],
    };
    const r = await generateKernel(ctx);
    expect(r.status).toBe('success');
    expect(calls).toBe(2);
    expect((r.outputs?.kernel as { headline: string }).headline).toBe('H');
  });
});

describe('core.ai.extract bounded repair (XCH-CORE-6)', () => {
  it('repairs a prose reply once before the honest confidence-0 fallback', async () => {
    let calls = 0;
    const replies = [
      { content: 'Sure! Here is the data you asked for.' },
      { data: { name: 'Ada' } },
    ];
    const ctx = {
      config: { schema: { type: 'object', properties: { name: { type: 'string' } } } },
      inputs: { text: 'Ada wrote it.' },
      callAI: async () => replies[Math.min(calls++, 1)],
    };
    const r = await extract(ctx);
    expect(calls).toBe(2);
    expect(r.outputs).toEqual({ value: { name: 'Ada' }, confidence: 1 });
  });

  it('still falls back honestly (confidence 0) when the repair also fails', async () => {
    const ctx = {
      config: { schema: { type: 'object' } },
      inputs: { text: 'x' },
      callAI: async () => ({ content: 'not json, twice' }),
    };
    const r = await extract(ctx);
    expect(r.outputs?.confidence).toBe(0);
  });
});

describe('rag multi-query prefers provider-native JSON (XCH-RAG-1)', () => {
  it('reads result.data when the provider honors the array schema', async () => {
    const ctx = {
      config: { variants: 2 },
      inputs: { query: 'base' },
      callAI: async () => ({ data: ['alt one', 'alt two'] }),
      callEmbeddings: async () => ({ embedding: [0.1, 0.2] }),
      db: { vector: { query: async () => ({ hits: [] }) } },
    };
    const r = await retrieverMultiQuery(ctx);
    expect(r.outputs?.queriesUsed).toEqual(['base', 'alt one', 'alt two']);
  });
});
