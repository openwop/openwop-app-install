/**
 * The evidence brief every factory text step is grounded on (KTF-EV-2 /
 * XCH-LB-5 / KTF-EV-3), from the dossier SSoT to the prompt text the node renders.
 *
 *  - EV-2: the 60-claim cap keeps SUPPORTED claims first, so it can never push
 *    a citable claim out for one nobody may cite. Sabotage: dropping the
 *    supported-first ordering loses `s-61`'s citability below.
 *  - LB-5: every cut is disclosed — omitted claims, shortened text, unlisted
 *    sources. Sabotage: removing `omittedClaims` reds the count.
 *  - EV-3: the prompt offers only supported ids as citable and lists the
 *    unsupported ones apart as a warning.
 */
import { describe, expect, it } from 'vitest';
import { evidenceBrief, supportedClaimIds, EVIDENCE_BRIEF_LIMITS, type ResearchDossier } from '../src/features/kicktodo-creator/creatorService.js';

const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;
type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string; message?: string } }>;
const nodes = ((await import(packUrl)) as { nodes: Record<string, NodeFn> }).nodes;

const src = (n: number) => ({ url: `https://s${n}.example/`, domain: `s${n}.example`, title: `Source ${n}`, hash: `h${n}`, engine: 'brave' });

function dossier(claims: ResearchDossier['claims'], unsupportedClaimIds: string[], sources = [src(1), src(2), src(3), src(4), src(5)]): ResearchDossier {
  return { questions: [], sources, claims, unsupportedClaimIds, engines: ['brave'], recordedAt: '2026-10-17T00:00:00.000Z' };
}

describe('evidenceBrief (KTF-EV-2 / XCH-LB-5)', () => {
  it('supported claims come first, so the cap never drops a citable claim for an uncitable one', () => {
    const max = EVIDENCE_BRIEF_LIMITS.maxClaims;
    // 61 UNSUPPORTED claims recorded first, then one supported claim.
    const bad = Array.from({ length: max + 1 }, (_, n) => ({ claimId: `u-${n}`, text: 'weak', sourceHashes: ['h1'] }));
    const good = { claimId: 's-61', text: 'strong', sourceHashes: ['h2'] };
    const d = dossier([...bad, good], bad.map((c) => c.claimId));
    const brief = evidenceBrief(d);
    expect(brief.claims).toHaveLength(max);
    expect(brief.claims[0]).toMatchObject({ claimId: 's-61', supported: true });
    expect(brief.omittedClaims).toBe(2);
    expect(supportedClaimIds(d)).toEqual(['s-61']);
  });

  it('discloses shortened text and unlisted sources per claim; a whole claim carries neither field', () => {
    const long = 'x'.repeat(EVIDENCE_BRIEF_LIMITS.maxTextChars + 25);
    const d = dossier([
      { claimId: 'c-long', text: long, sourceHashes: ['h1', 'h2', 'h3', 'h4', 'h5'] },
      { claimId: 'c-short', text: 'short', sourceHashes: ['h1'] },
    ], []);
    const [a, b] = evidenceBrief(d).claims;
    expect(a).toMatchObject({ claimId: 'c-long', textOmittedChars: 25, sourcesOmitted: 2 });
    expect(a!.sources).toHaveLength(EVIDENCE_BRIEF_LIMITS.maxSourcesPerClaim);
    expect(b).not.toHaveProperty('textOmittedChars');
    expect(b).not.toHaveProperty('sourcesOmitted');
  });
});

