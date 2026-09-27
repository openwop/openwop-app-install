/**
 * FlowOutline tests (ADR 0333 Phase 3) — the flow-trait document map: renders a
 * row per heading, indents by level, and scrolls the content ref to the Nth
 * semantic heading on click.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { FlowOutline } from '../FlowOutline.js';

afterEach(cleanup);

const headings = [
  { id: 'heading-0', text: 'Intro', level: 1 },
  { id: 'heading-2', text: 'Details', level: 2 },
];

describe('FlowOutline', () => {
  it('renders a labelled nav with a row per heading, indented by level', () => {
    const ref = createRef<HTMLElement>();
    render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
    expect(screen.getByRole('navigation', { name: 'Outline' })).toBeTruthy();
    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['Intro', 'Details']);
    expect(rows[1]!.getAttribute('data-level')).toBe('2');
  });

  it('scrolls the content ref to the Nth heading on click', () => {
    const scrollSpies = [vi.fn(), vi.fn()];
    const fakeContent = {
      querySelectorAll: () => scrollSpies.map((fn) => ({ scrollIntoView: fn })),
    } as unknown as HTMLElement;
    const ref = { current: fakeContent };
    render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
    fireEvent.click(screen.getByText('Details'));
    expect(scrollSpies[1]).toHaveBeenCalledOnce();
    expect(scrollSpies[0]).not.toHaveBeenCalled();
  });

  it('no-ops safely when the content ref is empty', () => {
    const ref = createRef<HTMLElement>();
    render(<FlowOutline headings={headings} contentRef={ref} label="Outline" />);
    expect(() => fireEvent.click(screen.getByText('Intro'))).not.toThrow();
  });
});
