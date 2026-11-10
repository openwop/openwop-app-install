/**
 * ADR 1029 D5 — the pattern layouts on existing section types: the hero
 * activity card, and the `timeline`, `bento` and `marquee` column layouts.
 *
 * Pins:
 *   1. the activity card is CLOSED: bounded text, at most six rows, a row with
 *      no action dropped, `state` a closed enum, `status` the author's text,
 *      nothing else kept (no links, no unknown keys);
 *   2. the three layouts validate, and a bento tile's `wide` is kept only as
 *      `true`;
 *   3. crawlers get the same words a person reads: the activity card renders as
 *      escaped text in reading order (its `state` adds nothing), a timeline as
 *      an ordered list, bento and marquee as the default list of titled items;
 *   4. the markdown export carries the activity rows too.
 *
 * Sabotage-witnessed (2026-11-02; re-measured /grade-tests wave 84, TST-FPC-1):
 * letting unknown activity keys through, keeping a row without an action or an
 * unknown `state`, dropping the six-row cap, or raising or LOWERING the action
 * cap reds 1; reading `wide` as truthy reds 2; dropping or un-escaping the
 * crawler activity card, treating a timeline as an unordered list, dropping its
 * date, or rendering bento/marquee as an ordered list reds 3; dropping the meta
 * from the markdown row reds 4.
 */
import { describe, expect, it } from 'vitest';
import { validateSection } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const OPTS = { assetBase: 'https://app.example.test' };

const ACTIVITY = {
  title: 'Launch review',
  items: [
    { actor: 'Ana', action: 'flagged the 38% claim', status: 'Flagged', state: 'flagged', meta: '2 min ago', href: 'https://evil.test' },
    { actor: 'Client PM', action: 'approved the launch', status: 'Approved', state: 'approved' },
    { actor: 'Ghost', status: 'Done' },
    { action: 'spec synced', state: 'sparkle' },
  ],
  extra: 'dropped',
};

describe('ADR 1029 — the hero activity card', () => {
  it('is closed: bounded text, a row needs an action, state is a closed enum', () => {
    const d = validateSection({ type: 'hero', data: { heading: 'H', visual: 'activity', activity: ACTIVITY } }).data;
    expect(d.visual).toBe('activity');
    expect(d.activity).toEqual({
      title: 'Launch review',
      items: [
        { actor: 'Ana', action: 'flagged the 38% claim', meta: '2 min ago', status: 'Flagged', state: 'flagged' },
        { actor: 'Client PM', action: 'approved the launch', status: 'Approved', state: 'approved' },
        { action: 'spec synced' },
      ],
    });
  });

  it('holds at most six rows, bounds each string, and is absent when no row survives', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ action: `step ${i}` }));
    const d = validateSection({ type: 'hero', data: { heading: 'H', activity: { items: many } } }).data;
    expect((d.activity as { items: unknown[] }).items).toHaveLength(6);
    const long = validateSection({ type: 'hero', data: { heading: 'H', activity: { items: [{ action: 'x'.repeat(400), actor: 'y'.repeat(200) }] } } }).data;
    const row = (long.activity as { items: Array<{ action: string; actor: string }> }).items[0]!;
    // Exact: a cap lowered below the ADR's 160/80 would pass a `<=` check.
    expect(row.action).toBe('x'.repeat(160));
    expect(row.actor).toBe('y'.repeat(80));
    expect(validateSection({ type: 'hero', data: { heading: 'H', activity: { items: [{ actor: 'only' }] } } }).data.activity).toBeUndefined();
  });
});

describe('ADR 1029 — timeline, bento and marquee', () => {
  it('validate as column layouts; a bento tile is wide only when `wide` is true', () => {
    for (const layout of ['timeline', 'bento', 'marquee']) {
      expect(validateSection({ type: 'columns', data: { layout, columns: [{ title: 'A', text: 'B' }] } }).data.layout).toBe(layout);
    }
    const cols = validateSection({ type: 'columns', data: { layout: 'bento', columns: [{ title: 'A', text: 'B', wide: true }, { title: 'C', text: 'D', wide: 'yes' }] } }).data.columns as Array<Record<string, unknown>>;
    expect(cols[0]!.wide).toBe(true);
    expect('wide' in cols[1]!).toBe(false);
  });
});

describe('ADR 1029 — crawlers read the same words', () => {
  const hero = validateSection({ type: 'hero', data: { heading: 'H', visual: 'activity', activity: { title: 'Review <b>', items: [{ actor: 'Ana', action: 'flagged <script>', status: 'Flagged', state: 'flagged', meta: 'now' }] } } });

  it('renders the activity card as escaped text in reading order, without its state', () => {
    const html = sectionHtml(hero, OPTS)!;
    expect(html).toContain('<figure>');
    expect(html).toContain('<strong>Review &lt;b&gt;</strong>');
    expect(html).toContain('<li><strong>Ana</strong> flagged &lt;script&gt; — Flagged <small>now</small></li>');
    expect(html).not.toContain('<script>');
  });

  it('renders a timeline as an ordered list, bento and marquee as titled items', () => {
    const col = (layout: string) => validateSection({ type: 'columns', data: { heading: 'H', layout, columns: [{ title: 'Kickoff', text: 'We meet.' }, { title: 'Launch', text: 'It ships.' }] } });
    expect(sectionHtml(col('timeline'), OPTS)).toMatch(/<ol>[\s\S]*Kickoff[\s\S]*Launch[\s\S]*<\/ol>/);
    // A timeline item's date leads it, as the visitor reads it.
    const dated = validateSection({ type: 'columns', data: { layout: 'timeline', columns: [{ eyebrow: 'Week <1>', title: 'Kickoff', text: 'We meet.' }] } });
    expect(sectionHtml(dated, OPTS)).toContain('<li><p>Week &lt;1&gt;</p><h3>Kickoff</h3>');
    // Bento and marquee are the default list of titled items: a <ul> of
    // <li><h3>title</h3><p>text</p></li>, never the timeline's ordered list.
    for (const layout of ['bento', 'marquee']) {
      const html = sectionHtml(col(layout), OPTS)!;
      expect(html, layout).toContain('<ul>\n<li><h3>Kickoff</h3><p>We meet.</p></li>\n<li><h3>Launch</h3><p>It ships.</p></li>\n</ul>');
      expect(html, layout).not.toContain('<ol>');
    }
  });

  it('exports the activity rows to markdown', () => {
    const md = sectionMarkdown(hero, 'https://app.example.test')!;
    expect(md).toContain('**Review <b>**');
    expect(md).toContain('- **Ana** flagged <script> — Flagged (now)');
  });
});
