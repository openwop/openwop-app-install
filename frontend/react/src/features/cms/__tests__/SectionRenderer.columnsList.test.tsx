/**
 * ADR 0920 D4 — the `columns` section's `list` layout and its `note` footnote,
 * rendered publicly.
 *
 * Two bugs a live pricing section hit (myndhyve.ai, 2026-11-02):
 *  - the `list` layout dropped each column's `text`, so a "Three ways to start"
 *    block showed titles and bullets but never its prices;
 *  - the columns `note` was printed as plain text, so `[label](/url)` showed as
 *    markdown source instead of a link.
 *
 * Red when: the list layout stops rendering `text`, or the note stops going
 * through `inlineMarkdown` (the link assertion fails and the raw `](` shows).
 * Sabotage-witnessed (w85): dropping the list `text`, rendering it raw, or
 * putting it before the title reds case 1. Rendering an empty text paragraph
 * reds case 2. A plain-text note reds all three footnote cases. Making
 * `inlineMarkdown`'s unsafe fallback a link reds the javascript: case. The
 * javascript: case is the only one here that reds if the note moves to a
 * renderer without the guard. `SectionRenderer.safeHref` covers the guard
 * itself, but only through `richText`.
 *
 * Third bug (myndhyve.ai, 2026-11-05): the `list` branch dropped `future`, so
 * the "Not yet" columns on /p/security, /p/roadmap and /p/campaign-studio
 * looked exactly like the "works" columns. Red when: the list branch stops
 * adding `fp-col--future` or the status class, adds the status class to a
 * list with no future column (pricing would grow dots), or the CSS stops
 * giving future items a hollow marker instead of the filled one. A `partial`
 * column (a roadmap's "partly there", 2026-11-05) gets `fp-col--partial` and
 * an amber half dot, so it neither claims "works" nor reads as "not yet".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

function pricing(layout: string): Section {
  return {
    sectionId: 'sec:pricing',
    type: 'columns',
    data: {
      heading: 'Three ways to start',
      layout,
      columns: [
        { title: 'Run it yourself', text: '**Free.** The code is open source.', items: [{ label: 'Your servers' }] },
        { title: 'We run it', text: '**$299 a month per app.** Hosting and updates.', items: [{ label: 'Email help', meta: 'weekdays' }] },
      ],
      note: "Early prices. [What's included and what isn't](/p/pricing).",
    },
  };
}

function renderSection(section: Section) {
  return render(
    <MemoryRouter>
      <RenderSection section={section} mode="public" />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('columns `list` layout', () => {
  it('renders each column’s text (with inline markdown) between its title and its items', () => {
    const { container } = renderSection(pricing('list'));
    const cols = container.querySelectorAll('.fp-cols--list .fp-col');
    expect(cols).toHaveLength(2);
    const second = cols[1] as HTMLElement;
    const text = second.querySelector('.fp-col__text');
    expect(text?.textContent).toBe('$299 a month per app. Hosting and updates.');
    expect(within(text as HTMLElement).getByText('$299 a month per app.').tagName).toBe('STRONG');
    // Order: title, then text, then the items list.
    const order = [...second.children].map((el) => el.className);
    expect(order).toEqual(['fp-col__title', 'fp-col__text', 'fp-col__items']);
    expect(within(second).getByText('weekdays')).toBeTruthy();
  });

  it('omits the text paragraph when a column has none', () => {
    const s = pricing('list');
    (s.data.columns as Array<Record<string, unknown>>)[0]!.text = '';
    const { container } = renderSection(s);
    const first = container.querySelectorAll('.fp-cols--list .fp-col')[0] as HTMLElement;
    expect(first.querySelector('.fp-col__text')).toBeNull();
  });
});

describe('columns footnote', () => {
  for (const layout of ['list', 'cards', 'ruled']) {
    it(`renders a markdown link in the note as a link (${layout})`, () => {
      const { container } = renderSection(pricing(layout));
      const note = container.querySelector('.fp-cols__note') as HTMLElement;
      expect(note.textContent).not.toContain('](');
      const link = within(note).getByRole('link', { name: "What's included and what isn't" });
      expect(link.getAttribute('href')).toBe('/p/pricing');
    });
  }

  it('keeps the unsafe-link guard: a javascript: URL in the note degrades to plain text', () => {
    const s = pricing('list');
    s.data.note = 'See [this](javascript:void0).';
    const { container } = renderSection(s);
    const note = container.querySelector('.fp-cols__note') as HTMLElement;
    expect(within(note).queryByRole('link')).toBeNull();
    expect(note.textContent).toBe('See this.');
  });
});

describe('columns `list` layout with a `future` column', () => {
  function status(): Section {
    return {
      sectionId: 'sec:mh-sec-status',
      type: 'columns',
      data: {
        layout: 'list',
        columns: [
          { title: 'In place', highlight: true, items: [{ label: 'Bring your own key' }] },
          { title: 'Not yet', future: true, items: [{ label: 'An outside security audit' }] },
        ],
      },
    };
  }

  it('marks the future column and makes the section a status list', () => {
    const { container } = renderSection(status());
    const section = container.querySelector('section.fp-cols--list') as HTMLElement;
    expect(section.classList.contains('fp-cols--status')).toBe(true);
    const [works, notYet] = [...section.querySelectorAll('.fp-col')] as HTMLElement[];
    expect(works!.classList.contains('fp-col--future')).toBe(false);
    expect(works!.classList.contains('fp-col--highlight')).toBe(true);
    expect(notYet!.classList.contains('fp-col--future')).toBe(true);
    expect(notYet!.textContent).toContain('An outside security audit');
  });

  it('marks a `partial` column ("partly there") and makes the section a status list', () => {
    const s = status();
    (s.data.columns as Array<Record<string, unknown>>).splice(1, 0, { title: 'Partly there', partial: true, items: [{ label: 'Some channels' }] });
    const { container } = renderSection(s);
    const [works, partly, notYet] = [...container.querySelectorAll('.fp-cols--status .fp-col')] as HTMLElement[];
    expect(works!.className).toBe('fp-col fp-col--highlight');
    expect(partly!.className).toBe('fp-col fp-col--partial');
    expect(notYet!.className).toBe('fp-col fp-col--future');
  });

  it('a list whose only flag is `partial` is still a status list', () => {
    const s = status();
    (s.data.columns as Array<Record<string, unknown>>)[1] = { title: 'Partly there', partial: true, items: [{ label: 'x' }] };
    const { container } = renderSection(s);
    expect(container.querySelector('.fp-cols--status .fp-col--partial')).not.toBeNull();
  });

  it('leaves a list with no future column without status markers', () => {
    const { container } = renderSection(pricing('list'));
    expect(container.querySelector('.fp-cols--status')).toBeNull();
    expect(container.querySelector('.fp-col--future')).toBeNull();
  });

  it('gives future items a hollow marker, not the filled works dot', () => {
    const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
    const rule = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      expect(at, `missing rule ${sel}`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('.fp-cols--status .fp-col__item::before')).toMatch(/background: var\(--color-success\)/);
    const hollow = rule('.fp-cols--status .fp-col--future .fp-col__item::before');
    expect(hollow).toMatch(/background: transparent/);
    expect(hollow).toMatch(/border: 1\.5px solid/);
    expect(rule('.fp-cols--status .fp-col--partial .fp-col__item::before')).toMatch(/var\(--color-warning\) 50%, transparent 50%/);
  });
});
