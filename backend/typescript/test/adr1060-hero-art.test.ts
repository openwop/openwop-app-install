/**
 * ADR 1060 — the illustrated hero visuals, validated from one spec.
 *
 *   1. The frontend's spec (the editor and renderer read it) is the validator's,
 *      deep-equal, and every illustrated visual is a hero visual on both sides.
 *   2. Per visual: an authored value is accepted as written; unknown keys drop
 *      at every depth (closed); strings are capped; a styling enum outside its
 *      set drops; a list over its cap is REFUSED (typed 400), never cut, on the
 *      base layer and on a locale overlay alike; a list item being written
 *      survives autosave; a visual with nothing left is omitted.
 *   3. Crawlers and markdown read the visual's words in reading order, only
 *      while the hero shows it and only when it has enough to draw.
 *   4. List-item presentation (state, accent, fill, members) follows the base
 *      on an overlay write, so a translated enum or number never sticks.
 *
 * Sabotage-witnessed (wave 90, 2026-11-06), each turning a case red: editing one
 * side of the spec or dropping a visual from the editor's list (1); cutting
 * instead of refusing, skipping the cleaner on an overlay, a refusal that is not
 * a 400, keeping a junk enum, an unknown key, an uncapped string, fill or count,
 * dropping an empty item or keeping an empty visual (2); the crawler reading a
 * visual that is not shown, swapping reading order, reading an unpriced line,
 * an unescaped item, a member count in any words, or another markdown bullet
 * (3); removing a key from ITEM_BASE_KEYS or keeping an overlay value the base
 * lacks (4).
 */
import { describe, expect, it } from 'vitest';
import { sanitizeSectionOverlay, validateSection } from '../src/features/cms/cmsService.js';
import { HERO_ART_SPECS, HERO_ART_VISUALS } from '../src/features/cms/heroArt.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import { restoreItemStates } from '../src/features/cms/translate.js';
import { OpenwopError } from '../src/types.js';
import * as fe from '../../../frontend/react/src/features/cms/heroArtSpec.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FE_STYLES = readFileSync(join(import.meta.dirname, '..', '..', '..', 'frontend', 'react', 'src', 'features', 'cms', 'sectionStyles.tsx'), 'utf8');
const BASE = 'https://app.example.test';

const hero = (visual: string, value: unknown): Record<string, unknown> =>
  validateSection({ type: 'hero', data: { heading: 'H', visual, [visual]: value } }).data;
const html = (data: Record<string, unknown>): string => sectionHtml({ sectionId: 's', type: 'hero', data }, { assetBase: BASE }) ?? '';
const md = (data: Record<string, unknown>): string => sectionMarkdown({ sectionId: 's', type: 'hero', data }, BASE) ?? '';
/** A typed refusal (ADR 1038 D8, ADR 1060): an OpenwopError, `validation_error`, 400, naming the cap. */
const refused = (fn: () => unknown, message: RegExp, cap: number): void => {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  if (!(err instanceof OpenwopError)) throw new Error(`expected an OpenwopError, got ${String(err)}`);
  expect(err.message).toMatch(message);
  expect(err.code).toBe('validation_error');
  expect(err.httpStatus).toBe(400);
  expect(err.details).toMatchObject({ cap });
};

