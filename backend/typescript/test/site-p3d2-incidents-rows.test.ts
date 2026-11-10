/**
 * ADR 1068 D2 (myndhyve.ai design batch, P3d-2): the server half.
 *
 *  1. A `rows` section's `diagram` is closed-world: up to eight boxes (label
 *     required, text optional), ONE `waiting` at most (a later flag is dropped),
 *     a caption; fewer than two boxes is no diagram; any other layout drops it;
 *     a localization overlay carries its words.
 *  2. The diagram reaches the crawler render and the markdown export as the
 *     ordered steps it draws.
 *  3. `==highlight==` is a `<mark>` in the crawler's inline grammar, escaped.
 *
 * Case 3's overlay names `layout: 'rows'` on purpose. ADR 1068 says overlays
 * name no layout, and without one the builder defaults to `cards` and drops the
 * diagram (`cmsService.ts` `layout === 'rows' ? cleanDiagram(…)`): grade-code
 * row DIAGRAM-OVERLAY-1. The assertion stays as it is until that row is decided.
 *
 * Sabotage (each witnessed red): drop the diagram from the builder; keep a second
 * waiting flag; keep a one-box diagram; keep more than eight boxes; let a non-rows layout keep it; drop it
 * from the crawler or the markdown; drop the mark branch, or stop escaping it.
 */
import { describe, expect, it } from 'vitest';
import { validateSection, sanitizeSectionOverlay } from '../src/features/cms/cmsService.js';
import { sectionHtml, inlineMarkdownHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const ROWS = {
  layout: 'rows',
  heading: 'You stay in charge',
  columns: [{ title: 'Approvals', text: 'Risky steps wait.' }, { title: 'The record', text: 'Every step written down.' }],
};
const NODES = [
  { label: 'Trigger', text: 'New sign-up' },
  { label: 'Writer', text: '12 replies drafted' },
  { label: 'Waits for you', text: 'Send 10 replies', waiting: true },
  { label: 'Checker', text: '2 flagged', waiting: true },
];
const data = (d: Record<string, unknown>) => validateSection({ type: 'columns', data: d }).data;

describe('rows diagram — validation', () => {
  it('keeps boxes in order, one waiting step, and the caption', () => {
    const d = data({ ...ROWS, diagram: { nodes: NODES, caption: 'A real run.' } });
    expect(d.diagram).toEqual({
      nodes: [
        { label: 'Trigger', text: 'New sign-up' },
        { label: 'Writer', text: '12 replies drafted' },
        { label: 'Waits for you', text: 'Send 10 replies', waiting: true },
        { label: 'Checker', text: '2 flagged' },
      ],
      caption: 'A real run.',
    });
  });

  it('caps at eight boxes, needs two, and belongs to the rows layout only', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `S${i}` }));
    const capped = (data({ ...ROWS, diagram: { nodes: many } }).diagram as { nodes: { label: string }[] }).nodes;
    expect(capped.map((n) => n.label), 'the FIRST eight, in order').toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(data({ ...ROWS, diagram: { nodes: [{ label: 'Only' }] } }).diagram).toBeUndefined();
    expect(data({ ...ROWS, layout: 'cards', diagram: { nodes: NODES } }).diagram).toBeUndefined();
  });

  it('carries its words into a localization overlay', () => {
    const o = sanitizeSectionOverlay('columns', { layout: 'rows', diagram: { nodes: [{ label: 'Disparo', text: 'Nuevo registro' }, { label: 'Redactor' }], caption: 'Una ejecución.' } }) as Record<string, unknown>;
    expect(o.diagram).toEqual({ nodes: [{ label: 'Disparo', text: 'Nuevo registro' }, { label: 'Redactor' }], caption: 'Una ejecución.' });
  });
});

describe('rows diagram — crawler and markdown', () => {
  it('renders the ordered steps and the caption', () => {
    const s = validateSection({ type: 'columns', data: { ...ROWS, diagram: { nodes: NODES, caption: 'A real run.' } } });
    const html = sectionHtml(s, { assetBase: 'https://app.example.test' })!;
    expect(html).toContain('<ol>\n<li><strong>Trigger</strong> New sign-up</li>');
    expect(html).toContain('<figcaption>A real run.</figcaption>');
    const md = sectionMarkdown(s, 'https://app.example.test')!;
    expect(md).toContain('1. **Trigger** New sign-up');
    expect(md).toContain('3. **Waits for you** Send 10 replies');
    expect(md).toContain('*A real run.*');
  });
});

describe('==highlight== in the crawler grammar', () => {
  it('is a <mark>, escaped, beside the other inline forms', () => {
    expect(inlineMarkdownHtml('You can ==see what they did== and **stop** them.')).toBe('You can <mark>see what they did</mark> and <strong>stop</strong> them.');
    expect(inlineMarkdownHtml('==<b>x</b>==')).toBe('<mark>&lt;b&gt;x&lt;/b&gt;</mark>');
  });
});
