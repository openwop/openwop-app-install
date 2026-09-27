/**
 * CF-G1 — a security control must not fail OPEN from a transient read error.
 *
 * Every write on this page is a FULL REPLACEMENT:
 * `setFirewallRules(orgId, next, policy, { mode, defaultDenyVerdict })`. The add
 * paths build `next` as `[...(rules ?? []), rule]`.
 *
 * On a failed load, `rules` stays `null` while `mode`, `unknownPolicy` and
 * `defaultDenyVerdict` still hold their COMPONENT DEFAULTS — `'default-allow'`
 * and `'skip'`. So one click on "Add rule" would have:
 *
 *   1. sent `[thatOneRule]` as the entire ruleset, deleting every other rule;
 *   2. flipped a default-DENY workspace to **default-allow**; and
 *   3. set unknown tools to **skip** (unblocked).
 *
 * The save docstring promises the opposite — "The current mode +
 * defaultDenyVerdict ride every save unless overridden, so editing a rule never
 * silently reverts the posture." That guarantee holds only if the load
 * succeeded; on a failed load it does exactly what the comment says it won't.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions } = vi.hoisted(() => ({
  listOrgs: vi.fn(), getFirewallRules: vi.fn(), setFirewallRules: vi.fn(), getFirewallDecisions: vi.fn(),
}));
vi.mock('../firewallClient.js', async (orig) => ({
  ...(await orig<typeof import('../firewallClient.js')>()),
  listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions,
}));

import { FirewallRulesPage } from '../FirewallRulesPage.js';

/** A workspace on the STRICT posture — the one a fail-open would destroy. */
const STRICT = {
  // The real FirewallRule shape — `when` is a predicate object the page reads
  // as `r.when.anyOf`, not a `classes` array. A wrong fixture throws in render
  // and fails every assertion for the wrong reason.
  rules: [{
    id: 'r1', description: 'Block egress',
    when: { anyOf: [{ egress: 'external' }] },
    verdict: 'deny' as const, reason: 'egress',
  }],
  isDefault: false,
  unknownToolPolicy: 'treat-as-risky' as const,
  mode: 'default-deny' as const,
  defaultDenyVerdict: 'deny' as const,
};

const mount = async (): Promise<void> => {
  render(<FirewallRulesPage />);
  await act(async () => {});
};

const byText = (re: RegExp): HTMLButtonElement | undefined =>
  screen.queryAllByRole('button').find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  getFirewallRules.mockResolvedValue(STRICT);
  getFirewallDecisions.mockResolvedValue([]);
  setFirewallRules.mockResolvedValue(STRICT);
});

describe('CF-G1 — a failed read never writes the firewall', () => {
  it('no write reaches the server on a failed read, and no control offers one', async () => {
    getFirewallRules.mockRejectedValue(new Error('503 upstream'));
    await mount();
    // Sabotaging the `save()` choke-point refusal left this GREEN, and the reason
    // matters: with CF-G2 fixed the page returns the error card early, so no
    // write control renders at all — the assertion below would pass with or
    // without the choke point. Asserting BOTH facts is what makes it meaningful:
    // nothing is offered, and nothing is sent.
    expect(byText(/Add recommended rule/)).toBeUndefined();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(setFirewallRules).not.toHaveBeenCalled();
  });

  it('says why, and offers a retry', async () => {
    getFirewallRules.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('could not be read');
    expect(byText(/Try again/)).toBeTruthy();
  });

  it('CF-G2 — stops claiming it is still loading', async () => {
    // Same shape as MEM-G1/PL-G1 (#2584), third instance today: `rules === null`
    // meant both "loading" and "failed", so the page showed a permanent
    // "Loading…" card — which ALSO hid the guard notice, leaving the operator
    // with an inert page and no reason for it.
    getFirewallRules.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(document.body.textContent).toContain('Could not load the firewall rules');
  });

  it('a SUCCESSFUL read leaves the editor writable', async () => {
    // The failure mode of this fix is a firewall page nobody can edit.
    await mount();
    expect(document.body.textContent).not.toContain('could not be read');
    const add = byText(/Add recommended rule/);
    expect(add?.disabled).toBe(false);
    await act(async () => { fireEvent.click(add!); });
    expect(setFirewallRules).toHaveBeenCalled();
  });

  it('the write it does make preserves the workspace posture, not the defaults', async () => {
    // Guards the docstring's actual promise: mode/policy ride the save.
    await mount();
    await act(async () => { fireEvent.click(byText(/Add recommended rule/)!); });
    const [, next, policy, posture] = setFirewallRules.mock.calls[0]!;
    expect((next as unknown[]).length).toBe(2); // existing rule kept, not replaced
    expect(policy).toBe('treat-as-risky');
    expect((posture as { mode?: string }).mode).toBe('default-deny');
  });

  it('the retry restores editing', async () => {
    getFirewallRules.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(STRICT);
    await mount();
    await act(async () => { fireEvent.click(byText(/Try again/)!); });
    expect(document.body.textContent).not.toContain('could not be read');
    expect(byText(/Add recommended rule/)?.disabled).toBe(false);
  });
});