describe('one spec, two sides', () => {
  it('the frontend mirror is the validator, deep-equal', () => {
    expect(fe.HERO_ART_SPECS).toEqual(HERO_ART_SPECS);
    expect(fe.HERO_ART_VISUALS).toEqual(HERO_ART_VISUALS);
  });

  it('every illustrated visual is a hero visual (validator and editor list)', () => {
    const m = /export const HERO_VISUALS = \[([^\]]*)\] as const/.exec(FE_STYLES);
    const visuals = [...m![1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
    for (const v of HERO_ART_VISUALS) expect(visuals).toContain(v);
    for (const v of HERO_ART_VISUALS) expect(hero(v, {}).visual).toBe(v);
  });
});

describe('P1 receipt', () => {
  const receipt = {
    label: 'A printed receipt for one app',
    title: 'Your app',
    subtitle: 'One app · receipt',
    lines: [
      { label: 'Launch it with us', amount: '~$1,000 once' },
      { label: 'Usage credits', amount: '$0', state: 'highlight' },
    ],
    totalLabel: 'Surprises',
    totalAmount: '0',
    stamp: 'Flat · agreed in writing',
  };

  it('accepts an authored receipt as written', () => {
    expect(hero('receipt', receipt).receipt).toEqual(receipt);
  });

  it('is closed at every depth, caps strings and drops a junk state', () => {
    const r = hero('receipt', {
      ...receipt,
      colour: '#ff0000',
      title: 'x'.repeat(41),
      lines: [{ label: 'a', amount: 'b', state: 'gold', href: 'https://evil.test' }],
    }).receipt as Record<string, unknown>;
    expect('colour' in r).toBe(false);
    expect(r.title).toHaveLength(40);
    expect(r.lines).toEqual([{ label: 'a', amount: 'b' }]);
  });

  it('refuses a ninth line on the base layer and on an overlay, rather than cutting it', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, amount: '1' }));
    refused(() => hero('receipt', { lines: nine }), /receipt\.lines: at most 8 items/, 8);
    expect(() => sanitizeSectionOverlay('hero', { receipt: { lines: nine } })).toThrow(/at most 8/);
    expect((hero('receipt', { lines: nine.slice(0, 8) }).receipt as { lines: unknown[] }).lines).toHaveLength(8);
  });

  it('keeps a line being written; omits a receipt with nothing in it', () => {
    expect((hero('receipt', { lines: [{ label: 'a' }, {}] }).receipt as { lines: unknown[] }).lines).toEqual([{ label: 'a' }, {}]);
    expect('receipt' in hero('receipt', { colour: 'red' })).toBe(false);
    expect('receipt' in hero('receipt', 'not an object')).toBe(false);
  });

  it('reaches crawlers and markdown in reading order, only while shown and priced', () => {
    const shown = hero('receipt', receipt);
    const h = html(shown);
    expect(h).toContain('<figcaption>A printed receipt for one app</figcaption>');
    const order = ['Your app', 'One app · receipt', 'Launch it with us — ~$1,000 once', 'Usage credits — $0', 'Surprises — 0', 'Flat · agreed in writing'];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(md(shown)).toContain('- Usage credits — $0');
    // Another visual showing, or no priced line: nothing.
    expect(html({ ...shown, visual: 'flow' })).not.toContain('Launch it with us');
    expect(md({ ...shown, visual: 'flow' })).not.toContain('Launch it with us');
    expect(html(hero('receipt', { title: 'Your app', lines: [{ label: 'no amount' }] }))).not.toContain('Your app');
    // Escaped.
    expect(html(hero('receipt', { lines: [{ label: '<b>x</b>', amount: '1' }] }))).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('a line’s style follows the base on an overlay write', () => {
    const base = hero('receipt', receipt);
    const overlay = restoreItemStates(base, { receipt: { ...receipt, lines: [{ label: 'Lancement', amount: '1 000 $', state: 'surligné' }, { label: 'Crédits', amount: '0 $' }] } });
    const lines = (overlay.receipt as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines.map((l) => l.state)).toEqual([undefined, 'highlight']);
  });
});

