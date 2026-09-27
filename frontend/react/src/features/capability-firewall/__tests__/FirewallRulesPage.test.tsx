/**
 * ADR 0135 clarity redesign — FirewallRulesPage coverage. Locks the comprehension
 * fixes: the explainer renders, classes show in plain language (NOT the raw
 * `egress:host-mediated` wire form), the empty state offers a one-click
 * recommended rule, and adding it persists the canonical read→send guard.
 * Client is mocked → pure component test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../firewallClient.js', () => ({
  listOrgs: vi.fn(),
  getFirewallRules: vi.fn(),
  setFirewallRules: vi.fn(),
  getFirewallDecisions: vi.fn(),
  simulateFirewall: vi.fn(),
}));

import { listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions, simulateFirewall } from '../firewallClient.js';
import { FirewallRulesPage } from '../FirewallRulesPage.js';

const mockOrgs = vi.mocked(listOrgs);
const mockGet = vi.mocked(getFirewallRules);
const mockSet = vi.mocked(setFirewallRules);
const mockDecisions = vi.mocked(getFirewallDecisions);
const mockSimulate = vi.mocked(simulateFirewall);

beforeEach(() => {
  mockOrgs.mockReset(); mockGet.mockReset(); mockSet.mockReset(); mockDecisions.mockReset(); mockSimulate.mockReset();
  mockOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  mockGet.mockResolvedValue({ rules: [], isDefault: true, unknownToolPolicy: 'skip', mode: 'default-allow', defaultDenyVerdict: 'deny' });
  mockSet.mockImplementation((_org, rules, policy, posture) => Promise.resolve({ rules, isDefault: false, unknownToolPolicy: policy, mode: posture?.mode ?? 'default-allow', defaultDenyVerdict: posture?.defaultDenyVerdict ?? 'deny' }));
  mockDecisions.mockResolvedValue([]);
  mockSimulate.mockResolvedValue({ decision: 'require-approval', mode: 'default-allow', matchedRuleId: 'read-then-egress', matchedClause: 'seen safetyTier:read → next egress:host-mediated', fellThroughToDefault: false, trace: [{ ruleId: 'read-then-egress', predicateKind: 'presence', matched: true, why: 'matched: seen safetyTier:read → next egress:host-mediated' }] });
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

  // ADR 0135 Phase 5 — the composition-VOLUME (countAtLeast) builder.
  it('builds and persists a countAtLeast rule (edit threshold + pick a class)', async () => {
    render(<FirewallRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Volume' }));
    // Scope to the builder (the simulator panel now renders the same class chips).
    const builder = screen.getByRole('region', { name: 'Build a rule' });
    // Edit the per-turn limit, then pick the class to count.
    fireEvent.change(within(builder).getByLabelText('this many times or more'), { target: { value: '5' } });
    fireEvent.click(within(builder).getByRole('button', { name: 'send data via a connected app' }));
    fireEvent.click(within(builder).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    const saved = mockSet.mock.calls[0][1];
    expect(saved[0].when.countAtLeast).toEqual({ class: { egress: 'host-mediated' }, threshold: 5, window: 'turn' });
    expect(saved[0].when.anyOf).toBeUndefined();
  });

  // ADR 0135 Phase 6 — the bounded-expression builder.
  it('builds and persists an expression rule', async () => {
    render(<FirewallRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expression' }));
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: 'count.egress:host-mediated >= 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    const saved = mockSet.mock.calls[0][1];
    expect(saved[0].when.expression).toBe('count.egress:host-mediated >= 3');
  });

  it('surfaces a server 400 on a bad expression inline (fail-closed)', async () => {
    mockSet.mockRejectedValueOnce(new Error('rules[0].when.expression is invalid: unknown fact: seen.bogus'));
    render(<FirewallRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expression' }));
    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: 'seen.bogus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(await screen.findByText(/invalid: unknown fact/)).toBeTruthy();
  });

  it('renders saved count + expression rules as sentences', async () => {
    mockGet.mockResolvedValue({
      isDefault: false,
      unknownToolPolicy: 'skip',
      mode: 'default-allow',
      defaultDenyVerdict: 'deny',
      rules: [
        { id: 'v', description: 'volume', verdict: 'require-approval', reason: 'r', when: { countAtLeast: { class: { egress: 'host-mediated' }, threshold: 4, window: 'turn' } } },
        { id: 'e', description: 'expr', verdict: 'deny', reason: 'r', when: { expression: 'seen.read && next.egress:host-mediated' } },
      ],
    });
    render(<FirewallRulesPage />);
    expect(await screen.findByText(/4 or more times/)).toBeTruthy();
    expect(screen.getByText('When this expression is true:')).toBeTruthy();
    expect(screen.getByText('seen.read && next.egress:host-mediated')).toBeTruthy();
  });

  // ADR 0397 Phase 1 — the recent-decisions view.
  it('renders recent firewall decisions with matched-rule attribution', async () => {
    mockDecisions.mockResolvedValue([
      { decisionId: 'a1', timestamp: '2026-07-17T10:00:00.000Z', decision: 'require-approval', toolName: 'openwop:core.openwop.http.fetch', ruleId: 'read-then-egress', reason: 'read then send off-host', conversationId: 'conv-1' },
    ]);
    render(<FirewallRulesPage />);
    expect(await screen.findByText('Recent decisions')).toBeTruthy();
    expect(await screen.findByText('openwop:core.openwop.http.fetch')).toBeTruthy();
    expect(screen.getByText('read then send off-host')).toBeTruthy();
    expect(screen.getByText('rule: read-then-egress')).toBeTruthy();
  });

  it('shows the decisions empty state when there are none', async () => {
    mockDecisions.mockResolvedValue([]);
    render(<FirewallRulesPage />);
    expect(await screen.findByText('No decisions yet')).toBeTruthy();
  });

  // ADR 0397 — a shadow would-block renders distinctly (the call proceeded), not as a hard deny.
  it('renders a shadow would-block as "would … (shadow)", not a hard deny', async () => {
    mockDecisions.mockResolvedValue([
      { decisionId: 's1', timestamp: '2026-07-17T10:00:00.000Z', decision: 'deny', shadow: true, toolName: 'openwop:core.openwop.http.fetch', ruleId: 'read-then-egress' },
    ]);
    render(<FirewallRulesPage />);
    expect(await screen.findByText('would deny (shadow)')).toBeTruthy();
  });

  // ADR 0397 Phase 2 — the simulator panel.
  it('simulates an action and shows the decision + matched rule', async () => {
    render(<FirewallRulesPage />);
    const sim = await screen.findByRole('region', { name: 'Test a rule set' });
    // Pick the "next" action inside the simulator's second class picker.
    const nextFieldset = within(sim).getByText('…and a tool is about to…').closest('fieldset') as HTMLElement;
    fireEvent.click(within(nextFieldset).getByRole('button', { name: 'send data via a connected app' }));
    fireEvent.click(within(sim).getByRole('button', { name: 'Simulate' }));
    await waitFor(() => expect(mockSimulate).toHaveBeenCalledTimes(1));
    expect(await within(sim).findByText('matched rule: read-then-egress')).toBeTruthy();
    expect(mockSimulate.mock.calls[0][1].next).toEqual({ egress: 'host-mediated' });
  });

  // ADR 0397 Phase 3 — the enforcement-posture (mode) selector.
  it('switches to enforce mode and persists the posture', async () => {
    render(<FirewallRulesPage />);
    const posture = await screen.findByRole('region', { name: 'Enforcement posture' });
    fireEvent.click(within(posture).getByRole('radio', { name: /Enforce/ }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1));
    expect(mockSet.mock.calls[0][3]).toMatchObject({ mode: 'enforce' });
    // The deny-verdict control appears once enforce is active.
    expect(await within(posture).findByLabelText('An unmatched action should')).toBeTruthy();
  });
});
