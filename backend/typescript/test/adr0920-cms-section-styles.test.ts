/**
 * ADR 0920 — CMS section styles, server half: validation (`buildSectionData`
 * via `validateSection` / `sanitizeSectionOverlay`), the same-page fragment link
 * (`safeLink`, D6), and crawler/markdown parity (D7, ADR 0593 §C9).
 *
 * Why this exists: every new field is optional and additive, and section bodies
 * stay CLOSED (ADR 0748). So the claims are (1) each field round-trips, (2) an
 * unknown enum value is dropped, never thrown, (3) every string/array is capped,
 * (4) a page that sets none of them validates and renders exactly as before, and
 * (5) a crawler reads the plan / chat / list text a person reads.
 *
 * Sabotage notes: dropping `pickEnum` (keeping raw values) reds the unknown-enum
 * cases; removing the `Math.min/max` in `unitFraction` reds the clamp case;
 * removing `planFigureHtml` from the hero branch reds the crawler plan case;
 * relaxing FRAGMENT_HREF_RE to `^#` reds the refused-fragment table.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';

const data = (type: string, d: Record<string, unknown>): Record<string, unknown> => validateSection({ type, data: d }).data;
const OPTS = { assetBase: 'https://app.example.test' };
const BASE = 'https://app.example.test';
const sec = (type: Section['type'], d: Record<string, unknown>): Section => validateSection({ sectionId: `s-${type}`, type, data: d });

const PLAN = {
  eyebrow: 'Your plan',
  title: 'Run a 10k by June',
  meta: 'Week 3 of 12',
  progress: 0.25,
  progressNote: '3 of 12 weeks done',
  stepEyebrow: 'Today',
  stepTitle: 'Easy 4 km',
  lines: [{ label: 'Why', text: 'Builds the base without strain.' }, { label: 'How', text: 'Keep it conversational.' }],
  action: 'Mark done',
  chips: ['Morning', '30 min'],
  note: 'Adjusts if you miss a day',
  initial: 'K',
  bubble: 'Nice, three in a row',
};

const CHAT = {
  title: 'Your guide',
  subtitle: 'Replies in seconds',
  badge: 'Beta',
  messages: [
    { from: 'person', text: 'I missed Tuesday.' },
    { from: 'guide', text: 'No problem, I moved it to Thursday.' },
  ],
  proposal: { label: 'Proposal', text: 'Run Thursday at 7am', accept: 'Accept', decline: 'Not now' },
  placeholder: 'Ask anything',
};

describe('ADR 0920 — round-trip of every new field', () => {
  it('hero: plan, note, ctaIcon2 and visual "plan"', () => {
    const d = data('hero', { heading: 'H', ctaLabel: 'A', ctaUrl: '/a', ctaLabel2: 'B', ctaUrl2: '/b', ctaIcon2: 'play', visual: 'plan', note: 'Free forever.', plan: PLAN });
    expect(d).toEqual({ heading: 'H', ctaLabel: 'A', ctaUrl: '/a', ctaLabel2: 'B', ctaUrl2: '/b', ctaIcon2: 'play', visual: 'plan', note: 'Free forever.', plan: PLAN });
  });

  it('columns: new layouts, item fields, section note, numbers, tone, head', () => {
    for (const layout of ['ruled', 'progress', 'list', 'tiles', 'panels']) {
      expect(data('columns', { layout, columns: [] }).layout).toBe(layout);
    }
    const col = { title: 'Learning', text: 't', eyebrow: 'Week 2', progress: 0.5, badge: 'New', future: true, art: 'feed', items: [{ label: 'Intro', meta: '4 min' }, { label: 'Deep dive' }] };
    expect(data('columns', { layout: 'list', columns: [col], note: 'Lengths are typical.', numbers: 'circle', tone: 'muted', head: 'split' }))
      .toEqual({ layout: 'list', columns: [col], note: 'Lengths are typical.', numbers: 'circle', tone: 'muted', head: 'split' });
  });

  it('richText: visual "chat" + chat, tone, head', () => {
    expect(data('richText', { text: 'x', visual: 'chat', chat: CHAT, tone: 'inverse', head: 'split' }))
      .toEqual({ text: 'x', visual: 'chat', chat: CHAT, tone: 'inverse', head: 'split' });
  });

  it('cta: tone + align; faq: tone + head; video: tone + head; quotes: tone', () => {
    expect(data('cta', { label: 'Go', url: '/go', tone: 'accent', align: 'start' })).toEqual({ label: 'Go', url: '/go', tone: 'accent', align: 'start' });
    expect(data('faq', { items: [{ q: 'Q?', a: 'A.' }], tone: 'default', head: 'stacked' })).toMatchObject({ tone: 'default', head: 'stacked' });
    expect(data('quotes', { items: [{ quote: 'Great' }], tone: 'muted' })).toMatchObject({ tone: 'muted' });
    const video = data('video', {
      title: 'T', description: 'D', length: '1:00', src: 'https://x.test/v.mp4', poster: 'https://x.test/p.jpg', tone: 'inverse', head: 'split',
    });
    expect(video).toMatchObject({ tone: 'inverse', head: 'split' });
  });
});

describe('ADR 0920 — closed enums drop unknown values (never throw)', () => {
  it.each([
    ['hero', { heading: 'H', visual: 'chat', ctaIcon2: 'rocket' }, ['visual', 'ctaIcon2']],
    ['columns', { layout: 'grid', numbers: 'roman', tone: 'neon', head: 'side', columns: [{ text: 't', art: 'sunset' }] }, ['numbers', 'tone', 'head']],
    ['richText', { text: 'x', visual: 'plan', tone: 'loud', head: 'left' }, ['visual', 'tone', 'head']],
    ['cta', { label: 'Go', url: '/g', align: 'end', tone: 7 }, ['align', 'tone']],
  ])('%s', (type, d, absent) => {
    const out = data(type as string, d as Record<string, unknown>);
    for (const k of absent as string[]) expect(out).not.toHaveProperty(k);
  });

  it('an unknown column layout still falls back to cards; unknown art is dropped from the item', () => {
    const out = data('columns', { layout: 'grid', columns: [{ text: 't', art: 'sunset' }] });
    expect(out.layout).toBe('cards');
    expect((out.columns as Record<string, unknown>[])[0]).toEqual({ text: 't' });
  });

  it('a chat message with an unknown `from` (or no text) is dropped', () => {
    const out = data('richText', { text: 'x', chat: { messages: [{ from: 'bot', text: 'hi' }, { from: 'guide', text: '' }, { from: 'guide', text: 'ok' }] } });
    expect(out.chat).toEqual({ messages: [{ from: 'guide', text: 'ok' }] });
  });

  it('a non-object plan / chat is dropped; an object with nothing valid is dropped', () => {
    expect(data('hero', { heading: 'H', plan: 'a string' })).not.toHaveProperty('plan');
    expect(data('hero', { heading: 'H', plan: [PLAN] })).not.toHaveProperty('plan');
    expect(data('hero', { heading: 'H', plan: { unknown: 'x', progress: 'half' } })).not.toHaveProperty('plan');
    expect(data('richText', { text: 'x', chat: { messages: 'nope' } })).not.toHaveProperty('chat');
  });

  it('unknown keys inside plan / chat / list items do not survive (closed objects)', () => {
    const out = data('hero', { heading: 'H', plan: { title: 'T', html: '<b>x</b>', lines: [{ text: 'a', href: 'javascript:x' }] } });
    expect(out.plan).toEqual({ title: 'T', lines: [{ text: 'a' }] });
    const cols = data('columns', { layout: 'list', columns: [{ text: 't', items: [{ label: 'L', meta: 'm', url: '/x' }] }] }).columns as Record<string, unknown>[];
    expect(cols[0]!.items).toEqual([{ label: 'L', meta: 'm' }]);
  });
});

describe('ADR 0920 — caps', () => {
  it('plan strings ≤ 80, lines[].text ≤ 160, lines ≤ 3, chips ≤ 5, empty chips filtered', () => {
    const plan = data('hero', {
      heading: 'H',
      plan: {
        title: 't '.repeat(100),
        lines: [1, 2, 3, 4].map(() => ({ label: 'l '.repeat(100), text: 'x '.repeat(200) })),
        chips: ['a', '', 'b', 'c', 'd', 'e', 'f'],
      },
    }).plan as { title: string; lines: { label: string; text: string }[]; chips: string[] };
    expect(plan.title).toHaveLength(80);
    expect(plan.lines).toHaveLength(3);
    expect(plan.lines[0]!.label).toHaveLength(80);
    expect(plan.lines[0]!.text).toHaveLength(160);
    expect(plan.chips).toEqual(['a', 'b', 'c', 'd']); // sliced to 5, then the empty one filtered
  });

  it('hero note ≤ 200; section note ≤ 280; badge ≤ 40; item eyebrow ≤ 80; items ≤ 8, label ≤ 120, meta ≤ 40', () => {
    expect((data('hero', { heading: 'H', note: 'n '.repeat(250) }).note as string)).toHaveLength(200);
    const cols = data('columns', {
      layout: 'list',
      note: 'n '.repeat(250),
      columns: [{
        text: 't',
        badge: 'b '.repeat(50),
        eyebrow: 'e '.repeat(50),
        items: Array.from({ length: 12 }, () => ({ label: 'l '.repeat(150), meta: 'm '.repeat(50) })),
      }],
    });
    expect(cols.note as string).toHaveLength(280);
    const c = (cols.columns as Record<string, unknown>[])[0] as { badge: string; eyebrow: string; items: { label: string; meta: string }[] };
    expect(c.badge).toHaveLength(40);
    expect(c.eyebrow).toHaveLength(80);
    expect(c.items).toHaveLength(8);
    expect(c.items[0]!.label).toHaveLength(120);
    expect(c.items[0]!.meta).toHaveLength(40);
  });

  it('chat: messages ≤ 6 with text ≤ 400; every other chat string (incl. proposal) ≤ 120', () => {
    const chat = data('richText', {
      text: 'x',
      chat: {
        title: 't '.repeat(150),
        messages: Array.from({ length: 9 }, () => ({ from: 'guide', text: 'm '.repeat(450) })),
        proposal: { label: 'l '.repeat(150), text: 'p '.repeat(150), accept: 'a '.repeat(150), decline: 'd '.repeat(150) },
        placeholder: 'p '.repeat(150),
      },
    }).chat as { title: string; messages: { text: string }[]; proposal: Record<string, string>; placeholder: string };
    expect(chat.title).toHaveLength(120);
    expect(chat.messages).toHaveLength(6);
    expect(chat.messages[0]!.text).toHaveLength(400);
    for (const v of Object.values(chat.proposal)) expect(v).toHaveLength(120);
    expect(chat.placeholder).toHaveLength(120);
  });
});

describe('ADR 0920 — progress is a clamped 0..1 fraction', () => {
  it.each([
    [0.4, 0.4], [-2, 0], [7, 1], [0, 0], [1, 1],
  ])('%s → %s (plan and column item)', (raw, want) => {
    expect((data('hero', { heading: 'H', plan: { title: 'T', progress: raw } }).plan as { progress: number }).progress).toBe(want);
    expect(((data('columns', { columns: [{ text: 't', progress: raw }] }).columns as { progress: number }[])[0]!).progress).toBe(want);
  });
  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], ['0.5'], [null]])('%s is dropped', (raw) => {
    expect((data('hero', { heading: 'H', plan: { title: 'T', progress: raw } }).plan)).toEqual({ title: 'T' });
    expect(((data('columns', { columns: [{ text: 't', progress: raw }] }).columns as object[])[0])).toEqual({ text: 't' });
  });
});

describe('ADR 0920 — per-locale overlays (partial) carry the new text fields', () => {
  it('a hero overlay keeps only what it names, plan replaced whole, cleaned identically', () => {
    expect(sanitizeSectionOverlay('hero', { note: 'Gratis.', plan: { title: 'Corre 10k', chips: ['Mañana'] } }))
      .toEqual({ note: 'Gratis.', plan: { title: 'Corre 10k', chips: ['Mañana'] } });
    expect(sanitizeSectionOverlay('hero', { note: 'Gratis.' })).toEqual({ note: 'Gratis.' });
  });
  it('a richText / columns overlay with no new fields emits none of them', () => {
    expect(sanitizeSectionOverlay('richText', { text: 'hola' })).toEqual({ text: 'hola' });
    expect(sanitizeSectionOverlay('columns', { note: 'nota' })).toEqual({ note: 'nota' });
  });
  it('validateSection accepts a localized chat overlay and cleans it', () => {
    const s = validateSection({ type: 'richText', data: { text: 'x', chat: CHAT }, localizations: { es: { chat: { title: 'Tu guía', messages: [{ from: 'guide', text: 'Hola' }, { from: '??', text: 'x' }] } } } });
    expect(s.localizations?.es).toEqual({ chat: { title: 'Tu guía', messages: [{ from: 'guide', text: 'Hola' }] } });
  });
});

describe('ADR 0920 D6 — safeLink accepts a same-page fragment', () => {
  const heroUrl = (ctaUrl: string): unknown => data('hero', { heading: 'H', ctaLabel: 'Go', ctaUrl }).ctaUrl;
  const ctaUrl = (url: string): unknown => data('cta', { label: 'Go', url }).url;

  it('accepts and returns the fragment unchanged (hero, cta, column href)', () => {
    expect(heroUrl('#one-minute-one-someday-list')).toBe('#one-minute-one-someday-list');
    expect(ctaUrl('#faq')).toBe('#faq');
    expect((data('columns', { columns: [{ text: 't', href: '#How_it-works' }] }).columns as { href: string }[])[0]!.href).toBe('#How_it-works');
    // 80 after `#` — longer than the 40-char secret-shape scrub, which must not eat it.
    expect(heroUrl(`#a${'b'.repeat(79)}`)).toBe(`#a${'b'.repeat(79)}`);
  });

  it.each(['#', '#1x', '#a b', '#<x>', '#javascript:alert(1)', `#a${'b'.repeat(80)}`, '#-x'])('refuses %s', (url) => {
    expect(heroUrl(url)).toBe('');
    expect(ctaUrl(url)).toBe('');
  });

  it('existing internal and external rules are unchanged', () => {
    expect(heroUrl('/chat')).toBe('/chat');
    expect(heroUrl('https://openwop.dev')).toBe('https://openwop.dev');
    expect(heroUrl('mailto:a@b.test')).toBe('mailto:a@b.test');
    expect(heroUrl('javascript:alert(1)')).toBe('');
    expect(heroUrl('//evil.com')).toBe('');
    expect(heroUrl('/\\evil.com')).toBe('');
  });

  it('the crawler and markdown render the fragment as a followable link', () => {
    expect(sectionHtml(sec('cta', { label: 'See the list', url: '#daily-list' }), OPTS)).toContain('<a href="#daily-list">See the list</a>');
    expect(sectionHtml(sec('hero', { heading: 'H', ctaLabel: 'Go', ctaUrl: '#faq' }), OPTS)).toContain('<a href="#faq">Go</a>');
    expect(sectionMarkdown(sec('cta', { label: 'See the list', url: '#daily-list' }), BASE)).toContain('[See the list](#daily-list)');
  });
});

describe('ADR 0920 — additive guarantee: a page with none of the new fields is unchanged', () => {
  // Pre-ADR shapes, written out literally (validated output at HEAD before this
  // change). The full crawler HTML of such a page stays pinned byte-for-byte by
  // `adr0384-section-html.test.ts` › "full-page golden".
  const LEGACY: Array<[Section['type'], Record<string, unknown>, Record<string, unknown>]> = [
    ['hero', { heading: 'H', eyebrow: 'E', subheading: 'S', visual: 'journey', ctaLabel: 'A', ctaUrl: '/a' },
      { eyebrow: 'E', heading: 'H', subheading: 'S', visual: 'journey', ctaLabel: 'A', ctaUrl: '/a' }],
    ['richText', { heading: 'R', text: 'T' }, { heading: 'R', text: 'T' }],
    ['cta', { heading: 'C', label: 'L', url: '/u' }, { heading: 'C', label: 'L', url: '/u' }],
    ['columns', { heading: 'Cols', layout: 'steps', columns: [{ title: 'A', text: 'a', icon: 'run', optional: true }] },
      { heading: 'Cols', layout: 'steps', columns: [{ title: 'A', text: 'a', icon: 'run', optional: true }] }],
    ['faq', { heading: 'F', items: [{ q: 'Q', a: 'A' }] }, { heading: 'F', items: [{ q: 'Q', a: 'A' }] }],
    ['quotes', { items: [{ quote: 'Q', name: 'N' }] }, { items: [{ quote: 'Q', name: 'N' }] }],
  ];

  it.each(LEGACY)('%s validates to the pre-ADR shape exactly', (type, raw, want) => {
    expect(data(type, raw)).toEqual(want);
  });

  it.each(LEGACY)('%s: unknown style values leave the validated data, HTML and markdown unchanged', (type, raw) => {
    const noisy = { ...raw, tone: 'neon', head: 'side', align: 'end', numbers: 'roman', ctaIcon2: 'rocket', plan: 'x', chat: [] };
    const a = sec(type, raw);
    const b = sec(type, noisy);
    expect(b.data).toEqual(a.data);
    expect(sectionHtml(b, OPTS)).toBe(sectionHtml(a, OPTS));
    expect(sectionMarkdown(b, BASE)).toBe(sectionMarkdown(a, BASE));
  });

  it('presentation-only fields add nothing to the crawler HTML', () => {
    const plain = sec('columns', { heading: 'Cols', layout: 'cards', columns: [{ title: 'A', text: 'a' }] });
    const styled = sec('columns', { heading: 'Cols', layout: 'cards', tone: 'inverse', head: 'split', numbers: 'circle', columns: [{ title: 'A', text: 'a', progress: 0.5, future: true, art: 'solo' }] });
    expect(sectionHtml(styled, OPTS)).toBe(sectionHtml(plain, OPTS));
  });
});

describe('ADR 0920 D7 — crawler = human text', () => {
  it('hero plan card + note render as escaped text inside the header', () => {
    const html = sectionHtml(sec('hero', { heading: 'H', note: 'No card <needed>', visual: 'plan', plan: PLAN }), OPTS)!;
    for (const t of ['Your plan', 'Run a 10k by June', 'Week 3 of 12', '3 of 12 weeks done', 'Today', 'Easy 4 km', 'Why', 'Builds the base without strain.', 'Mark done', 'Morning', '30 min', 'Adjusts if you miss a day', 'Nice, three in a row']) {
      expect(html).toContain(t);
    }
    expect(html).toContain('No card &lt;needed&gt;');
    expect(html).toContain('<figure>');
    expect(html.indexOf('<figure>')).toBeLessThan(html.indexOf('</header>'));
  });

  it('richText chat renders every message, the proposal and its choices', () => {
    const html = sectionHtml(sec('richText', { text: 'Copy.', visual: 'chat', chat: CHAT }), OPTS)!;
    expect(html).toContain('<figcaption>Your guide</figcaption>');
    for (const t of ['Replies in seconds', 'Beta', '<li>I missed Tuesday.</li>', '<li>No problem, I moved it to Thursday.</li>', '<strong>Proposal</strong> Run Thursday at 7am', 'Accept · Not now', 'Ask anything']) {
      expect(html).toContain(t);
    }
  });

  it('columns list rows, item eyebrow/badge and the section note render', () => {
    const html = sectionHtml(sec('columns', {
      layout: 'list',
      note: 'Lengths are typical & vary.',
      columns: [{ title: 'Learning', text: 'Small lessons.', eyebrow: 'Week 2', badge: 'New', items: [{ label: 'Intro to <b>', meta: '4 min' }] }],
    }), OPTS)!;
    expect(html).toContain('<p>Week 2</p><h3>Learning</h3><p>New</p>');
    expect(html).toContain('<li>Intro to &lt;b&gt; <small>4 min</small></li>');
    expect(html).toContain('<p><small>Lengths are typical &amp; vary.</small></p>');
  });

  it('the markdown export carries the same text', () => {
    const hero = sectionMarkdown(sec('hero', { heading: 'H', note: 'Free.', plan: PLAN }), BASE)!;
    for (const t of ['Free.', '**Run a 10k by June**', '- **Why** Builds the base without strain.', 'Morning · 30 min', 'Nice, three in a row']) expect(hero).toContain(t);
    const chat = sectionMarkdown(sec('richText', { text: 'Copy.', chat: CHAT }), BASE)!;
    for (const t of ['**Your guide**', '> I missed Tuesday.', '**Proposal** Run Thursday at 7am', 'Accept · Not now']) expect(chat).toContain(t);
    const cols = sectionMarkdown(sec('columns', { layout: 'list', note: 'Typical.', columns: [{ title: 'L', text: 't', badge: 'New', items: [{ label: 'Intro', meta: '4 min' }] }] }), BASE)!;
    expect(cols).toContain('- *New* **L** — t\n   - Intro (4 min)');
    expect(cols).toContain('\n\nTypical.');
  });
});
