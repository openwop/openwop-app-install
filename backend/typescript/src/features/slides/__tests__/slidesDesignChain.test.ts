/**
 * ADR 0328 Phase 6 — the slides.design chain + its pack nodes.
 * 1. Chain shape: outline-first with the HITL outline gate, provider stamps on
 *    every AI node, single primary role, no string ports into either gate,
 *    graph validation (the toposort live-caught regression class).
 * 2. Pack nodes (the .mjs): outline skeleton artifact, draft closed-world
 *    normalization, deepen re-normalization + soft-fail-loud, notes
 *    application, deterministic audit findings, restyle content preservation,
 *    and the block-vocabulary drift tripwire against the host catalog.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buildSlidesDesignDefinition, SLIDES_DESIGN_WORKFLOW_ID } from '../designWorkflow.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../../../host/workflowChainPackLoader.js';

// ADR 0472 P4 — slides.design migrated to a chain pack; build the MIGRATED def.
_resetChainRegistryForTest();
loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
const slidesDesignWorkflowDefinition = buildSlidesDesignDefinition();
import { SLIDE_BLOCKS } from '../blockCatalog.js';
import { topologicalOrder, buildGraph } from '../../../executor/scheduler.js';

const require2 = createRequire(import.meta.url);
const packPath = require2.resolve('../../../../../../packs/feature.slides.nodes/index.mjs');

type PackModule = {
  nodes: Record<string, (ctx: unknown) => Promise<{ status: string; outputs: Record<string, unknown> }> | { status: string; outputs: Record<string, unknown> }>;
  BLOCK_TYPES: string;
};

async function pack(): Promise<PackModule> {
  return (await import(packPath)) as unknown as PackModule;
}

type Ctx = { inputs?: Record<string, unknown>; config?: Record<string, unknown>; callAI?: (req: { systemPrompt?: string; messages: { content: string }[] }) => Promise<{ content: string }> };
const ai = (fn: (req: { systemPrompt?: string; messages: { content: string }[] }) => unknown) =>
  async (req: { systemPrompt?: string; messages: { content: string }[] }): Promise<{ content: string }> => ({ content: JSON.stringify(fn(req)) });

describe('slides.design chain shape (ADR 0328 P6)', () => {
  const d = slidesDesignWorkflowDefinition;

  it('is outline-first: outline → HITL gate → draft → deepen → notes → audit → review', () => {
    expect(d.workflowId).toBe(SLIDES_DESIGN_WORKFLOW_ID);
    expect(d.nodes.map((n) => n.typeId)).toEqual([
      'feature.slides.nodes.outline',
      'core.approvalGate',
      'feature.slides.nodes.draft',
      'feature.slides.nodes.deepen',
      'feature.slides.nodes.notes',
      'feature.slides.nodes.audit',
      'core.approvalGate',
    ]);
    expect(d.variables?.find((v) => v.name === 'brief')?.required).toBe(true);
  });

  // ADR 0472 P4 — the def is now expanded from the chain, so ids/edgeIds carry the
  // collision-free `slides_design_<expansionId>_` prefix; assert against the bare ids.
  const bare = (id: string): string => id.replace(/^slides_design_[0-9a-f]+_/, '');

  it('every AI node stamps provider/model (no host default for callAI — the ADR 0325 blocker)', () => {
    for (const nodeId of ['outline', 'draft', 'deepen', 'notes']) {
      const n = d.nodes.find((x) => bare(x.nodeId) === nodeId);
      const cfg = (n?.config ?? {}) as { provider?: string; model?: string };
      expect(cfg.provider, nodeId).toBeTruthy();
      expect(cfg.model, nodeId).toBeTruthy();
    }
  });

  it('audit is the single primary deliverable; both gates bind the WHOLE outputs map', () => {
    expect(d.nodes.filter((n) => n.outputRole === 'primary').map((n) => bare(n.nodeId))).toEqual(['audit']);
    // the two whole-map binding edges (outline→outlineGate, audit→review) carry no sourceOutput.
    for (const [from, to] of [['outline', 'outlineGate'], ['audit', 'review']] as const) {
      const e = (d.edges ?? []).find((x) => bare(x.sourceNodeId) === from && bare(x.targetNodeId) === to);
      expect(e?.sourceOutput, `${from}→${to}`).toBeUndefined(); // default port = whole map
    }
  });

  it('enhancer warnings ride their own edges into the audit (loud, not silent)', () => {
    const warn = (d.edges ?? []).filter((e) => e.sourceOutput === 'warning' && bare(e.targetNodeId) === 'audit');
    expect(warn.map((e) => e.targetInput).sort()).toEqual(['deepenWarning', 'notesWarning']);
  });

  it('passes graph validation with the mid-chain gate (the toposort regression class)', () => {
    const order = topologicalOrder(d, buildGraph(d));
    expect(order.map(bare)).toEqual(['outline', 'outlineGate', 'draft', 'deepen', 'notes', 'audit', 'review']);
  });
});

describe('the pack block vocabulary (drift tripwire)', () => {
  it('BLOCK_TYPES mirrors the host blockCatalog exactly', async () => {
    const m = await pack();
    expect(m.BLOCK_TYPES.split(', ').sort()).toEqual(SLIDE_BLOCKS.map((b) => b.type).sort());
  });
});

describe('outline node', () => {
  it('emits a skeleton-deck artifact (section slides, intent in notes) + the outline object, NO top-level strings', async () => {
    const m = await pack();
    const ctx: Ctx = {
      inputs: { brief: 'Pitch our Q3 platform expansion to the board' },
      config: { provider: 'p', model: 'm' },
      callAI: ai(() => ({ title: 'Q3 Expansion', audience: 'Board', slides: [
        { name: 'The opportunity', intent: 'Frame the market gap', keyPoints: ['TAM up 40%', 'Two rivals stalled'] },
        { name: 'The ask', intent: 'Request budget', keyPoints: ['$2M', '3 hires'] },
      ] })),
    };
    const res = await m.nodes['feature.slides.nodes.outline']!(ctx);
    const out = res.outputs as { artifact: { artifactTypeId: string; payload: { slides: { layout: string; title?: string; notes?: string }[] } }; outline: { slides: unknown[] } };
    expect(out.artifact.artifactTypeId).toBe('canvas.slides');
    expect(out.artifact.payload.slides.map((s) => s.layout)).toEqual(['section', 'section']);
    expect(out.artifact.payload.slides[0]?.title).toBe('The opportunity');
    expect(out.artifact.payload.slides[0]?.notes).toContain('TAM up 40%');
    expect(out.outline.slides).toHaveLength(2);
    for (const [k, v] of Object.entries(res.outputs)) expect(typeof v, `top-level string port '${k}' would become a junk gate option`).not.toBe('string');
  });

  it('hard-fails on AI failure (the paid checkpoint)', async () => {
    const m = await pack();
    const ctx: Ctx = { inputs: { brief: 'x' }, config: {}, callAI: async () => ({ content: 'not json' }) };
    await expect(m.nodes['feature.slides.nodes.outline']!(ctx)).rejects.toThrow(/outline generation failed/);
  });
});

describe('draft node', () => {
  it('expands the outline into a blocks deck, dropping unknown block types (closed world)', async () => {
    const m = await pack();
    const ctx: Ctx = {
      inputs: { outline: { title: 'T', slides: [{ name: 'A', intent: 'i', keyPoints: [] }] } },
      config: {},
      callAI: ai(() => ({ title: 'T', theme: 'dark', slides: [
        { layout: 'blocks', variant: 'hero', notes: 'say this', blocks: [
          { type: 'heading', props: { text: 'A' } },
          { type: 'hologram', props: { text: 'nope' } },
          { type: 'statCard', props: { label: 'NRR', value: '118%' } },
        ] },
      ] })),
    };
    const res = await m.nodes['feature.slides.nodes.draft']!(ctx);
    const payload = (res.outputs as { artifact: { payload: { theme?: string; slides: { layout: string; variant?: string; blocks?: { type: string }[] }[] } } }).artifact.payload;
    expect(payload.theme).toBe('dark');
    expect(payload.slides[0]?.blocks?.map((b) => b.type)).toEqual(['heading', 'statCard']);
    expect(payload.slides[0]?.variant).toBe('hero');
  });
});

describe('deepen node', () => {
  const deck = { title: 'D', slides: [
    { layout: 'blocks', title: 'Thin', variant: 'full', blocks: [{ type: 'heading', props: { text: 'Thin' } }] },
    { layout: 'blocks', title: 'Rich', variant: 'full', blocks: [{ type: 'heading', props: { text: 'R' } }, { type: 'text', props: { text: 'a' } }, { type: 'bullets', props: { items: ['x'] } }] },
  ] };

  it('enriches only the thin slides, re-normalized through the closed-world gate', async () => {
    const m = await pack();
    const calls: string[] = [];
    const ctx: Ctx = {
      inputs: { artifact: { artifactTypeId: 'canvas.slides', payload: deck } },
      config: { maxSlides: 3, minBlocks: 3 },
      callAI: async (req) => {
        calls.push(req.messages[0]!.content);
        return { content: JSON.stringify({ layout: 'blocks', variant: 'full', blocks: [
          { type: 'heading', props: { text: 'Thin' } },
          { type: 'statCard', props: { label: 'ARR', value: '4.2M' } },
          { type: 'hologram', props: {} },
          { type: 'bullets', props: { items: ['a', 'b'] } },
        ] }) };
      },
    };
    const res = await m.nodes['feature.slides.nodes.deepen']!(ctx);
    const out = res.outputs as { artifact: { payload: { slides: { blocks?: { type: string }[] }[] } }; deepened: number; warning?: string };
    expect(calls).toHaveLength(1); // only the thin slide
    expect(out.deepened).toBe(1);
    expect(out.artifact.payload.slides[0]?.blocks?.map((b) => b.type)).toEqual(['heading', 'statCard', 'bullets']); // hologram dropped
    expect(out.artifact.payload.slides[1]?.blocks).toHaveLength(3); // untouched
    expect(out.warning).toBeUndefined();
    // The input was NOT mutated (scheduler delivers by reference).
    expect(deck.slides[0]?.blocks).toHaveLength(1);
  });

  it('soft-fails LOUD: a dead provider keeps the deck and emits a warning', async () => {
    const m = await pack();
    const ctx: Ctx = {
      inputs: { artifact: { artifactTypeId: 'canvas.slides', payload: deck } },
      config: {},
      callAI: async () => { throw Object.assign(new Error('429'), { code: 'rate_limited' }); },
    };
    const res = await m.nodes['feature.slides.nodes.deepen']!(ctx);
    const out = res.outputs as { artifact: unknown; warning?: string; deepened: number };
    expect(out.deepened).toBe(0);
    expect(out.warning).toContain('rate_limited');
    expect(out.artifact).toBeTruthy();
  });
});

describe('notes node', () => {
  it('fills ONLY missing notes and reports the count', async () => {
    const m = await pack();
    const ctx: Ctx = {
      inputs: { artifact: { artifactTypeId: 'canvas.slides', payload: { slides: [
        { layout: 'title', title: 'A', notes: 'existing' },
        { layout: 'section', title: 'B' },
      ] } } },
      config: {},
      callAI: ai(() => ({ notes: { '1': 'Say the section matters.' } })),
    };
    const res = await m.nodes['feature.slides.nodes.notes']!(ctx);
    const out = res.outputs as { artifact: { payload: { slides: { notes?: string }[] } }; notesAdded: number };
    expect(out.notesAdded).toBe(1);
    expect(out.artifact.payload.slides[0]?.notes).toBe('existing');
    expect(out.artifact.payload.slides[1]?.notes).toBe('Say the section matters.');
  });
});

describe('audit node (deterministic, zero AI)', () => {
  it('finds empty slides, duplicate titles, overloads, missing notes, and upstream warnings; no top-level strings', async () => {
    const m = await pack();
    const ctx: Ctx = {
      inputs: {
        artifact: { artifactTypeId: 'canvas.slides', payload: { slides: [
          { layout: 'title', title: 'Same', notes: 'n' },
          { layout: 'section', title: 'Same', notes: 'n' },
          { layout: 'title-bullets', title: 'C', bullets: ['1', '2', '3', '4', '5', '6', '7', '8'] },
          { layout: 'blank' },
        ] } },
        deepenWarning: 'deepen improved nothing (429)',
      },
    };
    const res = await m.nodes['feature.slides.nodes.audit']!(ctx);
    const out = res.outputs as { artifact: unknown; report: { score: number; findings: { code: string }[]; summary: string } };
    const codes = out.report.findings.map((f) => f.code);
    expect(codes).toContain('duplicate_title');
    expect(codes).toContain('bullet_overload');
    expect(codes).toContain('missing_notes');
    expect(codes).toContain('deepen_skipped');
    expect(out.report.score).toBeLessThan(100);
    expect(out.artifact).toBeTruthy(); // pass-through for the gate binding
    for (const [k, v] of Object.entries(res.outputs)) expect(typeof v, `string port '${k}'`).not.toBe('string');
  });
});

describe('restyle node', () => {
  it('applies ONLY style fields — content preserved by construction', async () => {
    const m = await pack();
    const deck = { title: 'Keep me', slides: [
      { layout: 'blocks', title: 'S1', variant: 'full', blocks: [{ type: 'heading', props: { text: 'Original text' } }] },
      { layout: 'title', title: 'S2', subtitle: 'Sub' },
    ] };
    const ctx: Ctx = {
      inputs: { deck, direction: 'bolder' },
      config: {},
      callAI: ai(() => ({ theme: 'vibrant', slides: [
        { variant: 'hero', background: 'accent', transition: 'magic', blocks: [{ type: 'heading', props: { text: 'MODEL TRIED TO REWRITE' } }] },
        { transition: 'fade', title: 'MODEL TRIED TO RETITLE' },
      ] })),
    };
    const res = await m.nodes['feature.slides.nodes.restyle']!(ctx);
    const payload = (res.outputs as { artifact: { payload: { title?: string; theme?: string; slides: Record<string, unknown>[] } } }).artifact.payload;
    expect(payload.theme).toBe('vibrant');
    expect(payload.title).toBe('Keep me');
    expect(payload.slides[0]?.variant).toBe('hero');
    expect(payload.slides[0]?.background).toBe('accent');
    expect(payload.slides[0]?.transition).toBe('magic');
    expect((payload.slides[0]?.blocks as { props: { text: string } }[])[0]?.props.text).toBe('Original text'); // content untouched
    expect(payload.slides[1]?.title).toBe('S2'); // retitle ignored
    expect(payload.slides[1]?.transition).toBe('fade');
  });
});
