/**
 * Strategy §8 — the lazy lock surfaces (palette, admin rail, admin overview, chat
 * picker) report what they SHOW and what is FOLLOWED, with their surface name:
 * a lock returned during render is an impression after commit; `onClick` is the
 * click. An unlocked item reports nothing.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const note = vi.hoisted(() => vi.fn(() => true));
vi.mock('../paywallBeacon.js', () => ({ notePaywall: note }));
vi.mock('../LockedState.js', () => ({ lockedTargets: () => Promise.resolve({ href: () => undefined, label: () => undefined }) }));

import { useLockedNav } from '../lockedTargets.js';

function Probe({ ids, onReady }: { ids: string[]; onReady: (go: Array<() => void>) => void }): JSX.Element {
  const lockedFor = useLockedNav((id) => id === 'crm' || id === 'twin-recall', 'Locked', 'palette');
  const shown = ids.map((id) => lockedFor(id)).filter((l) => l !== null);
  onReady(shown.map((l) => l.onClick));
  return <ul>{shown.map((l) => <li key={l.to}>{l.to}</li>)}</ul>;
}

beforeEach(() => { note.mockClear(); cleanup(); });

describe('useLockedNav — paywall funnel', () => {
  it('reports each shown lock as an impression on its surface, and onClick as a click', async () => {
    let clicks: Array<() => void> = [];
    render(<Probe ids={['crm', 'chat', 'twin-recall']} onReady={(c) => { clicks = c; }} />);
    await waitFor(() => expect(note).toHaveBeenCalledWith('impression', 'crm', 'palette'));
    expect(note).toHaveBeenCalledWith('impression', 'twin-recall', 'palette');
    expect(note).not.toHaveBeenCalledWith('impression', 'chat', 'palette'); // not locked
    clicks[0]!();
    await waitFor(() => expect(note).toHaveBeenCalledWith('click', 'crm', 'palette'));
  });
});
