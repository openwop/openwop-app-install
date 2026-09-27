/**
 * ADR 0305 Phase F — screen templates + the design chain.
 * 1. Every template tree validates CLOSED-WORLD against the live catalog — a
 *    catalog change can never orphan a template silently.
 * 2. The `app-builder.design` builtin is REAL (chatCompletion, not mock-ai),
 *    wires content→source into the render node, and per-screen reviews.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { validateComponentTree } from '../../../host/canvasComponentCatalog.js';
import { registerAppBuilderComponents, APP_BUILDER_CANVAS_TYPE, APP_BUILDER_COMPONENTS } from '../componentCatalog.js';
import { SCREEN_TEMPLATES } from '../screenTemplates.js';
import {
  buildDesignWorkflowDefinition,
  buildPlanToKanbanWorkflowDefinition,
  APP_BUILDER_DESIGN_WORKFLOW_ID,
  APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID,
} from '../designWorkflow.js';

registerAppBuilderComponents();

describe('screen templates (closed-world pinned)', () => {
  it('ships 11 templates with unique ids and non-empty trees', () => {
    expect(SCREEN_TEMPLATES.length).toBe(11); // +report (audit gap #5)
    expect(new Set(SCREEN_TEMPLATES.map((t) => t.id)).size).toBe(11);
    for (const t of SCREEN_TEMPLATES) expect(t.components.length).toBeGreaterThan(0);
  });
  for (const t of SCREEN_TEMPLATES) {
    it(`template '${t.id}' validates against the component catalog`, () => {
      expect(validateComponentTree(APP_BUILDER_CANVAS_TYPE, t.components)).toEqual([]);
    });
  }
});

describe('app-builder.design — expanded from the feature.app-builder.workflows chain pack (ADR 0346 4a)', () => {
  // Expansion prefixes node ids (`app-builder_design_<hash>_prd`); resolve by suffix.
  const d = buildDesignWorkflowDefinition();
  const node = (id: string) => d.nodes.find((n) => n.nodeId.endsWith(`_${id}`));
  const edge = (from: string, to: string) => (d.edges ?? []).find((e) => e.sourceNodeId.endsWith(`_${from}`) && e.targetNodeId.endsWith(`_${to}`));

  it('is a real-AI PRD → research → plan → render → deepen → audit → review pipeline (ADR 0325)', () => {
    expect(d.workflowId).toBe(APP_BUILDER_DESIGN_WORKFLOW_ID);
    const types = d.nodes.map((n) => n.typeId);
    expect(types).toEqual([
      'core.ai.chatCompletion',
      'core.clarificationGate',
      'core.ai.chatCompletion',
      'feature.app-builder.nodes.research',
      'core.ai.chatCompletion',
      'feature.app-builder.nodes.render',
      'feature.app-builder.nodes.deepen',
      'feature.app-builder.nodes.audit',
      'core.approvalGate',
      // ADR 0346 4d — the typed app.audit record (a capture off audit.report).
      'feature.app-builder.nodes.capture',
    ]);
    expect(types).not.toContain('local.sample.demo.mock-ai'); // the ADR 0190 honesty rule
    // The plan's raw JSON lands on the render node's source port.
    const planRender = edge('plan', 'render');
    expect(planRender?.sourceOutput).toBe('content');
    expect(planRender?.targetInput).toBe('source');
    // Grade F6 — itemsFrom has NO runtime consumer; deliberately absent.
    expect((node('review')?.config as { itemsFrom?: string }).itemsFrom).toBeUndefined();
    // ADR 0346 4a — the RFC 0124 deferred param materializes and is RENAMED to
    // the launch-contract variable `idea`, wired into prd + research.
    expect(d.variables?.map((v) => v.name)).toEqual(['idea']);
    expect(d.variables?.[0]?.required).toBe(true);
    for (const id of ['prd', 'research']) {
      const pv = node(id)?.inputs?.idea as { type?: string; variableName?: string };
      expect(pv).toEqual({ type: 'variable', variableName: 'idea' });
    }
    // ADR 0325 correction — audit is the ONE primary (expansion marks the
    // TERMINAL node; the adapter re-stamps), and the gate edge carries the
    // WHOLE outputs map (no sourceOutput).
    const primaries = d.nodes.filter((n) => n.outputRole === 'primary').map((n) => n.typeId);
    expect(primaries).toEqual(['feature.app-builder.nodes.audit']);
    expect(edge('audit', 'review')?.sourceOutput).toBeUndefined();
    // ADR 0346 4b — model policy resolved + stamped; the portable modelClass
    // never reaches the executor (callAI contract is explicit provider/model).
    for (const id of ['prd', 'research', 'plan', 'deepen']) {
      const cfg = node(id)?.config as { provider?: string; model?: string; modelClass?: string };
      expect(cfg.provider, id).toBeTruthy();
      expect(cfg.model, id).toBeTruthy();
      expect(cfg.modelClass, id).toBeUndefined();
    }
    // Grade F6 — a soft-failed deepen becomes an audit finding via this edge.
    expect((d.edges ?? []).some((e) => e.sourceNodeId.endsWith('_deepen') && e.sourceOutput === 'warning' && e.targetInput === 'upstreamWarning')).toBe(true);
    // Research grounds the plan as its SOLE input.
    const rp = edge('research', 'plan');
    expect(rp?.sourceOutput).toBe('planContext');
    expect(rp?.targetInput).toBe('input');
    expect(edge('prd', 'plan')).toBeUndefined();
    expect(((node('plan')?.config as { systemPrompt?: string }).systemPrompt ?? '')).toContain('RESEARCH');
    expect(d.metadata).toMatchObject({ kind: 'app-builder-design', feature: 'app-builder' });
  });

  it('registration is deterministic (same expansion on every boot)', () => {
    const again = buildDesignWorkflowDefinition();
    expect(again.nodes.map((n) => n.nodeId)).toEqual(d.nodes.map((n) => n.nodeId));
  });

  // ADR 0323 Phase 4 — the plan prompt must drive graph LAYOUT + realistic content.
  it('the plan prompt instructs screen positions, connectors, and realistic content', () => {
    const prompt = ((node('plan')?.config as { systemPrompt?: string }).systemPrompt ?? '').toLowerCase();
    expect(prompt).toContain('"x"');
    expect(prompt).toContain('"y"');
    expect(prompt).toContain('transition');
    expect(prompt).toContain('trigger');
    expect(prompt).toContain('lorem'); // the "NEVER Lorem ipsum" instruction
    expect(prompt).toContain('under ~4000');
  });

  // ADR 0358 Phase A — the plan prompt's hand-carried type list drifted once
  // (`form` was missing after ADR 0347 5b). Pin the REGISTERED prompt against
  // the host catalog EXACTLY (both directions), the CATALOG_TYPES precedent.
  const typeSetOfPrompt = (prompt: string): Set<string> => {
    const marker = 'Use ONLY these component types:';
    expect(prompt).toContain(marker); // fails loudly if the prompt is refactored
    const tail = prompt.slice(prompt.indexOf(marker) + marker.length);
    return new Set(tail.replace(/\([^)]*\)/g, '').replace(/\.\s*$/, '').split(',').map((t) => t.trim()).filter(Boolean));
  };

  it('the plan prompt type list matches the host catalog EXACTLY (drift tripwire)', () => {
    const prompt = (node('plan')?.config as { systemPrompt?: string }).systemPrompt ?? '';
    const hostSet = new Set(APP_BUILDER_COMPONENTS.map((c) => c.type));
    expect([...typeSetOfPrompt(prompt)].sort()).toEqual([...hostSet].sort());
  });

  // ADR 0358 Phase C — registration-time substitution (Phase B) makes the
  // REGISTERED prompt drift-proof on THIS host, which also means it would MASK
  // drift in the pack's raw portable copy — the artifact other hosts install.
  // Pin the raw copy separately so the shipped pack stays honest everywhere.
  it('the RAW chain-pack plan prompt (the portable copy) also matches the catalog', () => {
    const packPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../examples/workflow-chain-packs/app-builder/pack.json');
    const raw = JSON.parse(readFileSync(packPath, 'utf8')) as { chains: { dag: { nodes: { config?: { systemPrompt?: string } }[] } }[] };
    const prompt = raw.chains.flatMap((c) => c.dag.nodes).map((n) => n.config?.systemPrompt ?? '').find((p) => p.includes('Use ONLY these component types:')) ?? '';
    const hostSet = new Set(APP_BUILDER_COMPONENTS.map((c) => c.type));
    expect([...typeSetOfPrompt(prompt)].sort()).toEqual([...hostSet].sort());
  });
});

describe('app-builder.plan-to-kanban — editable core-work composition', () => {
  const d = buildPlanToKanbanWorkflowDefinition();
  const node = (id: string) => d.nodes.find((n) => n.nodeId.endsWith(`_${id}`));
  const edge = (from: string, to: string) => (d.edges ?? []).find((e) => e.sourceNodeId.endsWith(`_${from}`) && e.targetNodeId.endsWith(`_${to}`));

  it('uses a narrow App Builder proposal adapter and the reusable core materializer behind a review gate', () => {
    expect(d.workflowId).toBe(APP_BUILDER_PLAN_TO_KANBAN_WORKFLOW_ID);
    expect(d.nodes.map((n) => n.typeId)).toEqual([
      'feature.app-builder.nodes.propose-kanban-work',
      'core.approvalGate',
      'core.openwop.kanban.work-items.materialize',
    ]);
    expect(node('materialize')?.config).toMatchObject({ requireApproval: true });
    expect(edge('propose', 'review')?.targetInput).toBe('input');
    expect(edge('propose', 'materialize')?.sourceOutput).toBe('proposal');
    expect(edge('review', 'materialize')?.sourceOutput).toBeUndefined();
    expect(d.variables?.map((v) => v.name)).toEqual(['canvasId', 'boardId', 'columnId', 'workflowId']);
    expect(d.metadata).toMatchObject({ kind: 'app-builder-plan-to-kanban', feature: 'app-builder' });
  });

  it('turns a stored canvas into a safe generic task proposal without owning a board', async () => {
    const mod = await import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
    const result = await mod.proposeKanbanWork({
      inputs: { canvasId: 'canvas-7', columnId: 'backlog', workflowId: 'workflow-deliver-screen' },
      features: {
        'app-builder': {
          getDesign: async () => ({
            version: 4,
            app: {
              name: 'Workspace Hub',
              screens: [
                { id: 'home', name: 'Home', route: '/' },
                { id: 'detail', name: 'Detail', route: '/detail' },
              ],
              // The forward edge is a dependency; the return edge is ordinary
              // navigation and must not create a cyclic task plan.
              connectors: [{ from: 'home', to: 'detail' }, { from: 'detail', to: 'home' }],
            },
          }),
        },
      },
    });
    expect(result.outputs.proposal).toMatchObject({
      scope: { kind: 'canvas.app-builder', externalRef: 'canvas-7' },
      source: { kind: 'app-builder.design', id: 'canvas-7', revision: '4' },
      items: [
        { key: 'screen.home', columnId: 'backlog', workflowId: 'workflow-deliver-screen' },
        { key: 'screen.detail', dependsOnKeys: ['screen.home'] },
      ],
    });
    expect(result.outputs.skippedBackReferences).toBe(1);
  });
});

// ── Grade pass (data-F1/F6/F8): the render node must PERSIST the ADR 0323
// layout, slug-normalize ids (a space id previously seeded an uneditable
// canvas), and agree with the editor's duplicate-edge rule. ──
describe('render node — layout pass-through + id normalization', () => {
  async function renderApp(app: Record<string, unknown>): Promise<Record<string, unknown>> {
    const mod = await import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
    const res = await mod.render({ inputs: { app } });
    return res.outputs.artifact.payload;
  }

  it('passes screen x/y and connector transition/routing through (Phase 4 alive end-to-end)', async () => {
    const doc = await renderApp({
      name: 'App',
      screens: [{ id: 'home', name: 'Home', x: 80, y: 80.4 }, { id: 'next', name: 'Next', x: 400, y: 999999999 }],
      connectors: [{ from: 'home', to: 'next', trigger: 'click', transition: 'modal', routingStyle: 'step', animated: true }],
    });
    const screens = doc.screens as { id: string; x?: number; y?: number }[];
    expect(screens[0]).toMatchObject({ x: 80, y: 80 });        // rounded
    expect(screens[1]!.y).toBe(100000);                         // clamped to POS_BOUND
    expect((doc.connectors as Record<string, unknown>[])[0]).toMatchObject({ trigger: 'click', transition: 'modal', routingStyle: 'step', animated: true });
  });

  it('slug-normalizes non-slug ids and remaps connectors + navigateTo', async () => {
    const doc = await renderApp({
      name: 'App',
      screens: [
        { id: 'Home Screen', name: 'Home', components: [{ type: 'button', props: { label: 'Go', navigateTo: 'Détail!' } }] },
        { id: 'Détail!', name: 'Detail' },
      ],
      connectors: [{ from: 'Home Screen', to: 'Détail!' }],
    });
    const screens = doc.screens as { id: string; components?: { props: { navigateTo?: string } }[] }[];
    expect(screens[0]!.id).toBe('home-screen');
    expect(screens[1]!.id).toBe('d-tail');
    expect((doc.connectors as { from: string; to: string }[])[0]).toEqual({ from: 'home-screen', to: 'd-tail' });
    expect(screens[0]!.components![0]!.props.navigateTo).toBe('d-tail');
  });

  it('collapses duplicate (from,to) connectors (the editor rule)', async () => {
    const doc = await renderApp({
      name: 'App',
      screens: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      connectors: [{ from: 'a', to: 'b', trigger: 'click' }, { from: 'a', to: 'b', trigger: 'load' }, { from: 'b', to: 'a' }],
    });
    expect((doc.connectors as unknown[]).length).toBe(2); // a→b (first wins) + b→a
  });
});

// ── ADR 0325 — the AI-depth nodes, unit-tested with a mocked ctx.callAI. ──
describe('ADR 0325 nodes — research / deepen / audit', () => {
  type Pack = typeof import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
  const pack = (): Promise<Pack> => import('../../../../../../packs/feature.app-builder.nodes/index.mjs');
  const aiReturning = (content: string) => async () => ({ content });
  const artifactOf = (payload: Record<string, unknown>) => ({ artifactTypeId: 'canvas.app-builder', payload, title: 'T' });

  it('the pack deepen prompt pins the FULL host catalog (drift tripwire)', async () => {
    const { CATALOG_TYPES } = await pack();
    for (const c of APP_BUILDER_COMPONENTS) expect(CATALOG_TYPES).toContain(c.type);
  });

  it('research returns structured content; soft-fails LOUDLY on AI error or bad JSON', async () => {
    const { research } = await pack();
    const good = await research({ inputs: { idea: 'i', prd: 'p' }, config: {}, callAI: aiReturning('{"personas":[{"name":"A"}],"brand":{},"visualDirection":{}}') });
    expect(JSON.parse(good.outputs.content as string).personas[0].name).toBe('A');
    expect(String(good.outputs.planContext)).toContain('PRD:'); // the plan's sole input carries BOTH
    expect(String(good.outputs.planContext)).toContain('RESEARCH');
    const bad = await research({ inputs: { prd: 'the prd text' }, config: {}, callAI: aiReturning('not json') });
    expect(bad.status).toBe('success'); // never kills the run
    expect(bad.outputs.warning).toContain('research unavailable');
    expect(bad.outputs.planContext).toBe('the prd text'); // grounding degrades, context survives
    const err = await research({ inputs: {}, config: {}, callAI: async () => { throw new Error('boom'); } });
    expect(err.outputs.warning).toBeTruthy();
  });

  it('deepen enriches only THIN screens through the render normalization gate', async () => {
    const { deepen } = await pack();
    const payload = {
      name: 'App', screens: [
        { id: 'thin', name: 'Thin', components: [{ type: 'heading', props: { text: 'x' } }] },
        { id: 'rich', name: 'Rich', components: Array.from({ length: 8 }, () => ({ type: 'text', props: { text: 'y' } })) },
      ],
    };
    const enriched = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ type: 'text', props: { text: `real copy ${i}` } })));
    const calls: unknown[] = [];
    const res = await deepen({ inputs: { artifact: artifactOf(payload) }, config: {}, callAI: async (req: unknown) => { calls.push(req); return { content: enriched }; } });
    expect(calls.length).toBe(1); // only the thin screen
    expect(res.outputs.deepened).toEqual(['thin']);
    const out = (res.outputs.artifact as { payload: { screens: { id: string; components: unknown[] }[] } }).payload;
    expect(out.screens[0]!.components.length).toBe(6);
    expect(out.screens[1]!.components.length).toBe(8); // rich untouched
  });

  it('deepen never mutates the INPUT artifact (edges deliver by reference)', async () => {
    const { deepen } = await pack();
    const payload = { name: 'App', screens: [{ id: 'thin', name: 'Thin', components: [] }] };
    const input = artifactOf(payload);
    const res = await deepen({ inputs: { artifact: input }, config: {}, callAI: aiReturning('[{"type":"text","props":{"text":"real"}}]') });
    expect(payload.screens[0]!.components).toEqual([]); // upstream output untouched
    expect((res.outputs.artifact as { payload: { screens: { components: unknown[] }[] } }).payload.screens[0]!.components.length).toBe(1);
    expect(res.outputs.artifact).not.toBe(input);
  });

  it('deepen keeps the original screen on AI failure and warns when nothing improved', async () => {
    const { deepen } = await pack();
    const payload = { name: 'App', screens: [{ id: 'a', name: 'A', components: [] }] };
    const res = await deepen({ inputs: { artifact: artifactOf(payload) }, config: {}, callAI: async () => { throw new Error('boom'); } });
    expect(res.status).toBe('success');
    expect(res.outputs.warning).toContain('no improvements');
    expect((res.outputs.artifact as { payload: { screens: { components: unknown[] }[] } }).payload.screens[0]!.components).toEqual([]);
  });

  // ── XCH-APPB-4 — responseSchema + the ONE bounded contract repair. ──
  it('research passes its hoisted responseSchema and prefers result.data over content', async () => {
    const { research, RESEARCH_RESPONSE_SCHEMA } = await pack();
    const reqs: { responseSchema?: unknown }[] = [];
    const res = await research({ inputs: { idea: 'i', prd: 'p' }, config: {}, callAI: async (req: { responseSchema?: unknown }) => {
      reqs.push(req);
      return { data: { personas: [{ name: 'FromData' }], brand: {}, visualDirection: {} }, content: '{"personas":[{"name":"FromContent"}]}' };
    } });
    expect(reqs[0]!.responseSchema).toBe(RESEARCH_RESPONSE_SCHEMA);
    expect(JSON.parse(res.outputs.content as string).personas[0].name).toBe('FromData');
  });

  it('research repairs a contract-bad reply ONCE (error-fed, temperature 0) and accepts the fix', async () => {
    const { research } = await pack();
    const reqs: { temperature?: number; messages?: { role: string; content: string }[] }[] = [];
    const replies = [
      { data: { personas: 'not-an-array', brand: {}, visualDirection: {} } },
      { data: { personas: [{ name: 'Repaired' }], brand: {}, visualDirection: {} } },
    ];
    const res = await research({ inputs: { idea: 'i', prd: 'p' }, config: {}, callAI: async (req: Record<string, unknown>) => { reqs.push(req as (typeof reqs)[0]); return replies[reqs.length - 1]!; } });
    expect(reqs.length).toBe(2); // exactly ONE repair
    expect(reqs[1]!.temperature).toBe(0);
    const retryMessages = reqs[1]!.messages ?? [];
    expect(retryMessages.map((m) => m.content).join(' ')).toContain('personas'); // the exact contract error is fed back
    expect(retryMessages.some((m) => m.role === 'assistant')).toBe(true); // honest echo of the bad output
    expect(JSON.parse(res.outputs.content as string).personas[0].name).toBe('Repaired');
  });

  it('research still soft-fails LOUDLY when the single repair also misses the contract', async () => {
    const { research } = await pack();
    let calls = 0;
    const res = await research({ inputs: { prd: 'the prd' }, config: {}, callAI: async () => { calls += 1; return { data: { personas: 42, brand: {}, visualDirection: {} } }; } });
    expect(calls).toBe(2); // first + ONE repair, never more
    expect(res.status).toBe('success');
    expect(res.outputs.warning).toContain('research unavailable');
    expect(res.outputs.planContext).toBe('the prd');
  });

  it('deepen passes its schema and accepts the { components: [...] } object wrap', async () => {
    const { deepen, DEEPEN_RESPONSE_SCHEMA } = await pack();
    const payload = { name: 'App', screens: [{ id: 'thin', name: 'Thin', components: [] }] };
    const reqs: { responseSchema?: unknown }[] = [];
    const res = await deepen({ inputs: { artifact: artifactOf(payload) }, config: {}, callAI: async (req: { responseSchema?: unknown }) => {
      reqs.push(req);
      return { data: { components: Array.from({ length: 6 }, (_, i) => ({ type: 'text', props: { text: `copy ${i}` } })) } };
    } });
    expect(reqs[0]!.responseSchema).toBe(DEEPEN_RESPONSE_SCHEMA);
    expect(res.outputs.deepened).toEqual(['thin']);
    expect((res.outputs.artifact as { payload: { screens: { components: unknown[] }[] } }).payload.screens[0]!.components.length).toBe(6);
  });

  it('audit finds unreachable/empty/dangling/duplicate/contrast and passes the artifact through', async () => {
    const { audit } = await pack();
    const payload = {
      name: 'App',
      themeColors: { primary: '#3466aa', secondary: '#3468ac' }, // near-identical pair
      screens: [
        { id: 'home', name: 'Home', route: '/', isInitial: true, components: [{ type: 'button', props: { label: 'Go', navigateTo: 'ghost' } }] },
        { id: 'orphan', name: 'Orphan', route: '/', components: [] },
      ],
      connectors: [],
    };
    const art = artifactOf(payload);
    const res = audit({ inputs: { artifact: art } });
    expect(res.outputs.artifact).toBe(art); // pass-through identity (the gate binding)
    const report = res.outputs.report as { score: number; findings: { code: string }[] };
    const codes = report.findings.map((f) => f.code).sort();
    expect(codes).toEqual(['dangling_nav', 'duplicate_route', 'empty_screen', 'indistinct_theme', 'unreachable']);
    expect(report.score).toBeLessThan(100);
    expect(String((res.outputs.report as { summary: string }).summary)).toContain('finding');
    // Grade F-CRIT — NO top-level string outputs: the approval gate folds
    // strings into picker options, which suppresses the review card's
    // durable-artifact fetch. The whole map must stay option-free.
    for (const [k2, v2] of Object.entries(res.outputs)) { expect(typeof v2).not.toBe('string'); void k2; }
  });


  it('audit records a soft-failed deepen as a FINDING (loud, not just an output)', async () => {
    const { audit } = await pack();
    const payload = { name: 'App', screens: [{ id: 'home', name: 'H', isInitial: true, components: [{ type: 'text', props: { text: 'x' } }] }] };
    const res = audit({ inputs: { artifact: artifactOf(payload), upstreamWarning: 'deepen made no improvements' } });
    const codes = (res.outputs.report as { findings: { code: string }[] }).findings.map((f) => f.code);
    expect(codes).toContain('deepen_skipped');
  });

  it('deepen REJECTS hostile output through the render gate (depth-25 rejected; unknown keys stripped)', async () => {
    const { deepen } = await pack();
    let deepNest: Record<string, unknown> = { type: 'text', props: {} };
    for (let i = 0; i < 25; i++) deepNest = { type: 'stack', props: {}, children: [deepNest] };
    const payload1 = { name: 'App', screens: [{ id: 'a', name: 'A', components: [] }] };
    const res1 = await deepen({ inputs: { artifact: artifactOf(payload1) }, config: {}, callAI: aiReturning(JSON.stringify([deepNest])) });
    expect((res1.outputs.artifact as { payload: { screens: { components: unknown[] }[] } }).payload.screens[0]!.components).toEqual([]); // original kept
    const payload2 = { name: 'App', screens: [{ id: 'a', name: 'A', components: [] }] };
    const res2 = await deepen({ inputs: { artifact: artifactOf(payload2) }, config: {}, callAI: aiReturning('[{"type":"text","props":{"text":"ok"},"evil":"x","onClick":"hack()"}]') });
    const comp = (res2.outputs.artifact as { payload: { screens: { components: Record<string, unknown>[] }[] } }).payload.screens[0]!.components[0]!;
    expect(Object.keys(comp).sort()).toEqual(['props', 'type']);
  });

  it('deepen maxScreens is clamped 0..4 (a negative sentinel disables, never unbounds)', async () => {
    const { deepen } = await pack();
    const payload = { name: 'App', screens: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, components: [] })) };
    const calls: unknown[] = [];
    await deepen({ inputs: { artifact: artifactOf(payload) }, config: { maxScreens: -1 }, callAI: async (r: unknown) => { calls.push(r); return { content: '[]' }; } });
    expect(calls.length).toBe(0);
    // Live-caught: an EXPLICIT 0 must disable too (`|| 4` silently re-enabled it).
    await deepen({ inputs: { artifact: artifactOf(payload) }, config: { maxScreens: 0 }, callAI: async (r: unknown) => { calls.push(r); return { content: '[]' }; } });
    expect(calls.length).toBe(0);
  });

  it('render passes themeColors + dataSources THROUGH (the stripped-field seam class)', async () => {
    const { render } = await pack();
    const res = await render({ inputs: { app: {
      name: 'App',
      themeColors: { primary: '#1d4ed8', secondary: 'nonsense' },
      dataSources: [{ id: 'Products!', name: 'Products', fields: ['title'], rows: [{ title: 'X' }] }],
      screens: [{ id: 'home', name: 'H' }],
    } } });
    const payload = res.outputs.artifact.payload as Record<string, unknown>;
    expect(payload.themeColors).toEqual({ primary: '#1d4ed8' }); // invalid hex dropped
    expect((payload.dataSources as { id: string }[])[0]!.id).toBe('products');
  });

  it('the CATALOG_TYPES list matches the host catalog EXACTLY (both directions)', async () => {
    const { CATALOG_TYPES } = await pack();
    const packSet = new Set(CATALOG_TYPES.split(',').map((t) => t.trim()));
    const hostSet = new Set(APP_BUILDER_COMPONENTS.map((c) => c.type));
    expect([...packSet].sort()).toEqual([...hostSet].sort());
  });

  // ADR 0358 Phase C — nodes prefer the LIVE SSoT list over the pinned mirror.
  it('deepen uses the live surface catalog list when the host offers it', async () => {
    const { deepen } = await pack();
    const prompts: string[] = [];
    const callAI = async (req: Record<string, unknown>) => { prompts.push(String(req.systemPrompt)); return { content: '[]' }; };
    const artifact = artifactOf({ name: 'A', screens: [{ id: 's1', name: 'S1', components: [] }] });
    await deepen({
      inputs: { artifact }, config: {}, callAI,
      features: { 'app-builder': { getCatalog: async () => ({ promptTypeList: 'alpha, beta (children: alpha only)' }) } },
    });
    expect(prompts[0]).toContain('alpha, beta (children: alpha only)');
  });

  it('deepen falls back to the pinned CATALOG_TYPES without the surface op (portability)', async () => {
    const { deepen, CATALOG_TYPES } = await pack();
    const prompts: string[] = [];
    const callAI = async (req: Record<string, unknown>) => { prompts.push(String(req.systemPrompt)); return { content: '[]' }; };
    const artifact = artifactOf({ name: 'A', screens: [{ id: 's1', name: 'S1', components: [] }] });
    await deepen({ inputs: { artifact }, config: {}, callAI });
    expect(prompts[0]).toContain(CATALOG_TYPES);
  });

  it('audit gives a clean design a clean bill', async () => {
    const { audit } = await pack();
    const payload = {
      name: 'App', themeColors: { primary: '#1d4ed8' },
      screens: [
        { id: 'home', name: 'Home', route: '/', isInitial: true, components: [{ type: 'text', props: { text: 'hi' } }] },
        { id: 'next', name: 'Next', route: '/next', components: [{ type: 'text', props: { text: 'yo' } }] },
      ],
      connectors: [{ from: 'home', to: 'next' }],
    };
    const res = audit({ inputs: { artifact: artifactOf(payload) } });
    expect((res.outputs.report as { findings: unknown[] }).findings).toEqual([]);
    expect((res.outputs.report as { score: number }).score).toBe(100);
  });
});
