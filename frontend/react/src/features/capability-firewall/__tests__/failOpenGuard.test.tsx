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
 *
 * THREE guards stand between a failed read and a write: (a) the CF-G2 early
 * return (a first-load failure renders only the error card — no controls);
 * (b) `disabled={busy || loadFailed}` on every write control; (c) the `save()`
 * choke-point refusal. On a FIRST load (a) hides (b) and (c), so cases 1–3 witness
 * (a) only. The one reachable path to (b) and (c) is an ORG SWITCH whose read
 * fails: the previous org's rules are still in state (non-null), so (a) does not
 * fire and the editor renders with `loadFailed` (wave 52 case 7). There, (b) is
 * asserted on the controls, and (c) is witnessed through a radio: jsdom delivers a
 * click to a disabled radio (a browser does not), React fires its onChange, and
 * only the choke point stops the write. Removing (c) turns case 7 red; removing
 * `disabled` from the recommended-rule button turns it red too.
 * (CF-ORGSWITCH-STALE-1, filed by the coordinator: that state still SHOWS the
 * previous org's rules under the new selector — outside this file's claim.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

type Client = typeof import('../firewallClient.js');
const { listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions } = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(),
  getFirewallRules: vi.fn<Client['getFirewallRules']>(),
  setFirewallRules: vi.fn<Client['setFirewallRules']>(),
  getFirewallDecisions: vi.fn<Client['getFirewallDecisions']>(),
}));
vi.mock('../firewallClient.js', async (orig) => ({
  ...(await orig<typeof import('../firewallClient.js')>()),
  listOrgs, getFirewallRules, setFirewallRules, getFirewallDecisions,
}));

import { FirewallRulesPage } from '../FirewallRulesPage.js';
import type { FirewallView } from '../firewallClient.js';

/** A workspace on the STRICT posture — the one a fail-open would destroy. */
const STRICT: FirewallView = {
  // The real FirewallRule shape — `when` is a predicate object the page reads
  // as `r.when.anyOf`, not a `classes` array. A wrong fixture throws in render
  // and fails every assertion for the wrong reason.
  rules: [{
    id: 'r1', description: 'Block egress',
    when: { anyOf: [{ egress: 'host-owned' }] },
    verdict: 'deny', reason: 'egress',
  }],
  isDefault: false,
  unknownToolPolicy: 'treat-as-risky',
  // The strict posture: enforce, unmatched actions denied. (Round 1's fixture said
  // 'default-deny' — not a FirewallMode; untyped mocks let it through.)
  mode: 'enforce',
  defaultDenyVerdict: 'deny',
};

const mount = async (): Promise<void> => {
  render(<FirewallRulesPage />);
  await act(async () => {});
};

const byText = (re: RegExp): HTMLButtonElement | undefined =>
  screen.queryAllByRole('button').find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

afterEach(cleanup);
beforeEach(() => {
  listOrgs.mockReset(); getFirewallRules.mockReset(); setFirewallRules.mockReset(); getFirewallDecisions.mockReset();
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
    // A failed read is not an empty ruleset.
    expect(document.body.textContent).not.toContain('On, but watching nothing yet');
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
    expect(document.body.textContent).not.toContain('On, but watching nothing yet');
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
    expect(next.length).toBe(2); // existing rule kept, not replaced
    expect(next[0]!.id).toBe('r1');
    expect(policy).toBe('treat-as-risky');
    expect(posture).toEqual({ mode: 'enforce', defaultDenyVerdict: 'deny' });
  });

  it('the retry restores editing', async () => {
    getFirewallRules.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(STRICT);
    await mount();
    await act(async () => { fireEvent.click(byText(/Try again/)!); });
    expect(document.body.textContent).not.toContain('could not be read');
    expect(byText(/Add recommended rule/)?.disabled).toBe(false);
  });

  it('an org switch whose read fails leaves every write control disabled, and save() still refuses', async () => {
    listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }, { orgId: 'o2', name: 'Beta' }]);
    getFirewallRules.mockResolvedValueOnce(STRICT).mockRejectedValueOnce(new Error('503 upstream'));
    await mount();
    expect(byText(/Add recommended rule/)?.disabled).toBe(false); // o1 loaded: writable
    await act(async () => { fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'o2' } }); });
    expect(getFirewallRules).toHaveBeenLastCalledWith('o2');
    // The editor is still mounted (o1's rules are non-null), so the CF-G2 card does
    // not fire — this is the state only guards (b) and (c) protect.
    expect(document.body.textContent).toContain('could not be read');
    expect(byText(/Add recommended rule/)?.disabled).toBe(true);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    for (const r of radios) expect((r as HTMLInputElement).disabled).toBe(true);
    // Guard (c): drive the write anyway through a (disabled) policy radio.
    const skip = radios.find((r) => !(r as HTMLInputElement).checked && (r as HTMLInputElement).name === 'cf-policy');
    expect(skip).toBeDefined();
    await act(async () => { fireEvent.click(skip!); });
    expect(setFirewallRules).not.toHaveBeenCalled();
  });
});
