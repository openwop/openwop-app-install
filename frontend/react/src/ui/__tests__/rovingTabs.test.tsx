/**
 * rovingTabs — the shared WAI-ARIA roving keyboard handler for hand-rolled
 * `role="tablist"` surfaces. Verifies arrow/Home/End move focus among the
 * `[role="tab"]` children (manual activation — focus only, no auto-select),
 * wrap at the ends, skip disabled tabs, and ignore non-nav keys.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { handleTablistKeyDown, handleRadiogroupKeyDown } from '../rovingTabs.js';

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

/**
 * KTUX-8 — the radiogroup variant. Unlike a tablist it is SELECTION-FOLLOWS-
 * FOCUS: an arrow moves focus AND selects (fires the radio's onClick). This
 * pattern was duplicated in two hand-rolled star ratings (community + market),
 * both with no arrow keys and 5 tab stops.
 */
function Radios({ onPick }: { onPick: (n: number) => void }): JSX.Element {
  return (
    <div role="radiogroup" onKeyDown={handleRadiogroupKeyDown}>
      {[1, 2, 3].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={false} onClick={() => onPick(n)}>{n}</button>
      ))}
    </div>
  );
}

describe('handleRadiogroupKeyDown', () => {
  it('ArrowRight moves focus to the next radio AND selects it (selection follows focus)', () => {
    const onPick = vi.fn();
    render(<Radios onPick={onPick} />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radios[1]);
    expect(onPick).toHaveBeenCalledWith(2); // the tablist handler would NOT select
  });

  it('ArrowLeft from the first radio wraps to the last and selects it', () => {
    const onPick = vi.fn();
    render(<Radios onPick={onPick} />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radios[2]);
    expect(onPick).toHaveBeenCalledWith(3);
  });

  it('ignores non-navigation keys and does not select', () => {
    const onPick = vi.fn();
    render(<Radios onPick={onPick} />);
    const group = screen.getByRole('radiogroup');
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    fireEvent.keyDown(group, { key: 'x' });
    expect(onPick).not.toHaveBeenCalled();
  });
});
