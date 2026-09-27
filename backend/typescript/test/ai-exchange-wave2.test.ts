/**
 * LLM-EXCHANGE-AUDIT Wave 2 — validation-hole regressions:
 *  - XCH-CORE-1: structuredOutput deep-validates (nested/enum) and FEEDS the
 *    validation errors back into the retry instead of re-rolling blind.
 *  - XCH-CORE-2: classify never fabricates confidence or coerces an off-list
 *    reply to labels[0] — normalized match, then typed failure.
 *  - XCH-MI-2: a market-intel node whose AI reply is unparseable fails typed
 *    (AI_OUTPUT_UNPARSEABLE), no longer success-with-empty.
 *  - XCH-LP-1: landing-page content generation fails typed instead of
 *    shipping branded placeholder content; SEO/CTAs derive from real content.
 */
import { describe, expect, it } from 'vitest';
import { structuredOutput, classify } from '../../../packs/core.openwop.ai/index.mjs';
import { communityRank } from '../../../packs/vendor.myndhyve.market-intel-community-rank/index.mjs';
import { contentGenerate } from '../../../packs/vendor.myndhyve.landing-page/index.mjs';

type Msg = { role: string; content: string };

describe('core.ai.structuredOutput deep validation + error feedback (XCH-CORE-1)', () => {
  const schema = {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: { type: 'object', required: ['kind'], properties: { kind: { enum: ['a', 'b'] } } } },
    },
  };

  it('rejects a nested violation the old shallow check missed, then accepts the repaired attempt', async () => {
    const calls: Msg[][] = [];
    const replies = [
      { data: { items: [{ kind: 'zzz' }] } }, // nested enum violation — shallow check passed this
      { data: { items: [{ kind: 'a' }] } },
    ];
    const ctx = {
      config: { outputSchema: schema, retryOnInvalidJson: 2 },
      inputs: { messages: [{ role: 'user', content: 'go' }] },
      callAI: async (req: { messages: Msg[] }) => { calls.push(req.messages); return replies[calls.length - 1]; },
    };
    const r = await structuredOutput(ctx);
    expect(r.outputs.data).toEqual({ items: [{ kind: 'a' }] });
    expect(r.outputs.retries).toBe(1);
    // The retry carried the validation errors back to the model.
    const retryMessages = calls[1];
    const feedback = retryMessages[retryMessages.length - 1];
    expect(feedback.content).toContain('INVALID');
    expect(feedback.content).toContain('$.items[0].kind');
  });

  it('fails typed after exhausting retries', async () => {
    const ctx = {
      config: { outputSchema: schema, retryOnInvalidJson: 1 },
      inputs: { messages: [{ role: 'user', content: 'go' }] },
      callAI: async () => ({ data: { wrong: true } }),
    };
    await expect(structuredOutput(ctx)).rejects.toMatchObject({ code: 'structured_output_invalid' });
  });
});

describe('core.ai.classify honesty (XCH-CORE-2)', () => {
  const base = { config: { labels: ['Bug Report', 'Feature Request'] }, inputs: { text: 'x' } };

  it('matches exactly and emits NO fabricated confidence/allScores', async () => {
    const r = await classify({ ...base, callAI: async () => ({ content: 'Bug Report' }) });
    expect(r.outputs).toEqual({ label: 'Bug Report' });
  });

  it('normalizes case/punctuation noise before matching', async () => {
    const r = await classify({ ...base, callAI: async () => ({ content: '"bug report".' }) });
    expect(r.outputs).toEqual({ label: 'Bug Report' });
  });

  it('fails typed on an off-list reply instead of coercing to labels[0]', async () => {
    await expect(classify({ ...base, callAI: async () => ({ content: 'Complaint' }) }))
      .rejects.toMatchObject({ code: 'classification_unmatched' });
  });
});

describe('market-intel typed failure on unparseable AI output (XCH-MI-2)', () => {
  it('community-rank returns AI_OUTPUT_UNPARSEABLE, not success-with-empty', async () => {
    const ctx = {
      inputs: {
        candidateCommunities: [{ id: 'c1', name: 'r/startups', platform: 'reddit' }],
        icpContext: { segment: 'founders' },
        productContext: { name: 'Widget' },
      },
      config: {},
      callAI: async () => ({ content: 'I could not produce JSON, sorry!' }),
    };
    const r = await communityRank(ctx);
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_OUTPUT_UNPARSEABLE');
  });
});

describe('landing-page honest failure + derived metadata (XCH-LP-1)', () => {
  const inputs = { blueprintId: 'bp1', personaIds: ['p1'], messagePillars: { core: 'speed' } };

  it('fails typed on an unparseable reply instead of shipping branded placeholders', async () => {
    const r = await contentGenerate({ inputs, config: {}, callAI: async () => ({ content: 'no json here' }) });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_OUTPUT_UNPARSEABLE');
  });

  it('fails typed when the AI call itself throws (was: silent defaults)', async () => {
    const r = await contentGenerate({ inputs, config: {}, callAI: async () => { throw new Error('provider down'); } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_GENERATION_FAILED');
  });

  it('derives SEO + CTAs from the model content when those keys are absent — never boilerplate', async () => {
    const reply = {
      headlines: [{ text: 'Ship Faster With Widget', angle: 'outcome' }],
      sections: [{ type: 'hero', content: { headline: 'Ship Faster', subheadline: 'Widget cuts release time.', ctaText: 'Try Widget' } }],
    };
    const r = await contentGenerate({ inputs, config: {}, callAI: async () => ({ content: JSON.stringify(reply) }) });
    expect(r.status).toBe('success');
    expect(r.outputs.seoMetadata.title).toBe('Ship Faster With Widget');
    expect(r.outputs.seoMetadata.description).toBe('Widget cuts release time.');
    expect(r.outputs.ctaVariants.map((c: { text: string }) => c.text)).toEqual(['Try Widget']);
    const dumped = JSON.stringify(r.outputs);
    expect(dumped).not.toContain('MyndHyve');
    expect(dumped).not.toContain('Transform Your Business Today');
  });
});
