/**
 * `feature.kicktodo.nodes.claim-verify` (ADR 0494 P2b) — does the cited source
 * actually SUPPORT the claim?
 *
 * The structural check proves a source was recorded; it cannot prove the source
 * says what the claim says. That gap is the field's dangerous case — the damaging
 * citation errors are not fabrications but REAL SOURCES APPLIED INCORRECTLY
 * (Stanford 2026: 17–34% of legal-AI queries mis-sourced; accuracy under 66% while
 * users trust more and verify less).
 *
 * What matters here is the COST SHAPE and the DISAGREEMENT POLICY, so those are
 * what these pin.
 */
import { describe, it, expect, vi } from 'vitest';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const mod = (await import(packUrl)) as { claimVerify: (ctx: unknown) => Promise<Record<string, unknown>> };
const claimVerify = mod.claimVerify;

const SRC = { hash: 'sha256:aaa', title: 'Walk study', url: 'https://a.example/walk' };
const PAGE = { url: 'https://a.example/walk', extractedText: 'Participants walking 20 minutes daily reported better mood.', status: 200 };
const CLAIM = { claimId: 'c-1', text: 'A 20-minute daily walk improves mood.', sourceHashes: ['sha256:aaa'] };

/** `verdicts` is consumed in call order — [first, second-opinion, …]. */
function ctxWith(verdicts: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  const calls: Array<{ system: string; user: string }> = [];
  const callAI = vi.fn(async (req: { systemPrompt?: string; messages?: Array<{ content?: string }> }) => {
    calls.push({ system: String(req.systemPrompt ?? ''), user: String(req.messages?.[0]?.content ?? '') });
    return { data: verdicts[Math.min(calls.length - 1, verdicts.length - 1)] };
  });
  return {
    ctx: {
      inputs: { claims: [CLAIM], sources: [SRC], pages: [PAGE], ...over },
      config: (over.config as Record<string, unknown>) ?? {},
      callAI,
      features: { 'kicktodo-creator': {
        frameResearch: async () => ({ questions: [] }),          // ensureCreator's probe
        verdictSchema: async () => ({ schema: { type: 'object' } }),
      } },
    },
    calls,
    callAI,
  };
}

describe('claim-verify — entailment', () => {
  it('a supported claim passes, and a SECOND skeptical opinion is sought', async () => {
    const { ctx, calls } = ctxWith([
      { verdict: 'supports', span: 'walking 20 minutes daily reported better mood' },
      { verdict: 'supports', span: 'walking 20 minutes daily reported better mood' },
    ]);
    const out = await claimVerify(ctx);
    expect(out.status).toBe('success');
    const o = out.outputs as { claims: Array<{ support: Array<Record<string, unknown>> }>; secondOpinions: number };
    expect(o.claims[0]!.support[0]).toMatchObject({ sourceHash: 'sha256:aaa', verdict: 'supports', secondOpinion: 'supports' });
    expect(o.secondOpinions).toBe(1);
    // The second judgement must actually be ADVERSARIAL, not a re-ask.
    expect(calls[1]!.system).toMatch(/SKEPTICAL/);
    expect(calls[0]!.system).not.toMatch(/SKEPTICAL/);
  });

  it('COST SHAPE — a NON-supporting verdict costs ONE call, not two', async () => {
    // The dangerous error is a false `supports`; a false `unrelated` merely loses a
    // claim. So the 2× is targeted, not universal — that is what makes this affordable.
    const { ctx, callAI } = ctxWith([{ verdict: 'unrelated' }]);
    await claimVerify(ctx);
    expect(callAI).toHaveBeenCalledTimes(1);
  });

  it('DISAGREEMENT is recorded, not resolved — and stops counting as support', async () => {
    const { ctx } = ctxWith([
      { verdict: 'supports', span: 'better mood' },
      { verdict: 'unrelated' },
    ]);
    const out = await claimVerify(ctx);
    // The claim had exactly one citation, and it is disputed ⇒ nothing survives.
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('no_entailed_claims');
  });

  it('a disputed pair is SURFACED when another citation carries the claim', async () => {
    const src2 = { hash: 'sha256:bbb', title: 'Second', url: 'https://b.example/x' };
    const page2 = { url: 'https://b.example/x', extractedText: 'A 20-minute walk improved mood.', status: 200 };
    const { ctx } = ctxWith(
      [{ verdict: 'supports', span: 'x' }, { verdict: 'unrelated' },   // pair 1 → disputed
       { verdict: 'supports', span: 'y' }, { verdict: 'supports', span: 'y' }], // pair 2 → agreed
      { claims: [{ ...CLAIM, sourceHashes: ['sha256:aaa', 'sha256:bbb'] }], sources: [SRC, src2], pages: [PAGE, page2] },
    );
    const out = await claimVerify(ctx);
    expect(out.status).toBe('success');
    const o = out.outputs as { disputedClaimIds: string[] };
    expect(o.disputedClaimIds, 'the disagreement must reach the human, not vanish').toEqual(['c-1']);
  });

  it('`supports` with NO quoted span is downgraded — an unauditable pass is not a pass', async () => {
    const { ctx } = ctxWith([{ verdict: 'supports' }]);
    const out = await claimVerify(ctx);
    expect(out.status).toBe('failed'); // downgraded to unverifiable ⇒ nothing entailed
  });

  it('an UNPARSEABLE judgement fails closed to `unverifiable`, never `supports`', async () => {
    const { ctx } = ctxWith([{ verdict: 'yes-definitely' }]);
    const out = await claimVerify(ctx);
    expect(out.status).toBe('failed');
  });

  it('a citation with no fetched content is SKIPPED, not guessed at', async () => {
    const { ctx, callAI } = ctxWith([{ verdict: 'supports', span: 'x' }], { pages: [] });
    const out = await claimVerify(ctx);
    expect(callAI, 'nothing to read ⇒ nothing to judge').not.toHaveBeenCalled();
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('no_entailed_claims');
  });

  it('honours a maxVerifications ceiling and REPORTS what it skipped', async () => {
    // A silent cap would make "verified" mean different things on different runs.
    const { ctx } = ctxWith(
      [{ verdict: 'supports', span: 'x' }, { verdict: 'supports', span: 'x' }],
      { claims: [{ ...CLAIM, sourceHashes: ['sha256:aaa', 'sha256:aaa'] }], config: { maxVerifications: 1 } },
    );
    const out = await claimVerify(ctx);
    const o = out.outputs as { verifiedPairs: number; skippedPairs: number };
    expect(o.verifiedPairs).toBe(1);
    expect(o.skippedPairs).toBe(1);
  });

  it('no claims ⇒ typed refusal', async () => {
    const { ctx } = ctxWith([{ verdict: 'supports', span: 'x' }], { claims: [] });
    const out = await claimVerify(ctx);
    expect((out.error as { code: string }).code).toBe('no_claims');
  });
});