describe('P2 apps', () => {
  const apps = {
    label: 'The same app for three clients',
    chip: 'Powered by your agency',
    items: [
      { name: 'Client one', address: 'app.client-one.example', accent: 'info', heading: 'The newsletter', rows: [{ text: 'Draft ready', status: 'Waits for you', state: 'waiting' }, { text: 'List cleaned', status: 'Done', state: 'done' }] },
      { name: 'Client two', accent: 'success', heading: 'The monthly report' },
      { name: 'Client three', accent: 'ai' },
    ],
  };

  it('accepts authored apps as written', () => {
    expect(hero('apps', apps).apps).toEqual(apps);
  });

  it('takes an accent only from its token set (no colour strings) and drops junk', () => {
    const a = hero('apps', { items: [{ name: 'x', accent: '#2650D9', colour: 'red', rows: [{ text: 't', state: 'paused' }] }] }).apps as { items: Array<Record<string, unknown>> };
    expect(a.items[0]).toEqual({ name: 'x', rows: [{ text: 't' }] });
  });

  it('refuses a fourth app and a fourth row, on the base and on an overlay', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ name: `c${i}` }));
    refused(() => hero('apps', { items: four }), /apps\.items: at most 3 items/, 3);
    refused(() => hero('apps', { items: [{ name: 'x', rows: four.map((f) => ({ text: f.name })) }] }), /apps\.items\.rows: at most 3 items/, 3);
    expect(() => sanitizeSectionOverlay('hero', { apps: { items: four } })).toThrow(/at most 3/);
  });

  it('reaches crawlers in order (name, address — heading, rows, chip), only while shown with a named app', () => {
    const h = html(hero('apps', apps));
    const order = ['Client one', 'app.client-one.example — The newsletter', 'Draft ready — Waits for you', 'Client two', 'Client three', 'Powered by your agency'];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(h).not.toContain('info');
    expect(md(hero('apps', apps))).toContain('- Draft ready — Waits for you');
    expect(html({ ...hero('apps', apps), visual: 'receipt' })).not.toContain('Client one');
    expect(html(hero('apps', { chip: 'c', items: [{ heading: 'no name' }] }))).not.toContain('no name');
  });

  it('an accent and a row state follow the base on an overlay write', () => {
    const base = hero('apps', apps);
    const raw = { apps: { ...apps, items: apps.items.map((x) => ({ ...x, accent: 'succès', rows: x.rows?.map((r) => ({ ...r, state: 'fait' })) })) } };
    const o = restoreItemStates(base, raw).apps as { items: Array<{ accent?: string; rows?: Array<{ state?: string }> }> };
    expect(o.items.map((x) => x.accent)).toEqual(['info', 'success', 'ai']);
    expect(o.items[0]!.rows!.map((r) => r.state)).toEqual(['waiting', 'done']);
  });
});

describe('P3 versus', () => {
  const versus = {
    label: 'Five tools against one app',
    divider: 'vs',
    before: { label: 'Five bills, five logins', items: [{ label: 'Logins' }, { label: 'Billing' }, { label: 'Site builder' }] },
    after: { label: 'One app', items: [{ label: 'Sign-in' }, { label: 'Billing' }] },
  };

  it('accepts authored sides as written; closed at every depth', () => {
    expect(hero('versus', versus).versus).toEqual(versus);
    const v = hero('versus', { ...versus, before: { ...versus.before, colour: 'red', items: [{ label: 'x', icon: 'y' }] } }).versus as { before: unknown };
    expect(v.before).toEqual({ label: 'Five bills, five logins', items: [{ label: 'x' }] });
  });

  it('refuses a seventh item on a side, and caps the divider', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `t${i}` }));
    refused(() => hero('versus', { ...versus, after: { items: seven } }), /versus\.after\.items: at most 6 items/, 6);
    expect((hero('versus', { ...versus, divider: 'versus!!!' }).versus as { divider: string }).divider).toBe('versus!!');
  });

  it('reaches crawlers side by side in order, only with an item on each side', () => {
    const h = html(hero('versus', versus));
    const order = ['Five bills, five logins', 'Logins', 'Site builder', '<p>vs</p>', 'One app', 'Sign-in'];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html(hero('versus', { ...versus, after: { label: 'One app' } }))).not.toContain('Logins');
    expect(md({ ...hero('versus', versus), visual: 'apps' })).not.toContain('Logins');
  });
});

