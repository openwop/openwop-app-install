/**
 * ADR 1060 — the illustrated hero visuals, as a visitor and an editor meet them.
 * Guards:
 * - each visual is a figure named by its caption (or a stock name) holding the
 *   authored words as real text; decoration is `aria-hidden`; a visual with too
 *   little to show renders nothing (the crawler text's rule);
 * - the editor builds each visual's fields from the spec: inputs carry the
 *   server's caps, Add stops at a list's cap, and styling fields are offered
 *   on the base layer only;
 * - the CSS (which jsdom cannot run): every animation sits inside the ADR 1038
 *   guard (any `@media` carrying `prefers-reduced-motion: no-preference`, with
 *   or without `screen and`) and honours `motion: 'none'`; outside it nothing is
 *   hidden or moved (the static picture is complete); no inline-axis physical
 *   property, so RTL mirrors; no fixed width wider than a phone; every looping
 *   visual (apps, versus, fanout, phone, wall) shows its pause button only on the
 *   motion path and pauses on the button, hover and focus; forced colours keep
 *   the drawn parts.
 * The scan runs from the ADR 1060 header to the end of global.css (bounding it is
 * human ask TST-GLC-H1).
 *
 * Ceiling: layout and motion are CSS. Sabotage-witnessed (wave 90, 2026-11-06),
 * each turning a case red: rendering a ninth line, a fourth app row or an
 * unpriced line; an un-hidden slot; a choice as a real button; one app looping
 * or a pause that does not pause; an absent fill drawn empty; the editor's cap,
 * Add limit, base-only rule or fill scale broken; any ADR 1060 visual missing
 * from the picker; an animation without `motion: none` or outside the guard, the
 * guard removed or flipped to `reduce`; something hidden outside it; a physical
 * `left`; a broken forced-colours or RTL rule; a loop's hover pause removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import { SectionFields } from '../SectionsEditor.js';

afterEach(cleanup);

const view = (data: Record<string, unknown>) =>
  render(<MemoryRouter><RenderSection section={{ sectionId: 's', type: 'hero', data: { heading: 'H', ...data } }} mode="public" /></MemoryRouter>);
type OnChange = Mock<(data: Record<string, unknown>) => void>;
const edit = (data: Record<string, unknown>, baseData?: Record<string, unknown>): OnChange => {
  const onChange: OnChange = vi.fn();
  render(<SectionFields section={{ sectionId: 's', type: 'hero', data: { heading: 'H', ...data } }} assets={[]} onChange={onChange} {...(baseData ? { baseData } : {})} />);
  return onChange;
};
/** The section data the editor last wrote. */
const lastData = (onChange: OnChange): Record<string, unknown> => {
  const call = onChange.mock.lastCall;
  if (!call) throw new Error('the editor wrote nothing');
  return call[0];
};

