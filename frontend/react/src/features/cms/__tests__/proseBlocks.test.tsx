/**
 * ADR 0813 — the CMS prose block grammar (`### ` subheading, `- ` / `1. ` lists,
 * `> ` quote). KEEP IN LOCKSTEP with the backend prerender cases in
 * `backend/typescript/test/adr0384-section-html.test.ts` ("ADR 0813 sectionHtml
 * — prose blocks"): the SPA and the crawler HTML must agree on what a block is.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { parseProseBlocks } from '../proseBlocks.js';
import { RenderSection } from '../SectionRenderer.js';

afterEach(cleanup);

describe('parseProseBlocks', () => {
  it('classifies subheadings, both list kinds, quotes and paragraphs', () => {
    expect(parseProseBlocks('Intro.\n\n### Sub\n\n- a\n- b\n\n1. x\n2) y\n\n> q1\n> q2\n\nEnd.')).toEqual([
      { kind: 'p', text: 'Intro.' },
      { kind: 'h3', text: 'Sub' },
      { kind: 'ul', items: ['a', 'b'] },
      { kind: 'ol', items: ['x', 'y'] },
      { kind: 'quote', text: 'q1 q2' },
      { kind: 'p', text: 'End.' },
    ]);
  });

  it('a block is a list only when EVERY line is an item; a `###` only when it stands alone', () => {
    expect(parseProseBlocks('- item\nnot an item')).toEqual([{ kind: 'p', text: '- item\nnot an item' }]);
    expect(parseProseBlocks('### head\nand more')).toEqual([{ kind: 'p', text: '### head\nand more' }]);
    expect(parseProseBlocks('*emphasis* opens a paragraph')).toEqual([{ kind: 'p', text: '*emphasis* opens a paragraph' }]);
  });
});

describe('richText public render (ADR 0813)', () => {
  it('draws lists, subheadings and quotes with inline formatting, and no raw HTML', () => {
    const { container } = render(
      <MemoryRouter>
        <RenderSection
          section={{ sectionId: 's1', type: 'richText', data: { text: '### Sub <b>x</b>\n\n- **one**\n- [two](https://example.com)\n\n1. first\n\n> quoted' } }}
          mode="public"
        />
      </MemoryRouter>,
    );
    expect(container.querySelector('h3.cms-prose-h3')?.textContent).toBe('Sub <b>x</b>');
    expect(container.querySelectorAll('ul.cms-prose-list li')).toHaveLength(2);
    expect(container.querySelector('ul.cms-prose-list strong')?.textContent).toBe('one');
    expect(container.querySelector('ul.cms-prose-list a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('ol.cms-prose-list li')?.textContent).toBe('first');
    expect(container.querySelector('blockquote.cms-prose-quote')?.textContent).toBe('quoted');
    expect(container.querySelector('b')).toBeNull();
  });
});