describe('P4 fanout', () => {
  const fanout = {
    label: 'Your docs become a page, an email and an ad',
    source: 'Your docs',
    outputs: [
      { title: 'Web page', check: 'Brand check', state: 'done' },
      { title: 'Launch email', check: 'Brand check' },
      { title: 'Ad', status: 'Waits for you', state: 'waiting' },
    ],
  };

  it('accepts authored outputs as written; a junk state drops', () => {
    expect(hero('fanout', fanout).fanout).toEqual(fanout);
    const f = hero('fanout', { source: 's', outputs: [{ title: 't', state: 'blocked', href: 'x' }] }).fanout as { outputs: unknown[] };
    expect(f.outputs).toEqual([{ title: 't' }]);
  });

  it('refuses a fourth output', () => {
    refused(() => hero('fanout', { source: 's', outputs: Array.from({ length: 4 }, () => ({ title: 't' })) }), /fanout\.outputs: at most 3 items/, 3);
  });

  it('reaches crawlers as the source then each output, only with a source and a titled output', () => {
    const h = html(hero('fanout', fanout));
    expect(h.indexOf('Your docs')).toBeLessThan(h.indexOf('Web page — Brand check'));
    expect(h).toContain('<li>Ad — Waits for you</li>');
    expect(h).not.toContain('waiting');
    expect(html(hero('fanout', { outputs: fanout.outputs }))).not.toContain('Web page');
    expect(md({ ...hero('fanout', fanout), visual: 'versus' })).not.toContain('Web page');
  });
});

describe('P5 phone', () => {
  const phone = {
    label: 'A lock screen at 7:30',
    time: '7:30',
    day: 'Wednesday',
    notes: [
      { title: 'Contact form', time: '9:02 pm', text: 'New message from Sam.' },
      { title: 'Writer agent', time: '9:04 pm', text: 'Drafted a reply in your voice.' },
    ],
    reply: { title: 'Waiting for you', time: 'now', text: 'Reply to Sam is ready.', primary: 'Send', secondary: 'Edit' },
  };

  it('accepts an authored lock screen as written; closed at every depth', () => {
    expect(hero('phone', phone).phone).toEqual(phone);
    const p = hero('phone', { ...phone, reply: { ...phone.reply, url: 'https://x.test' }, wallpaper: 'tok' }).phone as Record<string, unknown>;
    expect('wallpaper' in p).toBe(false);
    expect(p.reply).toEqual(phone.reply);
  });

  it('refuses a fifth notification and caps the clock', () => {
    refused(() => hero('phone', { notes: Array.from({ length: 5 }, () => ({ text: 't' })) }), /phone\.notes: at most 4 items/, 4);
    expect((hero('phone', { ...phone, time: '12:34:56 pm UTC' }).phone as { time: string }).time).toHaveLength(12);
  });

  it('reaches crawlers in order: time, notifications, the reply and its choices', () => {
    const h = html(hero('phone', phone));
    const order = ['7:30 · Wednesday', 'Contact form · 9:02 pm — New message from Sam.', 'Writer agent', 'Waiting for you · now', 'Reply to Sam is ready.', 'Send · Edit'];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html(hero('phone', { time: '7:30', notes: [{ title: 'no text' }] }))).not.toContain('7:30');
    expect(md(hero('phone', { reply: { text: 'Only a reply' } }))).toContain('Only a reply');
  });
});