describe('the rendered EVIDENCE block (KTF-EV-3 / XCH-LB-5 / KTF-PG-2)', () => {
  const PLAN_SURFACE = {
    frameResearch: async () => ({}),
    planSchema: async () => ({ schema: { type: 'object' } }),
    validatePlan: async () => ({ defects: [] }),
  };
  const claims = [
    { claimId: 'ok-1', text: 'Backed.', supported: true, sources: [{ title: 'S', url: 'https://s.example/', domain: 's.example' }], sourcesOmitted: 2, textOmittedChars: 9 },
    { claimId: 'bad-1', text: 'Not backed.', supported: false, sources: [] },
  ];

  async function promptFor(inputs: Record<string, unknown>, surface: Record<string, unknown> = PLAN_SURFACE): Promise<string> {
    let prompt = '';
    await nodes['feature.kicktodo.nodes.plan-generate']!({
      inputs: { topic: 'sleep', ...inputs },
      features: { 'kicktodo-creator': surface },
      callAI: async (req: { messages: Array<{ content: string }> }) => { prompt = req.messages[0]!.content; return { data: {} }; },
    });
    return prompt;
  }

  it('offers only supported ids as citable and lists unsupported ones apart, as a warning', async () => {
    const p = await promptFor({ evidenceClaims: claims });
    const citable = p.slice(p.indexOf('EVIDENCE (cite by claimId; ONLY these ids are valid)'), p.indexOf('UNSUPPORTED'));
    expect(citable).toContain('[ok-1]');
    expect(citable).not.toContain('[bad-1]');
    expect(p.slice(p.indexOf('UNSUPPORTED'))).toContain('[bad-1]');
  });

  it('discloses every cut: shortened text, unlisted sources, and claims the cap left out', async () => {
    const p = await promptFor({ candidateId: 'cand-1' }, { ...PLAN_SURFACE, evidenceClaims: async () => ({ claims, omittedClaims: 7 }) });
    expect(p).toContain('9 characters not shown');
    expect(p).toContain('+2 more source(s) not listed');
    expect(p).toContain('7 further recorded claim(s) were left out');
  });

  it('labels the prose summary as an overview that is not citable', async () => {
    const p = await promptFor({ evidenceSummary: 'Walking helps.' });
    expect(p).toContain('RESEARCH OVERVIEW (prose; NOT citable — cite only EVIDENCE ids):\nWalking helps.');
    expect(p).not.toContain('EVIDENCE SUMMARY');
  });
});

// XCH-CE-3 — a dispatcher throw becomes a typed node failure carrying the
// provider's own code, in every factory LLM node. Sabotage: calling ctx.callAI
// directly again lets the throw escape and reds `resolves`.
describe('typed AI-call failures (XCH-CE-3)', () => {
  const boom = async () => { throw Object.assign(new Error('model returned an invalid envelope 3 times'), { code: 'envelope_invalid' }); };
  const creator = {
    frameResearch: async () => ({}),
    planSchema: async () => ({ schema: { type: 'object' } }),
    validatePlan: async () => ({ defects: [] }),
    lessonSchema: async () => ({ schema: { type: 'object' } }),
    claimSchema: async () => ({ schema: { type: 'object' } }),
    verdictSchema: async () => ({ schema: { type: 'object' } }),
  };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['plan-generate', { topic: 'sleep' }],
    ['lesson-batch-build', { candidateId: 'c1', days: [{ day: 1, title: 't' }] }],
    ['claim-extract', { sources: [{ hash: 'h1', title: 'S', url: 'https://s.example/' }], pages: [{ url: 'https://s.example/', extractedText: 'Some readable source text about sleep and light.', status: 200 }] }],
    ['claim-verify', { claims: [{ claimId: 'c', text: 't', sourceHashes: ['h1'] }], sources: [{ hash: 'h1', title: 'S', url: 'https://s.example/' }], pages: [{ url: 'https://s.example/', extractedText: 'text', status: 200 }] }],
  ];
  for (const [id, inputs] of cases) {
    it(`${id}: a callAI throw is a typed failure with the provider's code`, async () => {
      const out = await nodes[`feature.kicktodo.nodes.${id}`]!({ inputs, config: {}, features: { 'kicktodo-creator': creator }, callAI: boom });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('envelope_invalid');
      expect(out.error?.message).toContain('invalid envelope');
    });
  }
});
