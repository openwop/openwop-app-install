/**
 * ADR 1038 P8 — the authored flow: a short process, step by step.
 *
 *   1. The hero `flow` is closed content: up to six nodes, each a label, an
 *      optional text and status word and a closed `state`; junk states drop, a
 *      seventh node is cut, and an unlabelled node is kept so a step being
 *      written survives autosave (renderers show labelled nodes, from two).
 *   2. A `flow` columns section keeps each item's status and state; a base write
 *      with more than six items is refused (typed 400) rather than cut silently.
 *   3. Crawlers and markdown read the steps in order: label, status, text. The
 *      state is presentation and adds nothing.
 *   4. List-item states come from the base, by position, on the raw overlay:
 *      a translated enum ("en attente") is put back, a list of another length
 *      is left alone, a state the base never had is removed.
 *   5. Every save syncs overlay states to the base, and a synced state is not an
 *      author edit (an outdated translation stays outdated).
 *   6. Crawlers and markdown read a hero's flow only while the hero shows it.
 *
 * The lanes are witnessed where they live: the AI translate lane in
 * cms-translate.test.ts, the agent surface lane in cms-chain-execution.test.ts,
 * the AI rewrite lane in adr0828-cms-section-rewrite.test.ts.
 *
 * Sabotage-witnessed (2026-11-03): dropping the six-item refusal reds 2; leaving
 * the status out of the crawler reds 3; removing the restore from
 * validateLocalizations, or comparing overlays with their states, reds 5;
 * emitting the flow whatever the visual reds 6; removing restoreItemStates from
 * the translate, surface or rewrite lane reds that lane's test.
 * Also witnessed (w88 probes): cutting the hero at seven, keeping a junk state,
 * dropping unlabelled nodes' empty label, keeping an empty node list, dropping
 * a columns step's status/state, a seventh step accepted, a crawler cap of
 * seven, plain-text item copy, a dropped figcaption, restoring a list of
 * another length, keeping a state the base never had, mutating the input, and
 * matching by anything but position each red a case.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, stampSourceDigests, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { restoreItemStates } from '../src/features/cms/translate.js';

const nodes = [
  { label: 'Brief', text: 'You say what you need', status: 'Done', state: 'done' },
  { label: 'Draft', status: 'Waiting for you', state: 'waiting' },
  { label: 'Ship', state: 'idle' },
];

describe('hero flow', () => {
  const hero = (flow: unknown) => validateSection({ type: 'hero', data: { heading: 'H', visual: 'flow', flow } }).data;

  it('is closed content with up to six nodes; a step being written survives', () => {
    const d = hero({ label: 'How it works', nodes: [...nodes, { label: '', state: 'done' }, { label: 'x', state: 'paused' }] });
    expect(d.visual).toBe('flow');
    const f = d.flow as { label: string; nodes: Array<Record<string, unknown>> };
    expect(f.label).toBe('How it works');
    // An unlabelled node is kept, so the editor's autosave round trip does not
    // wipe a step the author is still writing (renderers show labelled ones).
    expect(f.nodes.map((n) => n.label)).toEqual(['Brief', 'Draft', 'Ship', '', 'x']);
    expect('state' in f.nodes[4]!).toBe(false);
    const seven = hero({ nodes: Array.from({ length: 7 }, (_, i) => ({ label: `n${i}` })) }).flow as { nodes: unknown[] };
    expect(seven.nodes).toHaveLength(6);
    expect((hero({ nodes: [{ label: '' }, { label: '' }] }).flow as { nodes: unknown[] }).nodes).toHaveLength(2);
    expect('flow' in hero({ nodes: [] })).toBe(false);
  });

  it('reaches crawlers and markdown only while the hero shows it', () => {
    const s = validateSection({ type: 'hero', data: { heading: 'H', visual: 'image', flow: { nodes } } });
    expect(s.data.flow).toBeDefined();
    expect(sectionHtml(s, { assetBase: 'https://app.example.test' })).not.toContain('Brief');
    expect(sectionMarkdown(s, 'https://app.example.test')).not.toContain('Brief');
  });
});

describe('columns flow', () => {
  const cols = nodes.map((n) => ({ title: n.label, text: n.text ?? '', status: n.status, state: n.state }));

  it('keeps each step’s status and state', () => {
    const d = validateSection({ type: 'columns', data: { layout: 'flow', columns: cols } }).data;
    expect((d.columns as Array<Record<string, unknown>>).map((c) => [c.status, c.state])).toEqual([['Done', 'done'], ['Waiting for you', 'waiting'], [undefined, 'idle']]);
  });

  it('refuses a seventh step on the base layer instead of cutting it', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ title: `s${i}`, text: '' }));
    expect(() => validateSection({ type: 'columns', data: { layout: 'flow', columns: many } })).toThrow(/at most 6 steps/);
    expect(() => validateSection({ type: 'columns', data: { layout: 'cards', columns: many } })).not.toThrow();
  });

  it('reaches crawlers and markdown in order: label, status, text', () => {
    const s = validateSection({ type: 'columns', data: { layout: 'flow', heading: 'How it works', columns: cols } });
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toContain('<ol><li><strong>Brief</strong> (Done) — You say what you need</li><li><strong>Draft</strong> (Waiting for you)</li><li><strong>Ship</strong></li></ol>');
    expect(html).not.toMatch(/waiting<|idle/);
    const md = sectionMarkdown(s, 'https://app.example.test')!;
    expect(md).toContain('1. **Brief** (Done) — You say what you need\n2. **Draft** (Waiting for you)\n3. **Ship**');
  });

  it('caps an overlay-sized list at six on the crawler and renders item text as inline markdown', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `s${i}`, text: i === 0 ? 'a **bold** step' : '' }));
    // An overlay is not validated, so the crawler sees seven items unrefused.
    const capped: Section = { sectionId: 's', type: 'columns', data: { layout: 'flow', columns: seven } };
    const html = sectionHtml(capped, { assetBase: 'https://app.example.test' })!;
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect(html).toContain('<strong>s0</strong> — a <strong>bold</strong> step');
  });

  it('the hero flow reaches crawlers as a captioned figure', () => {
    const s = validateSection({ type: 'hero', data: { heading: 'H', visual: 'flow', flow: { label: 'How it works', nodes } } });
    expect(sectionHtml(s, { assetBase: 'https://app.example.test' })).toContain('<figure>\n<figcaption>How it works</figcaption>\n<ol><li><strong>Brief</strong> (Done)');
  });
});

describe('translated item states', () => {
  const base = { heading: 'H', visual: 'flow', flow: { nodes }, activity: { items: [{ action: 'a', state: 'waiting' }] } };
  const states = (o: Record<string, unknown>) => ((o.flow as { nodes: Array<{ state?: string }> }).nodes).map((n) => n.state);

  it('puts each state back from the base where the model translated it away', () => {
    const raw = {
      heading: 'Hola',
      flow: { nodes: [{ label: 'Encargo', state: 'hecho' }, { label: 'Borrador', state: 'en attente' }, { label: 'Enviar' }] },
      activity: { items: [{ action: 'b', state: 'esperando' }] },
    };
    const out = sanitizeSectionOverlay('hero', restoreItemStates(base, raw));
    expect(states(out)).toEqual(['done', 'waiting', 'idle']);
    expect((out.activity as { items: Array<{ state?: string }> }).items[0]!.state).toBe('waiting');
    expect(raw.flow.nodes[0]!.state, 'the input is not mutated').toBe('hecho');
  });

  it('matches by position on the raw overlay, an unlabelled item included', () => {
    const raw = { columns: [{ title: '', text: '', state: 'done' }, { title: 'B', text: '' }, { title: 'C', text: '' }] };
    const colBase = { layout: 'flow', columns: [{ title: 'A', text: '', state: 'done' }, { title: 'B', text: '', state: 'waiting' }, { title: 'C', text: '', state: 'idle' }] };
    const out = sanitizeSectionOverlay('columns', restoreItemStates(colBase, raw));
    expect((out.columns as Array<{ state?: string }>).map((c) => c.state)).toEqual(['done', 'waiting', 'idle']);
  });

  it('leaves a list of a different length alone, and drops a state the base never had', () => {
    const shorter = sanitizeSectionOverlay('hero', restoreItemStates(base, { flow: { nodes: [{ label: 'A', state: 'done' }, { label: 'B', state: 'hecho' }] } }));
    expect(states(shorter)).toEqual(['done', undefined]);
    const out = restoreItemStates({ columns: [{ title: 'a', state: 'done' }, { title: 'b' }] }, { columns: [{ title: 'x', state: 'waiting' }, { title: 'y', state: 'done' }] });
    expect((out.columns as Array<{ state?: string }>).map((c) => c.state)).toEqual(['done', undefined]);
  });
});

describe('every save syncs overlay states to the base (ADR 1038 D8)', () => {
  const base = { layout: 'flow', columns: [{ title: 'A', text: '', state: 'done' }, { title: 'B', text: '', state: 'waiting' }] };

  it('a page save rewrites a stale or translator-chosen overlay state', () => {
    const s = validateSection({ type: 'columns', data: base, localizations: { es: { columns: [{ title: 'A-es', text: '', state: 'waiting' }, { title: 'B-es', text: '', state: 'en espera' }] } } });
    const es = (s.localizations!.es as { columns: Array<{ state?: string }> }).columns;
    expect(es.map((c) => c.state)).toEqual(['done', 'waiting']);
  });

  it('a synced state is not an author edit: an outdated translation stays outdated', () => {
    const prev = [{ sectionId: 's1', localizations: { es: { columns: [{ title: 'A-es', text: '', state: 'waiting' }] } }, sourceDigest: { es: 'old-digest' } }];
    const next: Array<Pick<Section, 'sectionId' | 'data' | 'localizations' | 'sourceDigest'>> = [{ sectionId: 's1', data: { layout: 'flow', columns: [{ title: 'A2', text: '', state: 'done' }] }, localizations: { es: { columns: [{ title: 'A-es', text: '', state: 'done' }] } } }];
    expect(stampSourceDigests(prev, next)[0]!.sourceDigest).toEqual({ es: 'old-digest' });
  });
});
