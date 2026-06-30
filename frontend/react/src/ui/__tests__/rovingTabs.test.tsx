/**
 * rovingTabs — the shared WAI-ARIA roving keyboard handler for hand-rolled
 * `role="tablist"` surfaces. Verifies arrow/Home/End move focus among the
 * `[role="tab"]` children (manual activation — focus only, no auto-select),
 * wrap at the ends, skip disabled tabs, and ignore non-nav keys.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { handleTablistKeyDown } from '../rovingTabs.js';

function Tabs({ disabledMiddle = false }: { disabledMiddle?: boolean }): JSX.Element {
  return (
    <div role="tablist" onKeyDown={handleTablistKeyDown}>
      <button type="button" role="tab" tabIndex={0}>One</button>
      <button type="button" role="tab" tabIndex={-1} disabled={disabledMiddle}>Two</button>
      <button type="button" role="tab" tabIndex={-1}>Three</button>
    </div>
  );
}

describe('handleTablistKeyDown', () => {
  it('ArrowRight moves focus to the next tab', () => {
    render(<Tabs />);
    const tablist = screen.getByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
  });

  it('ArrowLeft from the first tab wraps to the last', () => {
    render(<Tabs />);
    const tablist = screen.getByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('Home / End jump to the first / last tab', () => {
    render(<Tabs />);
    const tablist = screen.getByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    tabs[1].focus();
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('ignores non-navigation keys', () => {
    render(<Tabs />);
    const tablist = screen.getByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: 'a' });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('skips a disabled tab', () => {
    render(<Tabs disabledMiddle />);
    const tablist = screen.getByRole('tablist');
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' }); // Two is disabled → lands on Three
    expect(document.activeElement).toBe(tabs[2]);
  });
});
