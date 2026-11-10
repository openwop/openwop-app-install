/**
 * ADR 1047 — feature cards (`columns` layout `features`) and the hero `hub`
 * picture, on the server.
 *
 * Pins:
 *   1. `features` is a known layout; an item keeps its callout, labelled pills
 *      (closed `state`), and a folded disclosure; a callout or disclosure with
 *      no text and a pill with no label are dropped; caps hold;
 *   2. the section's `tagLegend` is kept (content, overlay-safe);
 *   3. a hero `hub` keeps its centre (label, eyebrow, picture + alt) and 2–8
 *      places with index and icon slug; fewer than two places or no centre
 *      label drops it; a centre picture without alt is refused;
 *   4. a locale overlay is held to the same cleaners;
 *   5. the prerender writes the hub as a figure + list and a feature card's
 *      callout, pills (with the legend word) and disclosure as text; the
 *      markdown carries the same; a section with none of the new fields
 *      renders exactly as before.
 *
 * Sabotage-witnessed (w86 grade-tests): keeping a text-less callout or
 * disclosure, a label-less pill, or an unknown pill state reds 1 (and 4 for the
 * state); raising any cap, or lowering it (the caps are asserted exactly), reds
 * 1; dropping `tagLegend.soon` reds 2; a one-place or label-less hub, a ninth
 * place, a centre picture without alt, or a label-less overlay place reds 3/4;
 * dropping the hub picture, a pill's legend word, the callout text or the
 * disclosure from the HTML, or the callout from the markdown, reds 5; routing a
 * plain cards item through the feature-card writer reds 5's "unchanged" case.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };
const data = (type: Section['type'], d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;
type Feat = { title?: string; callout?: { label?: string; text?: string }; tags?: { label?: string; state?: string }[]; more?: { label?: string; text?: string } };
const colsOf = (d: Record<string, unknown>): Feat[] => d.columns as Feat[];

const FEATURE = {
  eyebrow: 'Stop 1 · Team chat', title: 'Your agent, *in the thread.*', text: 'Mention your agent where your team already talks.',
  imageToken: 'tok_chat', alt: 'A chat thread with an approval card', frameUrl: 'app.example.test/chat',
  callout: { label: 'The problem it solves', text: 'Nothing customer-facing goes out because an agent decided it should.' },
  tags: [{ label: 'Start work from Slack', state: 'now' }, { label: 'Two-way chat', state: 'soon' }],
  more: { label: 'How you use it', text: 'Connect Slack under Connections.\n\nMention it to start a workflow.' },
};
const HUB = {
  center: { eyebrow: 'One', label: 'Your agent', imageToken: 'tok_head', alt: 'The robot head mark' },
  spokes: [{ label: 'Team chat', index: '01', icon: 'chat' }, { label: 'Customers', index: '02', icon: 'users' }, { label: 'The phone', index: '03', icon: 'phone' }],
};

describe('ADR 1047 — feature cards', () => {
  it('keeps the features layout and every card field', () => {
    const d = data('columns', { layout: 'features', tagLegend: { now: 'Available now', soon: 'Rolling out' }, columns: [FEATURE] });
    expect(d.layout).toBe('features');
    expect(d.tagLegend).toEqual({ now: 'Available now', soon: 'Rolling out' });
    expect(colsOf(d)[0]).toMatchObject({ callout: FEATURE.callout, tags: FEATURE.tags, more: FEATURE.more, imageToken: 'tok_chat', alt: FEATURE.alt });
  });
  it('drops empty callouts, disclosures and pills, and closes the pill state', () => {
    const d = data('columns', { layout: 'features', columns: [{ title: 'A', text: 'B', callout: { label: 'Only a label' }, more: { label: 'Only a label' }, tags: [{ state: 'now' }, { label: 'Kept', state: 'later' }] }] });
    const c = colsOf(d)[0]!;
    expect(c.callout).toBeUndefined();
    expect(c.more).toBeUndefined();
    expect(c.tags).toEqual([{ label: 'Kept' }]);
  });
  it('bounds pill count and every string', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ label: `P${i}`.padEnd(100, 'x'), state: 'now' }));
    const d = data('columns', { layout: 'features', columns: [{ title: 'A', text: 'B', tags: many, callout: { label: 'l'.repeat(300), text: 't'.repeat(900) }, more: { text: 'm'.repeat(5000) } }] });
    const c = colsOf(d)[0]!;
    expect(c.tags?.length).toBe(6);
    expect(c.tags?.[0]?.label?.length).toBe(60);
    expect(c.callout?.label?.length).toBe(80);
    expect(c.callout?.text?.length).toBe(280);
    expect(c.more?.text?.length).toBe(2000);
  });
  it('holds an overlay to the same cleaners', () => {
    const o = sanitizeSectionOverlay('columns', { tagLegend: { now: 'Disponible' }, columns: [{ title: 'Uno', text: 'T', tags: [{ label: 'Ya', state: 'bogus' }], callout: { text: '' } }] });
    expect(o.tagLegend).toEqual({ now: 'Disponible' });
    expect(colsOf(o)[0]?.tags).toEqual([{ label: 'Ya' }]);
    expect(colsOf(o)[0]?.callout).toBeUndefined();
  });
});

describe('ADR 1047 — hero hub', () => {
  it('keeps the centre and its places', () => {
    const d = data('hero', { heading: 'Everywhere', visual: 'hub', hub: HUB });
    expect(d.visual).toBe('hub');
    expect(d.hub).toEqual(HUB);
  });
  it('drops a hub with fewer than two places or no centre label', () => {
    expect(data('hero', { heading: 'H', visual: 'hub', hub: { center: { label: 'X' }, spokes: [{ label: 'One' }] } }).hub).toBeUndefined();
    expect(data('hero', { heading: 'H', visual: 'hub', hub: { center: {}, spokes: [{ label: 'A' }, { label: 'B' }] } }).hub).toBeUndefined();
  });
  it('caps places at eight and refuses a centre picture without alt', () => {
    const spokes = Array.from({ length: 12 }, (_, i) => ({ label: `Place ${i}` }));
    const hub = data('hero', { heading: 'H', visual: 'hub', hub: { center: { label: 'C' }, spokes } }).hub as { spokes: unknown[] };
    expect(hub.spokes.length).toBe(8);
    expect(() => data('hero', { heading: 'H', visual: 'hub', hub: { center: { label: 'C', imageToken: 'tok_1' }, spokes: [{ label: 'A' }, { label: 'B' }] } })).toThrow(/alt is required/);
  });
  it('holds an overlay hub to the same cleaner', () => {
    const o = sanitizeSectionOverlay('hero', { hub: { center: { label: 'Tu agente' }, spokes: [{ label: 'Chat' }, { label: 'Clientes' }, { nope: 1 }] } });
    expect(o.hub).toEqual({ center: { label: 'Tu agente' }, spokes: [{ label: 'Chat' }, { label: 'Clientes' }] });
  });
});

describe('ADR 1047 — crawler output', () => {
  const sec = (type: Section['type'], d: Record<string, unknown>): Section => ({ sectionId: 'sec:t', type, data: data(type, d) });
  it('writes the hub as a figure with its places', () => {
    const html = sectionHtml(sec('hero', { heading: 'Everywhere', visual: 'hub', hub: HUB }), OPTS)!;
    expect(html).toContain('<figure>');
    expect(html).toContain('alt="The robot head mark"');
    expect(html).toContain('<strong>Your agent</strong>');
    expect(html).toContain('<li>01 Team chat</li>');
    const md = sectionMarkdown(sec('hero', { heading: 'Everywhere', visual: 'hub', hub: HUB }), 'https://app.example.test')!;
    expect(md).toContain('**One Your agent**');
    expect(md).toContain('- 02 Customers');
  });
  it('writes a feature card in full, pills with their legend words', () => {
    const s = sec('columns', { layout: 'features', tagLegend: { now: 'Available now', soon: 'Rolling out' }, columns: [FEATURE] });
    const html = sectionHtml(s, OPTS)!;
    expect(html).toContain('<h3>Your agent, <em>in the thread.</em></h3>');
    expect(html).toContain('<p><strong>The problem it solves</strong> Nothing customer-facing goes out because an agent decided it should.</p>');
    expect(html).toContain('<li>Start work from Slack — Available now</li>');
    expect(html).toContain('<li>Two-way chat — Rolling out</li>');
    expect(html).toContain('<h4>How you use it</h4>');
    expect(html).toContain('Mention it to start a workflow.');
    const md = sectionMarkdown(s, 'https://app.example.test')!;
    expect(md).toContain('*The problem it solves* Nothing customer-facing goes out because an agent decided it should.');
    expect(md).toContain('- Start work from Slack (Available now)');
    expect(md).toContain('*How you use it* Connect Slack under Connections. Mention it to start a workflow.');
  });
  it('leaves sections without the new fields unchanged', () => {
    // A title with emphasis markers: the cards writer keeps them as text, the
    // feature-card writer would turn them into <em>.
    const plain = sec('columns', { layout: 'cards', columns: [{ title: 'Plain *word*', text: 'B' }] });
    const plainHtml = sectionHtml(plain, OPTS);
    expect(plainHtml).toContain('<li><h3>Plain *word*</h3><p>B</p></li>');
    expect(plainHtml).not.toContain('<em>');
    const hero = sec('hero', { heading: 'H', visual: 'none' });
    expect(sectionHtml(hero, OPTS)).not.toContain('<figure>');
  });
});
