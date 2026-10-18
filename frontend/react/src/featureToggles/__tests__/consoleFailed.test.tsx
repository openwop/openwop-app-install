/**
 * FT-G1 — "no feature depends on this" and "we could not check what does" were
 * the same empty array.
 *
 * `listFeatureConsole().catch(() => [])` degrades to `[]` so a projection
 * failure can't blank the panel — right intent. But `lockedByById` is built ONLY
 * from those entries, so an empty projection empties every `lockedBy`, sets
 * `disableLocked = false`, unlocks the Off control and removes the "required by
 * X" note.
 *
 * Checked rather than assumed: this does NOT let anyone orphan a dependent.
 * `routes/featureToggles.ts:173` refuses the write — "Backend is the authority —
 * the FE pre-gates the Off control, but this is the enforced boundary." What is
 * lost is the ADVANCE WARNING: the operator clicks Off and learns by server
 * rejection instead of by disclosure. So this fix DISCLOSES, and deliberately
 * does not block — blocking would be a UI claim stronger than the truth.
 *
 * Sabotage that turns it red: `setConsoleFailed(!con.ok)` → `false` (case 1);
 * re-throwing the projection failure (case 2: the panel blanks); always showing
 * the Notice (cases 3–4); a retry button that does not call `load` (case 5).
 * Every absence is asserted only after the "Required by email" note — the FT-G1
 * disclosure's subject — proves the projection settled.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listToggleConfigs, listFeatureConsole } = vi.hoisted(() => ({
  listToggleConfigs: vi.fn<() => Promise<ToggleConfig[]>>(),
  listFeatureConsole: vi.fn<() => Promise<FeatureConsoleEntry[]>>(),
}));
vi.mock('../../client/featureTogglesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/featureTogglesClient.js')>()),
  listToggleConfigs, listFeatureConsole,
}));

import { FeatureTogglePanel } from '../FeatureTogglePanel.js';
import type { FeatureConsoleEntry, ToggleConfig } from '../../client/featureTogglesClient.js';

const CONFIG: ToggleConfig = { id: 'crm', label: 'CRM', status: 'on', bucketUnit: 'user', salt: 's', variants: [] };
const ENTRY: FeatureConsoleEntry = {
  id: 'crm', dependsOn: [], dependents: ['email'], blockedByDependents: ['email'],
  recommends: [], recommendedOff: [], packs: [],
};

const mount = async (): Promise<void> => {
  // The panel uses `useLocation()` for its deep-link tab state.
  render(<MemoryRouter><FeatureTogglePanel /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listToggleConfigs.mockResolvedValue([CONFIG]);
  listFeatureConsole.mockResolvedValue([ENTRY]);
});

describe('FT-G1 — a missing projection says so', () => {
  it('discloses that dependency information is missing', async () => {
    listFeatureConsole.mockRejectedValue(new Error('503'));
    await mount();
    expect(await screen.findByText(/dependency information could not be loaded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // What the disclosure is FOR: the "required by" note is gone.
    expect(screen.queryByText(/Required by email/)).toBeNull();
  });

  it('does NOT block the panel — the server is the authority', async () => {
    // Blocking here would be a UI claim stronger than the truth: the disable is
    // enforced server-side either way.
    listFeatureConsole.mockRejectedValue(new Error('503'));
    await mount();
    await screen.findByText(/dependency information could not be loaded/);
    expect(screen.getByText('CRM')).toBeTruthy();
  });

  it('says nothing when the projection loads', async () => {
    // The failure mode of this fix is warning on every healthy page load.
    await mount();
    expect(await screen.findByText(/Required by email/)).toBeTruthy(); // settled
    expect(document.body.textContent).not.toContain('dependency information could not be loaded');
  });

  it('a genuinely EMPTY projection is not treated as a failure', async () => {
    // `[]` from a successful read means "no dependents recorded" — a real
    // answer, and it must not trigger the warning.
    listFeatureConsole.mockResolvedValue([]);
    await mount();
    await screen.findByText('CRM'); // settled
    expect(screen.queryByText(/Required by/)).toBeNull(); // empty really is "no dependents"
    expect(document.body.textContent).not.toContain('dependency information could not be loaded');
  });

  it('the retry clears the warning', async () => {
    listFeatureConsole.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce([ENTRY]);
    await mount();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Try again' })); });
    expect(await screen.findByText(/Required by email/)).toBeTruthy(); // the retry's read landed
    expect(document.body.textContent).not.toContain('dependency information could not be loaded');
  });
});
