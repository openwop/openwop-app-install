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
    const { ctx } = ctxWith([], { claims: [{ ...CLAIM, sourceHashes: ['sha256:aaa', 'sha256:bbb'] }], sources: [SRC, src2], pages: [PAGE, page2] });
    // Pairs are judged concurrently (KTF-RS-2), so answers key on the SOURCE and
    // on whether this is the skeptical second opinion, as a real model's would.
    ctx.callAI = vi.fn(async (req: { systemPrompt?: string; messages?: Array<{ content?: string }> }) => {
      const skeptical = /SKEPTICAL/.test(String(req.systemPrompt));
      const second = String(req.messages?.[0]?.content).includes('A 20-minute walk improved mood.');
      if (!second) return { data: skeptical ? { verdict: 'unrelated' } : { verdict: 'supports', span: 'x' } }; // pair 1 → disputed
      return { data: { verdict: 'supports', span: 'y' } };                                                    // pair 2 → agreed
    });
    const out = await claimVerify(ctx);
    expect(out.status).toBe('success');
    const o = out.outputs as { disputedClaimIds: string[] };
    expect(o.disputedClaimIds, 'the disagreement must reach the human, not vanish').toEqual(['c-1']);
  });

  // KTF-RS-2 — pairs are judged with bounded concurrency, and each result lands in
  // its PLANNED slot whatever order the calls return in. Sabotage: a serial loop
  // never has >1 call in flight (reds the first expect); appending results in
  // completion order reds the order assertion.
  it('judges pairs concurrently (bounded) and keeps claim/source order regardless of completion order', async () => {
    const hashes = ['sha256:a1', 'sha256:a2', 'sha256:a3', 'sha256:a4', 'sha256:a5', 'sha256:a6'];
    const sources = hashes.map((h, n) => ({ hash: h, title: `S${n}`, url: `https://s${n}.example/` }));
    const pages = hashes.map((_, n) => ({ url: `https://s${n}.example/`, extractedText: `source number ${n}`, status: 200 }));
    const { ctx } = ctxWith([], { claims: [{ ...CLAIM, sourceHashes: hashes }], sources, pages });
    let inFlight = 0, peak = 0;
    ctx.callAI = vi.fn(async (req: { messages?: Array<{ content?: string }> }) => {
      inFlight++; peak = Math.max(peak, inFlight);
      const n = Number(/source number (\d)/.exec(String(req.messages?.[0]?.content))?.[1]);
      // Later sources answer FIRST.
      await new Promise((r) => setTimeout(r, (hashes.length - n) * 3));
      inFlight--;
      return { data: { verdict: 'unrelated' } };
    });
    const out = await claimVerify(ctx);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    // No pair is entailed, so the node fails closed — but every pair was judged once.
    expect(out.status).toBe('failed');
    expect(ctx.callAI).toHaveBeenCalledTimes(hashes.length);
  });

  it('the per-claim support list follows the claim\'s source order even when answers arrive out of order', async () => {
    const hashes = ['sha256:a1', 'sha256:a2', 'sha256:a3'];
    const sources = hashes.map((h, n) => ({ hash: h, title: `S${n}`, url: `https://s${n}.example/` }));
    const pages = hashes.map((_, n) => ({ url: `https://s${n}.example/`, extractedText: `source number ${n}`, status: 200 }));
    const { ctx } = ctxWith([], { claims: [{ ...CLAIM, sourceHashes: hashes }], sources, pages });
    ctx.callAI = vi.fn(async (req: { messages?: Array<{ content?: string }> }) => {
      const n = Number(/source number (\d)/.exec(String(req.messages?.[0]?.content))?.[1]);
      await new Promise((r) => setTimeout(r, (hashes.length - n) * 3));
      return { data: { verdict: 'supports', span: `span ${n}` } };
    });
    const out = await claimVerify(ctx);
    expect(out.status).toBe('success');
    const support = (out.outputs as { claims: Array<{ support: Array<{ sourceHash: string; span: string }> }> }).claims[0]!.support;
    expect(support.map((x) => x.sourceHash)).toEqual(hashes);
    expect(support.map((x) => x.span)).toEqual(['span 0', 'span 1', 'span 2']);
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

  // XCH-CV-1 — ONE bounded error-fed repair before the downgrade, so a
  // formatting slip does not silently lose a pair the model could judge.
  it('an off-schema judgement is repaired ONCE with the defect named, then counted', async () => {
    const calls: Array<Array<{ role?: string; content?: string }>> = [];
    const answers: Array<Record<string, unknown>> = [
      { verdict: 'yes-definitely' },
      { verdict: 'supports', span: 'walking 20 minutes daily reported better mood' },
      { verdict: 'supports', span: 'walking 20 minutes daily reported better mood' },
    ];
    const { ctx: base } = ctxWith([]);
    const ctx = {
      ...base,
      callAI: vi.fn(async (req: { messages?: Array<{ role?: string; content?: string }> }) => {
        calls.push(req.messages ?? []);
        return { data: answers[calls.length - 1] };
      }),
    };
    const out = await claimVerify(ctx);
    expect(out.status).toBe('success');
    expect(calls.length, 'first + one repair + the second opinion').toBe(3);
    expect(calls[1]!.length).toBe(3);
    expect(String(calls[1]![2]!.content)).toContain('`verdict` must be one of');
  });

  it('a `supports` without a span is asked for the span once, then downgraded if still missing', async () => {
    const { ctx, callAI } = ctxWith([{ verdict: 'supports' }]);
    const out = await claimVerify(ctx);
    expect(out.status).toBe('failed');
    expect(callAI).toHaveBeenCalledTimes(2);
  });

  // XCH-CE-1 — a cut source is DISCLOSED to the verifier, never posed as whole.
  it('a source longer than the read window is marked TRUNCATED in what the model reads', async () => {
    const long = { ...PAGE, extractedText: `${PAGE.extractedText} ${'filler '.repeat(2000)}` };
    const { ctx, calls } = ctxWith([{ verdict: 'unrelated' }], { pages: [long] });
    await claimVerify(ctx);
    expect(calls[0]!.user).toContain('[TRUNCATED — the first 6000 of');
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
