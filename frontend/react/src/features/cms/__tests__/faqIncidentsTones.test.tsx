/**
 * ADR 1063 — the P2a public rendering:
 *
 *   - D1 dark mode keeps the band rhythm: under both the system dark scheme and
 *     the manual `theme-dark` class the inverse band is derived DARKER than the
 *     page (a black mix of --paper) and its panels take --paper-2;
 *   - D2 `faq` with `columns: 2` gets the two-column class, `openFirst` opens
 *     only the first answer, and a picture renders under the head (after the
 *     head, before the questions);
 *   - D3 `columns` `incidents` renders an ordered list of cards, each with the
 *     time first (from `eyebrow`) and the sentence, in authored order.
 *
 * D1 finds the override by its declarations and checks the blocks open around
 * it with a brace walk (comments blanked), so a reformat is not a false red and
 * a block moved under another query is caught.
 *
 * Red when (sabotage-witnessed, w91 g2): either dark block's bg or panel loses
 * its override, the dark media turns into another query, the FAQ class
 * inverts, openFirst opens every item or ignores the flag, the picture moves
 * above the head or loses its alt, the incidents branch falls through to the
 * cards layout, the order reverses, the time drops, or the sentence loses its
 * inline markdown.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RenderSection } from '../SectionRenderer.js';
import type { Section } from '../cmsClient.js';

afterEach(cleanup);

function renderSection(section: Section): HTMLElement {
  const { container } = render(<MemoryRouter><RenderSection section={section} mode="public" /></MemoryRouter>);
  return container;
}

/** The one element matching `sel`, narrowed without a cast (a miss is a named failure). */
function el<T extends Element>(root: ParentNode, sel: string, ctor: new () => T): T {
  const e = root.querySelector(sel);
  if (!(e instanceof ctor)) throw new Error(`missing ${sel}`);
  return e;
}
function all<T extends Element>(root: ParentNode, sel: string, ctor: new () => T): T[] {
  return [...root.querySelectorAll(sel)].filter((e): e is T => e instanceof ctor);
}

/** The block preludes still open at `index` (comments blanked to keep offsets). */
function openAt(text: string, index: number): string[] {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < index; i++) {
    if (s[i] === '{') { stack.push(s.slice(start, i).trim()); start = i + 1; }
    else if (s[i] === '}') { stack.pop(); start = i + 1; }
    else if (s[i] === ';') start = i + 1;
  }
  return stack;
}

describe('dark-mode band rhythm (D1)', () => {
  const css = readFileSync(join(__dirname, '..', '..', '..', 'styles', 'global.css'), 'utf8');
  it('derives the inverse band darker than the page under both dark selectors', () => {
    const override = /--tone-inverse-bg:\s*color-mix\(in oklab, var\(--paper\) 58%, black\);\s*--tone-inverse-panel:\s*var\(--paper-2\);/g;
    const blocks = [...css.matchAll(override)].map((m) => openAt(css, m.index ?? -1));
    // Exactly the system dark scheme (not a print or width query) and the manual class.
    expect(blocks).toEqual([
      ['@media (prefers-color-scheme: dark)', ':root:not(.theme-light)'],
      [':root.theme-dark'],
    ]);
  });
});

describe('faq columns, openFirst and picture (D2)', () => {
  const faq = (data: Record<string, unknown>): HTMLElement => renderSection({
    sectionId: 'sec:faq', type: 'faq',
    data: { heading: 'Questions', tone: 'default', items: [{ q: 'One?', a: 'A.' }, { q: 'Two?', a: 'B.' }, { q: 'Three?', a: 'C.' }], ...data },
  });

  it('two columns, only the first open, and the picture under the head', () => {
    const c = faq({ columns: 2, openFirst: true, imageToken: 'med_abc', alt: 'Admin overview' });
    const list = el(c, '.fp-faq', HTMLDivElement);
    expect(list.classList.contains('fp-faq--cols2')).toBe(true);
    const items = all(c, 'details.fp-faq__item', HTMLDetailsElement);
    expect(items.map((d) => d.open)).toEqual([true, false, false]);
    const img = el(c, '.fp-faq__shot img', HTMLImageElement);
    expect(img.getAttribute('alt')).toBe('Admin overview');
    // The picture sits between the head and the questions.
    const head = el(c, 'header.fp-head', HTMLElement);
    const shot = el(c, '.fp-faq__shot', HTMLDivElement);
    expect(head.compareDocumentPosition(shot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(shot.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without the options it renders as before', () => {
    const c = faq({});
    expect(c.querySelector('.fp-faq--cols2')).toBeNull();
    expect(c.querySelector('.fp-faq__shot')).toBeNull();
    const items = all(c, 'details', HTMLDetailsElement);
    expect(items).toHaveLength(3);
    expect(items.some((d) => d.open)).toBe(false);
  });
});

describe('columns incidents (D3)', () => {
  it('renders an ordered list of cards, time first', () => {
    const c = renderSection({
      sectionId: 'sec:incidents', type: 'columns',
      data: {
        heading: 'On Tuesday', layout: 'incidents',
        columns: [
          { eyebrow: 'TUE 09:12 · FOLLOW-UP AGENT', text: 'Sent a follow-up to someone who had said no.' },
          { eyebrow: 'TUE 11:40 · BILLING AGENT', text: 'Charged a card **twice**.' },
        ],
      },
    });
    expect(c.querySelector('.fp-cards__grid')).toBeNull();
    const list = el(c, 'ol.fp-incidents__list', HTMLOListElement);
    const items = all(list, ':scope > li.fp-incident', HTMLLIElement);
    expect(items).toHaveLength(2);
    // Authored order is the order they happened in.
    expect(items.map((li) => li.querySelector('.fp-incident__when')?.textContent)).toEqual([
      'TUE 09:12 · FOLLOW-UP AGENT', 'TUE 11:40 · BILLING AGENT',
    ]);
    const body = el(items[1] ?? list, '.fp-incident__body', HTMLDivElement);
    expect([...body.children].map((e) => e.className)).toEqual(['fp-incident__when', 'fp-incident__text']);
    expect(body.querySelector('.fp-incident__text strong')?.textContent).toBe('twice');
  });
});
