/**
 * MEM-G1 / PL-G1 — a failed read must not sit at the LOADING sentinel.
 *
 * Both surfaces model "not loaded yet" as `null` and set an error on failure
 * without touching that `null`. So a failed read rendered the **loading** state
 * forever: the memory browser showed a busy StateCard indefinitely while the
 * counter beside the composer said "0 stored", and the prompt library rendered a
 * skeleton grid with `aria-busy="true"` for as long as the page stayed open.
 *
 * The screen-reader consequence is the sharp one: the page announces that it is
 * still working, permanently, when in fact it has given up.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { list, add, remove } = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));

import { MemoryBrowser } from '../MemoryBrowser.js';

const mount = async (): Promise<void> => {
  render(<MemoryBrowser list={list} add={add} remove={remove} />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([{ id: 'n1', content: 'Prefers dark mode', contentTrust: 'trusted' }]);
});

describe('MEM-G1 — a failed memory read is not a loading memory read', () => {
  it('stops claiming it is still loading', async () => {
    list.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText('Could not load these memories')).toBeTruthy();
    // The permanent busy state is the bug: nothing on the page may still be
    // announcing work in progress.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('does not claim zero stored memories', async () => {
    list.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('unknown');
    expect(document.body.textContent).not.toMatch(/\b0 stored|Stored memories: 0/);
  });

  it('the retry recovers', async () => {
    list.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([{ id: 'n1', content: 'Prefers dark mode', contentTrust: 'trusted' }]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(screen.queryByText('Could not load these memories')).toBeNull();
    expect(document.body.textContent).toContain('Prefers dark mode');
  });

  it('a genuinely EMPTY memory still reads as empty, not failed', async () => {
    // The failure mode of this fix is turning "no memories yet" into an error.
    list.mockResolvedValue([]);
    await mount();
    expect(screen.queryByText('Could not load these memories')).toBeNull();
    expect(document.body.textContent).not.toContain('unknown');
  });

  it('a successful read still shows its count', async () => {
    await mount();
    expect(document.body.textContent).not.toContain('unknown');
    expect(document.body.textContent).toContain('Prefers dark mode');
  });
});
