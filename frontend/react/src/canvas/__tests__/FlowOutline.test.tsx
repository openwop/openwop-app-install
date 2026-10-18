/**
 * FlowOutline tests (ADR 0333 Phase 3 / ADR 0334) — the flow-trait document map:
 * renders a row per heading, indents by level, and scrolls the content ref to
 * the Nth SEMANTIC heading (h1–h6, no coupling to the type's CSS) on click.
 *
 * w46: the content ref is a REAL element holding real headings. Round 1 used a
 * `{ querySelectorAll: () => … } as unknown as HTMLElement` fake that ignored the
 * selector, so the "semantic h1–h6" claim could not fail (w46g2-fo-selector
 * vacuous), and the null-ref case asserted `not.toThrow()`, which cannot see a
 * throw inside a React handler (jsdom reports it instead — w46g2-fo-null).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRef } from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { FlowOutline } from '../FlowOutline.js';

const headings = [
  { id: 'heading-0', text: 'Intro', level: 1 },
  { id: 'heading-2', text: 'Details', level: 2 },
];

// jsdom has no scrollIntoView; install a spy that records WHICH element scrolled.
const scrolled: Element[] = [];
const scrollSpy = vi.fn(function (this: Element, _opts?: boolean | ScrollIntoViewOptions) { scrolled.push(this); });
let original: PropertyDescriptor | undefined;

beforeEach(() => {
  scrolled.length = 0;
  scrollSpy.mockClear();
  original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollSpy, configurable: true, writable: true });
});

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
});

/** Content with a NON-heading first and a classed h3 — only semantic headings count. */
function content(): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = '<p class="heading">Not a heading</p><h1>Intro</h1><div><h3 class="x">Details</h3></div>';
  document.body.appendChild(root);
  return root;
}

describe('FlowOutline', () => {
  it('renders a labelled nav with a row per heading, indented by level', () => {
    const ref = createRef<HTMLElement>();
    render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
    expect(screen.getByRole('navigation', { name: 'Outline' })).toBeTruthy();
    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['Intro', 'Details']);
    expect(rows[0]!.getAttribute('data-level')).toBe('1');
    expect(rows[1]!.getAttribute('data-level')).toBe('2');
  });

  it('scrolls the content ref to the Nth semantic heading on click', () => {
    const root = content();
    try {
      const ref = { current: root };
      render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
      fireEvent.click(screen.getByRole('button', { name: 'Details' }));
      expect(scrollSpy).toHaveBeenCalledOnce();
      expect(scrolled[0]?.tagName).toBe('H3');
      expect(scrolled[0]?.textContent).toBe('Details');
      expect(scrollSpy.mock.calls[0]?.[0]).toMatchObject({ block: 'start' });
    } finally {
      root.remove();
    }
  });

  it('no-ops safely when the content ref is empty', () => {
    const ref = createRef<HTMLElement>();
    const onWinError = vi.fn((e: ErrorEvent) => e.preventDefault());
    window.addEventListener('error', onWinError);
    try {
      render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
      fireEvent.click(screen.getByRole('button', { name: 'Intro' }));
      expect(onWinError).not.toHaveBeenCalled();
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('error', onWinError);
    }
  });
});
