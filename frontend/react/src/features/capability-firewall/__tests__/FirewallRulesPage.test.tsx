/**
 * ADR 0135 clarity redesign — FirewallRulesPage coverage. Locks the comprehension
 * fixes: the explainer renders, classes show in plain language (NOT the raw
 * `egress:host-mediated` wire form), the empty state offers a one-click
 * recommended rule, and adding it persists the canonical read→send guard.
 * Client is mocked → pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../firewallClient.js', () => ({
  listOrgs: vi.fn(),
  getFirewallRules: vi.fn(),
  setFirewallRules: vi.fn(),
}));

import { listOrgs, getFirewallRules, setFirewallRules } from '../firewallClient.js';
import { FirewallRulesPage } from '../FirewallRulesPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockGet = vi.mocked(getFirewallRules);
const mockSet = vi.mocked(setFirewallRules);

beforeEach(() => {
  mockOrgs.mockReset(); mockGet.mockReset(); mockSet.mockReset();
  mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  mockGet.mockResolvedValue({ rules: [], isDefault: true, unknownToolPolicy: 'skip' });
  mockSet.mockImplementation((_org, rules, policy) => Promise.resolve({ rules, isDefault: false, unknownToolPolicy: policy }));
});
afterEach(cleanup);

describe('FirewallRulesPage (ADR 0135 clarity redesign)', () => {
  it('explains what the firewall does and speaks plain language (no raw wire classes)', async () => {
    render(<FirewallRulesPage />);
    expect(await screen.findByText('What this does')).toBeTruthy();
    // Plain-language class label is present…
    expect(screen.getAllByText('send data via a connected app').length).toBeGreaterThan(0);
    // …and the raw RFC 0078 wire form is NOT shown to the user.
    expect(screen.queryByText(/egress:host-mediated/)).toBeNull();
    expect(screen.queryByText('safetyTier')).toBeNull();
  });

  it('offers a one-click recommended rule from the empty state and persists the read→send guard', async () => {
    render(<FirewallRulesPage />);
    const add = await screen.findByRole('button', { name: 'Add recommended rule' });
    fireEvent.click(add);
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    const savedRules = mockSet.mock.calls[0][1];
    expect(savedRules).toHaveLength(1);
    // The canonical guard: run did read → next tool sends off-host.
    expect(savedRules[0].when.anyOf).toEqual([{ safetyTier: 'read' }]);
    expect(savedRules[0].when.with).toEqual([{ egress: 'host-mediated' }, { egress: 'host-owned' }]);
    expect(savedRules[0].verdict).toBe('require-approval');
  });
});
