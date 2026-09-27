/**
 * `feature.kicktodo.nodes.claim-extract` (ADR 0494 P2) — the node that turns
 * fetched source CONTENT into claims cited by source hash.
 *
 * The behaviours worth pinning are the fail-closed ones. An ungrounded plan that
 * *claims* to be evidence-led is worse than no plan, so "no readable content" and
 * "nothing supported" must both REFUSE rather than pass an empty dossier through
 * to `plan-generate` — which is precisely what the pipeline did before.
 */
import { describe, it, expect, vi } from 'vitest';

// Imported by URL href — the `kicktodo-0459-pack` / `chain-backed-flagship-e2e`
// precedent. A bare relative specifier makes tsc demand a .d.ts for the .mjs pack.
const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
const mod = (await import(packUrl)) as { claimExtract: (ctx: unknown) => Promise<Record<string, unknown>> };
const claimExtract = mod.claimExtract;

const SOURCE = { hash: 'h1', title: 'Walking study', url: 'https://a.example/walk' };
const PAGE = { url: 'https://a.example/walk', extractedText: 'A 20-minute daily walk improved mood in the cohort.', status: 200 };

/** A ctx with the creator surface + a scripted `callAI`. */
function ctxWith(aiReturns: unknown[], inputs: Record<string, unknown>) {
  const calls: unknown[] = [];
  const callAI = vi.fn(async (req: unknown) => { calls.push(req); return { data: aiReturns[Math.min(calls.length - 1, aiReturns.length - 1)] }; });
  return {
    ctx: {
      inputs,
      callAI,
      features: { 'kicktodo-creator': {
        frameResearch: async () => ({ questions: [] }), // ensureCreator's probe
        claimSchema: async () => ({ schema: { type: 'object' } }),
      } },
    },
    callAI,
    calls,
  };
}

describe('claim-extract — fail-closed guarantees', () => {
  it('NO readable content ⇒ typed refusal, and the model is never called', async () => {
    // Sources with no matching fetched page. Any "claims" here would be the model's
    // parametric memory wearing a citation.
    const { ctx, callAI } = ctxWith([{ claims: [] }], { sources: [SOURCE], pages: [] });
    const out = await claimExtract(ctx);
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('no_readable_sources');
    expect(callAI, 'must not spend a model call when there is nothing to read').not.toHaveBeenCalled();
  });

  it('readable content but ZERO supported claims ⇒ typed refusal, not an empty pass', async () => {
    const { ctx } = ctxWith([{ claims: [] }], { sources: [SOURCE], pages: [PAGE] });
    const out = await claimExtract(ctx);
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('no_supported_claims');
  });

  it('a claim citing an UNKNOWN hash is repaired once, then fails typed', async () => {
    // The model inventing a hash is the fabrication mode that matters. Repair names
    // the actual defect; a second failure refuses rather than recording it.
    const bogus = { claims: [{ claimId: 'c-1', text: 'x', sourceHashes: ['NOT-A-REAL-HASH'] }] };
    const { ctx, calls } = ctxWith([bogus, bogus], { sources: [SOURCE], pages: [PAGE] });
    const out = await claimExtract(ctx);
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('claims_invalid');
    expect(calls.length, 'exactly one bounded repair').toBe(2);
    // The repair must name the real defect and restate the legal hashes.
    const repair = JSON.stringify(calls[1]);
    expect(repair).toContain('NOT-A-REAL-HASH');
    expect(repair).toContain('h1');
  });

  it('a valid extraction succeeds and reports what it read', async () => {
    const good = { claims: [{ claimId: 'c-1', text: 'A 20-minute walk improved mood.', sourceHashes: ['h1'] }] };
    const { ctx, calls } = ctxWith([good], { sources: [SOURCE], pages: [PAGE], questions: ['does walking help mood?'] });
    const out = await claimExtract(ctx);
    expect(out.status).toBe('success');
    expect((out.outputs as { claimCount: number }).claimCount).toBe(1);
    expect((out.outputs as { sourcesRead: number }).sourcesRead).toBe(1);
    expect(calls.length, 'no repair needed').toBe(1);
  });

  it('the prompt carries the source HASH and CONTENT, and the research questions', async () => {
    const good = { claims: [{ claimId: 'c-1', text: 't', sourceHashes: ['h1'] }] };
    const { ctx, calls } = ctxWith([good], { sources: [SOURCE], pages: [PAGE], questions: ['does walking help mood?'] });
    await claimExtract(ctx);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain('h1');                       // cite-by-hash is only possible if the hash is shown
    expect(sent).toContain('improved mood in the cohort'); // the CONTENT, not just the title
    expect(sent).toContain('does walking help mood?');
    // Determinism: extraction is evidence, not creativity.
    expect((calls[0] as { temperature: number }).temperature).toBe(0);
  });

  it('a source with no fetched page is EXCLUDED from what the model may cite', async () => {
    // Two sources, one page. The unreadable source must not be offered as citable,
    // or the model could "support" a claim from a page nobody read.
    const other = { hash: 'h2', title: 'Unread', url: 'https://b.example/none' };
    const good = { claims: [{ claimId: 'c-1', text: 't', sourceHashes: ['h1'] }] };
    const { ctx, calls } = ctxWith([good], { sources: [SOURCE, other], pages: [PAGE] });
    const out = await claimExtract(ctx);
    expect(out.status).toBe('success');
    expect((out.outputs as { sourcesRead: number }).sourcesRead).toBe(1);
    expect(JSON.stringify(calls[0])).not.toContain('h2');
  });

  it('no ctx.callAI ⇒ typed capability error, never a silent empty', async () => {
    const out = await claimExtract({
      inputs: { sources: [SOURCE], pages: [PAGE] },
      features: { 'kicktodo-creator': { frameResearch: async () => ({ questions: [] }) } },
    });
    expect(out.status).toBe('failed');
    expect((out.error as { code: string }).code).toBe('capability_missing');
  });
});