describe('P1 receipt', () => {
  const receipt = {
    label: 'A printed receipt',
    title: 'Your app',
    subtitle: 'One app · receipt',
    lines: [{ label: 'Launch', amount: '$1,000 once' }, { label: 'Usage credits', amount: '$0', state: 'highlight' }, { label: 'No amount yet' }],
    totalLabel: 'Surprises',
    totalAmount: '0',
    stamp: 'Flat',
  };

  it('is a named figure of priced lines in a description list; the slot is decoration', () => {
    const { container } = view({ visual: 'receipt', receipt });
    const fig = screen.getByRole('figure', { name: 'A printed receipt' });
    expect(container.querySelector('section')!.className).toContain('fp-hero--receipt');
    const rows = [...fig.querySelectorAll('dl > div')];
    expect(rows.map((r) => [r.querySelector('dt')?.textContent, r.querySelector('dd')?.textContent])).toEqual([['Launch', '$1,000 once'], ['Usage credits', '$0']]);
    expect(rows[1]!.className).toContain('fp-receipt__line--highlight');
    expect(fig.textContent).toContain('Your app');
    expect(fig.querySelector('.fp-receipt__total')?.textContent).toBe('Surprises0');
    expect(fig.querySelector('.fp-receipt__stamp')?.textContent).toBe('Flat');
    expect(fig.querySelector('.fp-receipt__slot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('takes a stock name without a caption, and draws nothing without a priced line', () => {
    view({ visual: 'receipt', receipt: { lines: receipt.lines } });
    expect(screen.getByRole('figure', { name: 'Receipt' })).toBeTruthy();
    cleanup();
    const { container } = view({ visual: 'receipt', receipt: { title: 'Your app', lines: [{ label: 'x' }] } });
    expect(container.querySelector('.fp-receipt')).toBeNull();
  });

  it('caps the lines at eight on render (an overlay is not re-validated)', () => {
    const { container } = view({ visual: 'receipt', receipt: { lines: Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, amount: '1' })) } });
    expect(container.querySelectorAll('.fp-receipt dl > div')).toHaveLength(8);
  });

  it('edits from the spec: capped inputs, Add stops at eight, the style is base-only', () => {
    const onChange = edit({ visual: 'receipt', receipt: { lines: [{ label: 'a', amount: '1' }] } });
    expect(screen.getByRole('textbox', { name: 'Title' }).getAttribute('maxlength')).toBe('40');
    fireEvent.change(screen.getByRole('textbox', { name: 'Line 1: Amount' }), { target: { value: '$2' } });
    expect(lastData(onChange).receipt).toEqual({ lines: [{ label: 'a', amount: '$2' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }));
    expect(lastData(onChange).receipt).toEqual({ lines: [{ label: 'a', amount: '1' }, {}] });
    expect(screen.getByRole('combobox', { name: 'Line 1: Style' })).toBeTruthy();
    cleanup();
    edit({ visual: 'receipt', receipt: { lines: Array.from({ length: 8 }, () => ({ label: 'a', amount: '1' })) } });
    expect(screen.queryByRole('button', { name: 'Add a line' })).toBeNull();
    expect(screen.getByText('This list is full (8 at most).')).toBeTruthy();
    cleanup();
    edit({ visual: 'receipt', receipt: { lines: [{ label: 'a', amount: '1' }] } }, { heading: 'H' });
    expect(screen.queryByRole('combobox', { name: 'Line 1: Style' })).toBeNull();
  });

  it('is offered in the visual picker', () => {
    // Every ADR 1060 visual, pinned here (not read from the spec). `log` is ADR 1064's (logGauge).
    for (const visual of ['receipt', 'apps', 'versus', 'fanout', 'phone', 'wall', 'tally']) {
      cleanup();
      const onChange = edit({ visual: 'workflow' });
      fireEvent.change(screen.getByDisplayValue(/Workflow/), { target: { value: visual } });
      expect(lastData(onChange).visual, visual).toBe(visual);
    }
  });
});

