/** ADR 0768 follow-up C6 — the phone subline states only what is known. */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TabSubline } from '../TabSession.js';

describe('TabSubline', () => {
  it('joins agent, model and cost', () => {
    const { container } = render(<TabSubline agent="Iris" model="claude-opus-5-5" costUsd={0.21} />);
    expect(container.textContent).toBe('Iris · claude-opus-5-5 · $0.2100');
  });

  it('leaves out a cost that is zero, and never prints a placeholder', () => {
    const { container } = render(<TabSubline agent="Iris" model="claude-opus-5-5" costUsd={0} />);
    expect(container.textContent).toBe('Iris · claude-opus-5-5');
  });

  it('leaves the model out when none is in force (the composer says "not chosen")', () => {
    const { container } = render(<TabSubline agent="OpenWOP Assistant" costUsd={0} />);
    expect(container.textContent).toBe('OpenWOP Assistant');
  });

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<TabSubline costUsd={0} />);
    expect(container.firstChild).toBeNull();
  });
});
