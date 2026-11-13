/**
 * ADR 1110 P2 — the shared Combobox follows the APG combobox pattern (list autocomplete,
 * manual selection) and never lets an older answer replace a newer one.
 *
 * Sabotage, each restored, each red: dropping the sequence guard (stale answer), dropping
 * `aria-activedescendant` (the active-option case), choosing on ArrowDown instead of Enter,
 * rendering a failure as "No matches", opening on focus, showing a page as a total,
 * restoring an emptied optional value.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Combobox, type ComboboxOption } from '../Combobox.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));

afterEach(() => { cleanup(); vi.useRealTimers(); });

const opts = (...names: string[]): ComboboxOption[] => names.map((n) => ({ id: n.toLowerCase(), label: n }));

async function settle(ms = 300): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve(); });
}

describe('Combobox — APG pattern', () => {
  it('wires combobox, listbox and options, and moves the active option with the arrows', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => opts('Apple', 'Apricot'));
    render(<Combobox label="Product" value={null} onChange={() => {}} load={load} />);
    const input = screen.getByRole('combobox', { name: 'Product' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(input);
    await settle();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    const [first, second] = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBeNull(); // manual selection: nothing active yet
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(first?.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(second?.id);
    expect(screen.getByRole('status').textContent).toBe('comboboxResults:2');
  });

  it('chooses with Enter, not with the arrows, and Escape closes', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Combobox label="Product" value={null} onChange={onChange} load={async () => opts('Apple', 'Apricot')} />);
    const input = screen.getByRole('combobox');
    fireEvent.click(input);
    await settle();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled(); // nothing active, nothing chosen
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ id: 'apricot', label: 'Apricot' });
    fireEvent.click(input);
    await settle();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('a pointer press on an option chooses it', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Combobox label="Product" value={null} onChange={onChange} load={async () => opts('Apple', 'Apricot')} />);
    fireEvent.click(screen.getByRole('combobox'));
    await settle();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Apricot' }));
    expect(onChange).toHaveBeenCalledWith({ id: 'apricot', label: 'Apricot' });
  });

  it('searches with what was typed, after the pause', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (_query: string) => opts('Apple'));
    render(<Combobox label="Product" value={null} onChange={() => {}} load={load} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'ap' } });
    fireEvent.change(input, { target: { value: 'app' } });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toBe('app');
  });

  it('an older answer that arrives late never replaces the newer one', async () => {
    vi.useFakeTimers();
    let release: (v: ComboboxOption[]) => void = () => {};
    const load = vi.fn((q: string) => (q === 'a' ? new Promise<ComboboxOption[]>((r) => { release = r; }) : Promise.resolve(opts('Banana'))));
    render(<Combobox label="Product" value={null} onChange={() => {}} load={load} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'a' } });
    await settle();
    fireEvent.change(input, { target: { value: 'b' } });
    await settle();
    await act(async () => { release(opts('Apple')); await Promise.resolve(); });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Banana']);
  });

  it('a failed read says so, never "No matches"', async () => {
    vi.useFakeTimers();
    let fail = true;
    const load = vi.fn(async () => { if (fail) throw new Error('500'); return opts('Apple'); });
    render(<Combobox label="Product" value={null} onChange={() => {}} load={load} />);
    const input = screen.getByRole('combobox');
    fireEvent.click(input);
    await settle();
    expect(screen.getByRole('status').textContent).toBe('comboboxFailed');
    expect(screen.queryByText('comboboxNoResults')).toBeNull();
    fail = false;
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // ArrowDown retries
    await settle(10);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Apple']);
  });

  it('focus alone fetches nothing (tabbing through a form stays quiet)', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => opts('Apple'));
    render(<Combobox label="Product" value={null} onChange={() => {}} load={load} />);
    fireEvent.focus(screen.getByRole('combobox'));
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
  });

  it('a page with more says so, never a page size read as a total', async () => {
    vi.useFakeTimers();
    render(<Combobox label="Product" value={null} onChange={() => {}} load={async () => ({ options: opts('A', 'B'), more: true })} />);
    fireEvent.click(screen.getByRole('combobox'));
    await settle();
    expect(screen.getByRole('status').textContent).toBe('comboboxResultsMore:2');
  });

  it('emptying an optional value clears it; a required one is restored', async () => {
    const onChange = vi.fn();
    const chosen = { id: 'apple', label: 'Apple' };
    const { rerender } = render(<Combobox label="Product" value={chosen} onChange={onChange} load={async () => []} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(null);
    onChange.mockClear();
    rerender(<Combobox label="Product" value={chosen} onChange={onChange} load={async () => []} required />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    fireEvent.blur(screen.getByRole('combobox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