describe('P2 apps', () => {
  const apps = {
    label: 'The same app for three clients',
    chip: 'Powered by your agency',
    items: [
      { name: 'Client one', address: 'app.one.example', accent: 'info', heading: 'The newsletter', rows: [{ text: 'Draft ready', status: 'Waits for you', state: 'waiting' }, { text: 'Cleaned', status: 'Done', state: 'done' }, { text: 'c' }, { text: 'a fourth row from an overlay' }] },
      { name: 'Client two', accent: 'mauve' },
      { heading: 'no name yet' },
    ],
  };

  it('is a named figure listing each named app as real text, with its accent and row states as classes', () => {
    view({ visual: 'apps', apps });
    const fig = screen.getByRole('figure', { name: 'The same app for three clients' });
    const list = fig.querySelectorAll('.fp-apps__stack > li');
    expect(list).toHaveLength(2);
    expect(list[0]!.className).toContain('fp-apps__app--info');
    // An unknown accent falls back to the brand accent.
    expect(list[1]!.className).toContain('fp-apps__app--accent');
    expect(list[0]!.querySelector('.fp-apps__name')?.textContent).toBe('Client one');
    expect(list[0]!.querySelector('.fp-apps__address')?.textContent).toBe('app.one.example');
    const rows = [...list[0]!.querySelectorAll('.fp-apps__row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.className).toContain('fp-apps__row--waiting');
    expect(rows[0]!.textContent).toBe('Draft readyWaits for you');
    expect(fig.querySelector('.fp-apps__chip')?.textContent).toBe('Powered by your agency');
    expect(fig.querySelector('.fp-apps__side')?.getAttribute('aria-hidden')).toBe('true');
    expect(fig.querySelector('.fp-apps__mark')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('loops two or more apps with a pause button that says what it will do; one app does not loop', () => {
    view({ visual: 'apps', apps });
    const fig = screen.getByRole('figure', { name: 'The same app for three clients' });
    expect(fig.className).toContain('fp-apps--loop');
    const btn = screen.getByRole('button', { name: 'Pause the animation' });
    fireEvent.click(btn);
    expect(fig.className).toContain('is-paused');
    expect(screen.getByRole('button', { name: 'Play the animation' })).toBeTruthy();
    cleanup();
    view({ visual: 'apps', apps: { items: [{ name: 'Solo' }] } });
    expect(screen.getByRole('figure', { name: 'The same app for each client' }).className).not.toContain('fp-apps--loop');
    expect(screen.queryByRole('button', { name: 'Pause the animation' })).toBeNull();
  });

  it('edits nested lists from the spec; accents and row states are base-only', () => {
    const onChange = edit({ visual: 'apps', apps: { items: [{ name: 'A', rows: [{ text: 'r' }] }] } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Row 1: Status word' }), { target: { value: 'Done' } });
    expect(lastData(onChange).apps).toEqual({ items: [{ name: 'A', rows: [{ text: 'r', status: 'Done' }] }] });
    fireEvent.change(screen.getByRole('combobox', { name: 'App 1: Accent colour' }), { target: { value: 'success' } });
    expect(lastData(onChange).apps).toEqual({ items: [{ name: 'A', rows: [{ text: 'r' }], accent: 'success' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Add an app' }));
    expect(lastData(onChange).apps).toEqual({ items: [{ name: 'A', rows: [{ text: 'r' }] }, {}] });
    cleanup();
    edit({ visual: 'apps', apps: { items: [{ name: 'A', rows: [{ text: 'r' }] }] } }, { heading: 'H' });
    expect(screen.queryByRole('combobox', { name: 'App 1: Accent colour' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Row 1: Style' })).toBeNull();
  });
});

describe('P3 versus', () => {
  const versus = {
    label: 'Five tools against one app',
    divider: 'vs',
    before: { label: 'Five bills', items: [{ label: 'Logins' }, { label: 'Billing' }, {}] },
    after: { label: 'One app', items: [{ label: 'Sign-in' }, { label: 'Billing' }] },
  };

  it('is a named figure: two real lists, the divider as text, the wires as decoration', () => {
    const { container } = view({ visual: 'versus', versus });
    const fig = screen.getByRole('figure', { name: 'Five tools against one app' });
    expect(container.querySelector('section')!.className).toContain('fp-hero--versus');
    expect([...fig.querySelectorAll('.fp-versus__chips > li')].map((li) => li.textContent)).toEqual(['Logins', 'Billing']);
    expect([...fig.querySelectorAll('.fp-versus__tiles > li')].map((li) => li.textContent)).toEqual(['Sign-in', 'Billing']);
    expect(fig.querySelector('.fp-versus__vs')?.textContent).toBe('vs');
    expect(fig.querySelector('.fp-versus__wires')?.getAttribute('aria-hidden')).toBe('true');
    expect([...fig.querySelectorAll('.fp-versus__label')].map((p) => p.textContent)).toEqual(['Five bills', 'One app']);
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('draws nothing without an item on each side', () => {
    const { container } = view({ visual: 'versus', versus: { ...versus, after: { label: 'One app' } } });
    expect(container.querySelector('.fp-versus')).toBeNull();
  });

  it('edits each side as a group: its shown label and its items', () => {
    const onChange = edit({ visual: 'versus', versus });
    expect(screen.getByRole('group', { name: 'Before: the tangle' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Tile 2: Label' }), { target: { value: 'Agents' } });
    expect(lastData(onChange).versus).toEqual({ ...versus, after: { label: 'One app', items: [{ label: 'Sign-in' }, { label: 'Agents' }] } });
    expect(screen.getAllByRole('textbox', { name: 'Label' })).toHaveLength(2);
  });
});

describe('P4 fanout', () => {
  const fanout = {
    label: 'Docs become a page, an email and an ad',
    source: 'Your docs',
    outputs: [{ title: 'Web page', check: 'Brand check', state: 'done' }, { title: 'Launch email', check: 'Brand check' }, { title: 'Ad', status: 'Waits for you', state: 'waiting' }],
  };

  it('is a named figure: the source, then a list of outputs with their checks and status words', () => {
    view({ visual: 'fanout', fanout });
    const fig = screen.getByRole('figure', { name: 'Docs become a page, an email and an ad' });
    expect(fig.querySelector('.fp-fanout__source')?.textContent).toBe('Your docs');
    const outs = [...fig.querySelectorAll('.fp-fanout__outputs > li')];
    expect(outs.map((o) => o.textContent)).toEqual(['Web pageBrand check', 'Launch emailBrand check', 'AdWaits for you']);
    expect(outs[0]!.className).toContain('fp-fanout__output--done');
    // Only the waiting output gets the sweep; meters, lines and the sweep are decoration.
    expect(fig.querySelectorAll('.fp-fanout__scan')).toHaveLength(1);
    expect(outs[2]!.querySelector('.fp-fanout__scan')).toBeTruthy();
    for (const el of fig.querySelectorAll('.fp-fanout__scan, .fp-fanout__meter, .fp-fanout__lines, .fp-fanout__wire')) expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('draws nothing without a source', () => {
    const { container } = view({ visual: 'fanout', fanout: { outputs: fanout.outputs } });
    expect(container.querySelector('.fp-fanout')).toBeNull();
  });

  it('edits the outputs from the spec, the state base-only', () => {
    const onChange = edit({ visual: 'fanout', fanout });
    fireEvent.change(screen.getByRole('textbox', { name: 'Output 3: Status word' }), { target: { value: 'Ready' } });
    expect(lastData(onChange).fanout).toEqual({ ...fanout, outputs: [fanout.outputs[0], fanout.outputs[1], { title: 'Ad', status: 'Ready', state: 'waiting' }] });
    expect(screen.queryByRole('button', { name: 'Add an output' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Output 1: Style' })).toBeTruthy();
  });
});

describe('P5 phone', () => {
  const phone = {
    label: 'A lock screen at 7:30',
    time: '7:30',
    day: 'Wednesday',
    notes: [{ title: 'Contact form', time: '9:02 pm', text: 'New message.' }, { title: 'No text yet' }],
    reply: { title: 'Waiting for you', time: 'now', text: 'Reply is ready.', primary: 'Send', secondary: 'Edit' },
  };

  it('is a named figure: the time, then an ordered list of notifications ending with the reply', () => {
    view({ visual: 'phone', phone });
    const fig = screen.getByRole('figure', { name: 'A lock screen at 7:30' });
    expect(fig.querySelector('.fp-phone__clock')?.textContent).toBe('7:30');
    const notes = [...fig.querySelectorAll('ol.fp-phone__notes > li')];
    expect(notes.map((n) => n.textContent)).toEqual(['Contact form9:02 pmNew message.', 'Waiting for younowReply is ready.SendEdit']);
    expect(notes[1]!.className).toContain('fp-phone__note--reply');
    // The choices are inert text, never controls.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('draws nothing without a notification text or a reply', () => {
    const { container } = view({ visual: 'phone', phone: { time: '7:30', notes: [{ title: 'x' }] } });
    expect(container.querySelector('.fp-phone')).toBeNull();
  });

  it('edits the notifications and the reply group from the spec', () => {
    const onChange = edit({ visual: 'phone', phone });
    expect(screen.getByRole('group', { name: 'The notification that waits for you' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'First choice (e.g. Send)' }), { target: { value: 'Approve' } });
    expect(lastData(onChange).phone).toEqual({ ...phone, reply: { ...phone.reply, primary: 'Approve' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a notification' }));
    expect(lastData(onChange).phone).toEqual({ ...phone, notes: [...phone.notes, {}] });
  });
});

describe('P6 wall', () => {
  const wall = {
    label: 'Two workspaces with a wall between them',
    spaces: [{ title: 'Your app', members: 3, docs: [{ label: 'Price list' }, {}] }, { title: 'A client', docs: [{ label: 'Brand kit' }] }],
  };

  it('is a named figure: two real lists of documents, members and the wall as decoration', () => {
    view({ visual: 'wall', wall });
    const fig = screen.getByRole('figure', { name: 'Two workspaces with a wall between them' });
    const spaces = [...fig.querySelectorAll('.fp-wall__spaces > li')];
    expect(spaces.map((s) => s.querySelector('.fp-wall__title')?.textContent)).toEqual(['Your app', 'A client']);
    expect([...spaces[0]!.querySelectorAll('.fp-wall__docs > li')].map((d) => d.textContent)).toEqual(['Price list']);
    expect(spaces[0]!.querySelectorAll('.fp-wall__who i')).toHaveLength(3);
    expect(spaces[1]!.querySelector('.fp-wall__who')).toBeNull();
    for (const el of fig.querySelectorAll('.fp-wall__who, .fp-wall__wall, .fp-wall__bounce, .fp-wall__lock')) expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Pause the animation' })).toBeTruthy();
  });

  it('draws nothing with fewer than two named workspaces', () => {
    const { container } = view({ visual: 'wall', wall: { spaces: [wall.spaces[0], { docs: [] }] } });
    expect(container.querySelector('.fp-wall')).toBeNull();
  });

  it('edits members as a whole number on the base layer only, and stops at two workspaces', () => {
    const onChange = edit({ visual: 'wall', wall });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Workspace 2: People shown (dots)' }), { target: { value: '4' } });
    expect(lastData(onChange).wall).toEqual({ ...wall, spaces: [wall.spaces[0], { ...wall.spaces[1], members: 4 }] });
    expect(screen.queryByRole('button', { name: 'Add a workspace' })).toBeNull();
    cleanup();
    edit({ visual: 'wall', wall }, { heading: 'H' });
    expect(screen.queryByRole('spinbutton', { name: 'Workspace 2: People shown (dots)' })).toBeNull();
  });
});

describe('P7 tally', () => {
  const tally = { label: 'What works today', items: [{ value: '11', label: 'Works today', state: 'done' }, { value: '4', label: 'Partly there', fill: 0.36, state: 'partial' }, { value: '5' }] };

  it('is a named figure: a list of numbers with their labels; the bars are decoration', () => {
    const { container } = view({ visual: 'tally', tally });
    expect(container.querySelector('section')!.className).toContain('fp-hero--tally');
    const fig = screen.getByRole('figure', { name: 'What works today' });
    const cards = [...fig.querySelectorAll('.fp-tally__cards > li')];
    expect(cards.map((c) => c.textContent)).toEqual(['11Works today', '4Partly there']);
    expect(cards[1]!.className).toContain('fp-tally__card--partial');
    const bars = [...fig.querySelectorAll<HTMLElement>('.fp-tally__bar')];
    expect(bars.every((b) => b.getAttribute('aria-hidden') === 'true')).toBe(true);
    // An absent fill is a full bar.
    expect(bars.map((b) => (b.firstElementChild as HTMLElement).style.inlineSize)).toEqual(['100%', '36%']);
    // One-shot motion: no pause button.
    expect(screen.queryByRole('button', { name: 'Pause the animation' })).toBeNull();
  });

  it('edits the fill as a whole percentage on the base layer', () => {
    const onChange = edit({ visual: 'tally', tally });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Card 2: Bar fill (%)' }), { target: { value: '50' } });
    expect(lastData(onChange).tally).toEqual({ ...tally, items: [tally.items[0], { ...tally.items[1], fill: 0.5 }, tally.items[2]] });
    expect(screen.getAllByRole('option', { name: 'Not yet' })).toHaveLength(3);
  });
});

describe('the ADR 1060 CSS', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  const block = css.slice(css.indexOf('/* ── ADR 1060 — illustrated hero visuals'));
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
  /** Top-level statements: [prelude, body]. */
  const statements = (src: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    let depth = 0, start = 0, open = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '{') { if (depth === 0) open = i; depth++; }
      else if (src[i] === '}') { depth--; if (depth === 0) { out.push([src.slice(start, open).trim(), src.slice(open + 1, i)]); start = i + 1; } }
    }
    return out;
  };
  const top = statements(code);
  /** The ADR 1038 guard, with or without `screen and` (wave 90 ruling; wave 88 flowVisual precedent). */
  const isMotionGuard = (p: string): boolean => /^@media\b[^{]*\(prefers-reduced-motion:\s*no-preference\)/.test(p);

  it('is present', () => {
    expect(block.length).toBeGreaterThan(100);
    expect(top.some(([p]) => isMotionGuard(p))).toBe(true);
  });

  it('animates only inside the ADR 1038 guard, and every guarded rule honours motion none', () => {
    for (const [prelude, body] of top) {
      if (prelude.startsWith('@keyframes')) continue;
      if (isMotionGuard(prelude)) {
        for (const [sel] of statements(body)) {
          // Top-level commas only (`:is(a, b)` is one selector).
          for (const s of sel.split(/,(?![^(]*\))/)) {
            expect(s.trim(), s).toMatch(/^:root(\[dir="rtl"\])?:not\(\[data-reduce-motion="reduce"\]\) /);
            expect(s, s).toContain(':not(.fp-motion--none)');
          }
        }
        continue;
      }
      expect(`${prelude}{${body}}`, prelude).not.toMatch(/animation(-name)?\s*:/);
    }
  });

  it('hides and moves nothing outside the guard, so the static picture is complete', () => {
    for (const [prelude, body] of top) {
      if (isMotionGuard(prelude) || prelude.startsWith('@keyframes')) continue;
      expect(body, prelude).not.toMatch(/opacity:\s*0(?![.\d])|visibility:\s*hidden|translate[XY]?\(\s*-?100%/);
    }
  });

  it('uses logical properties only (RTL mirrors), and no fixed width wider than a phone', () => {
    expect(code).not.toMatch(/(^|[;{\s])(left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/m);
    expect(code).not.toMatch(/text-align:\s*(left|right)/);
    // Declarations only: a media query's `(min-width: 900px)` is a breakpoint, not a width.
    expect(code.replace(/@media[^{]*\{/g, '')).not.toMatch(/(?<![-\w(])(inline-size|width|min-inline-size|min-width)\s*:\s*(3[6-9]\d|[4-9]\d\d|\d{4,})px/);
  });

  it('hides the pause button off the motion path, and pauses on the button, hover and focus', () => {
    const rule = top.find(([p]) => p === '.fp-art__toggle');
    expect(rule?.[1]).toContain('display: none');
    const guarded = top.filter(([p]) => isMotionGuard(p)).map(([, b]) => b).join('');
    expect(guarded).toContain('.fp-apps--loop .fp-art__toggle { display: inline-flex;');
    for (const hook of ['.is-paused', ':hover', ':focus-within']) expect(guarded).toContain(`.fp-apps--loop${hook} .fp-apps__app`);
    // Every looping visual, rule by rule: its toggle shows, and each hook pauses it.
    const rules = top.filter(([p]) => isMotionGuard(p)).flatMap(([, b]) => statements(b))
      .map(([sel, body]) => ({ sels: sel.split(/,(?![^(]*\))/).map((x) => x.trim()), body }));
    for (const v of ['apps', 'versus', 'fanout', 'phone', 'wall']) {
      expect(rules.some((r) => r.sels.some((x) => x.endsWith(`.fp-${v}--loop .fp-art__toggle`)) && r.body.includes('display: inline-flex')), `${v} toggle`).toBe(true);
      for (const hook of ['.is-paused', ':hover', ':focus-within']) {
        expect(rules.some((r) => r.sels.some((x) => x.includes(`.fp-${v}--loop${hook} `)) && r.body.includes('animation-play-state: paused')), `${v}${hook}`).toBe(true);
      }
    }
  });

  it('mirrors direction-bound motion in RTL (fan-in offset, meter origin)', () => {
    expect(code).toContain(':root[dir="rtl"] .fp-fanout { --fp-fan-from: 60px; }');
    expect(code).toContain(':root[dir="rtl"] .fp-fanout__meter > span { transform-origin: right; }');
    expect(code).toMatch(/@keyframes fp-fanout-in \{ 0% \{ opacity: 0; transform: translateX\(var\(--fp-fan-from\)\)/);
  });

  it('mirrors the bounce in RTL', () => {
    expect(code).toContain(':root[dir="rtl"] .fp-wall { --fp-wall-dir: -1; }');
    expect(code).toMatch(/@keyframes fp-wall-bounce \{[^\n]*var\(--fp-wall-dir\)/);
  });

  it('grows the tally bars from the inline start in RTL too', () => {
    expect(code).toContain(':root[dir="rtl"] .fp-tally__bar > span { transform-origin: right; }');
  });

  it('keeps the receipt slot visible in forced colours', () => {
    const forced = top.find(([p, b]) => p === '@media (forced-colors: active)' && b.includes('.fp-receipt__slot'));
    expect(forced?.[1]).toMatch(/\.fp-receipt__slot \{ forced-color-adjust: none; background: CanvasText;/);
  });
});