describe('P6 wall', () => {
  const wall = {
    label: 'Two workspaces with a wall between them',
    spaces: [
      { title: 'Workspace · Your app', members: 3, docs: [{ label: 'Price list' }, { label: 'Voice guide' }] },
      { title: 'Workspace · A client', members: 2, docs: [{ label: 'Brand kit' }] },
    ],
  };

  it('accepts two authored workspaces; members is a whole count, capped', () => {
    expect(hero('wall', wall).wall).toEqual(wall);
    const w = hero('wall', { spaces: [{ title: 'a', members: 40 }, { title: 'b', members: 1.5 }, ] }).wall as { spaces: Array<Record<string, unknown>> };
    expect(w.spaces.map((s) => s.members)).toEqual([6, undefined]);
  });

  it('refuses a third workspace and a fifth document', () => {
    refused(() => hero('wall', { spaces: [...wall.spaces, { title: 'c' }] }), /wall\.spaces: at most 2 items/, 2);
    refused(() => hero('wall', { spaces: [{ title: 'a', docs: Array.from({ length: 5 }, () => ({ label: 'd' })) }] }), /wall\.spaces\.docs: at most 4 items/, 4);
  });

  it('reaches crawlers space by space, only with both named', () => {
    const h = html(hero('wall', wall));
    const order = ['Workspace · Your app', 'Price list', 'Voice guide', 'Workspace · A client', 'Brand kit'];
    const at = order.map((s) => h.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The whole figure, so the member count cannot leak in any spelling.
    expect(/<figure>[\s\S]*?<\/figure>/.exec(h)?.[0]).toBe('<figure>\n<figcaption>Two workspaces with a wall between them</figcaption>\n<p><strong>Workspace · Your app</strong></p>\n<ul><li>Price list</li><li>Voice guide</li></ul>\n<p><strong>Workspace · A client</strong></p>\n<ul><li>Brand kit</li></ul>\n</figure>');
    expect(html(hero('wall', { spaces: [wall.spaces[0]] }))).not.toContain('Price list');
  });

  it('the member count follows the base on an overlay write', () => {
    const o = restoreItemStates(hero('wall', wall), { wall: { spaces: [{ ...wall.spaces[0], members: 9 }, { ...wall.spaces[1], members: 'deux' }] } });
    expect((o.wall as { spaces: Array<{ members?: unknown }> }).spaces.map((s) => s.members)).toEqual([3, 2]);
  });
});

describe('P7 tally', () => {
  const tally = {
    label: 'What works today',
    items: [
      { value: '11', label: 'Works today', state: 'done' },
      { value: '4', label: 'Partly there', fill: 0.36, state: 'partial' },
      { value: '5', label: 'Not yet', fill: 0.45, state: 'none' },
    ],
  };

  it('accepts authored cards; the fill is a clamped fraction and a junk state drops', () => {
    expect(hero('tally', tally).tally).toEqual(tally);
    const t = hero('tally', { items: [{ value: '1', label: 'a', fill: 3, state: 'amber' }, { value: '2', label: 'b', fill: '40%' }] }).tally as { items: unknown[] };
    expect(t.items).toEqual([{ value: '1', label: 'a', fill: 1 }, { value: '2', label: 'b' }]);
  });

  it('refuses a fifth card', () => {
    refused(() => hero('tally', { items: Array.from({ length: 5 }, () => ({ value: '1', label: 'a' })) }), /tally\.items: at most 4 items/, 4);
  });

  it('reaches crawlers as "value — label", only with a complete card', () => {
    const h = html(hero('tally', tally));
    expect(h).toContain('<ul><li>11 — Works today</li><li>4 — Partly there</li><li>5 — Not yet</li></ul>');
    expect(h).not.toContain('0.36');
    expect(html(hero('tally', { label: 'Only a caption', items: [{ value: '1' }] }))).not.toContain('Only a caption');
  });

  it('a fill and a state follow the base on an overlay write', () => {
    const o = restoreItemStates(hero('tally', tally), { tally: { items: tally.items.map((c) => ({ ...c, fill: '36 %', state: 'partiel' })) } });
    const items = (o.tally as { items: Array<{ fill?: unknown; state?: unknown }> }).items;
    expect(items.map((c) => [c.fill, c.state])).toEqual([[undefined, 'done'], [0.36, 'partial'], [0.45, 'none']]);
  });
});
