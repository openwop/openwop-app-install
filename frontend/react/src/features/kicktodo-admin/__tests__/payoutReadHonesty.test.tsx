/**
 * UX_UPGRADE-kicktodo-admin P1 — a money console must not state a figure it
 * failed to read.
 *
 * `AdminCommercePage`'s own docstring states the design law it was breaking:
 * "a paid-but-unfulfilled order is a FIRST-CLASS incident ... never a silent
 * gap" and "the result is reported honestly". `loadPayouts()` did
 * `Promise.all([getSharePolicy().catch(() => null), listPayoutRuns().catch(() => [])])`.
 *
 * A PRIOR pass (KTUX-19) had already added `payoutLoaded`, and its comment says
 * "never assert 'no runs / no policy' BEFORE THE FIRST READ SETTLES". That guard
 * is about TIMING. A failed read also settles, so it sailed straight through and
 * made both assertions anyway:
 *
 *   • "No payout runs yet."  → an operator reconciling payouts concludes nothing
 *     has ever been paid out.
 *   • "no share policy set"  → and this one invites a MONEY WRITE. The Set CTA
 *     calls setSharePolicy(bps), which OVERWRITES. An operator told there is no
 *     policy can silently replace a basis-points rate they were never shown.
 *
 * That second one is why the CTA is now BLOCKED rather than merely warned about —
 * the same ruling peer session openwop-app-3 applied to commerce-ucp's Provision
 * CTA (remove the entry point, don't disable-and-hope).
 *
 * Both arms are asserted throughout: a failed read says unknown, and a genuinely
 * empty ledger still says empty — otherwise the fix rots into "always unknown"
 * and the real all-clear is destroyed.
 *
 * Sabotage witnesses (w40 probes): ignoring a failed runs read, always-unknown
 * runs, letting a policy failure blank the runs, dropping `policyFailed` from the
 * Set CTA's disable gate (needs a TYPED rate — see below), ignoring a failed
 * policy read, dropping the empty-input gate, disabling Open-run on a policy
 * failure, or mis-scaling basis points to a percent each turn a case here red.
 *
 * w40 correction: both "Set CTA blocked on policy failure" cases used to assert
 * `disabled` with an EMPTY rate input, so the ordinary `!policyInput.trim()`
 * gate held the CTA disabled and removing the `policyFailed` block stayed green
 * (probe w40g4-prh-setblock, vacuous). They now type a rate first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { messages as en } from '../i18n/en.js';
import type { PayoutRun, SharePolicy } from '../../../client/kicktodoSeatClient.js';

const api = vi.hoisted(() => ({
  getSharePolicy: vi.fn<() => Promise<SharePolicy | null>>(),
  listPayoutRuns: vi.fn<() => Promise<PayoutRun[]>>(),
  setSharePolicy: vi.fn<(shareBps: number) => Promise<SharePolicy>>(),
  createPayoutRun: vi.fn<() => Promise<PayoutRun | null>>(),
  confirmPayoutRun: vi.fn<(runId: string, reference: string) => Promise<PayoutRun>>(),
  cancelPayoutRun: vi.fn<(runId: string) => Promise<PayoutRun>>(),
}));
// Mock the path the component ACTUALLY imports — my first cut guessed
// `../kicktodoAdminClient.js`, which does not exist, so the mock silently never
// applied and two failure-arm tests "passed" for the wrong reason.
vi.mock('../../../client/kicktodoSeatClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});

import { AdminCommercePage } from '../AdminCommercePage.js';

function view(): void {
  render(<MemoryRouter><AdminCommercePage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSharePolicy.mockResolvedValue(POLICY);
  api.listPayoutRuns.mockResolvedValue([]);
});

// A NON-round rate (wave 39 lesson): 1234 bps = 12.34%, so a mis-scaled or
// rounded conversion shows.
const POLICY: SharePolicy = { shareBps: 1234, version: 1 };

/** Type a rate so the ordinary empty-input gate is NOT what holds the CTA. */
function typeRate(): void {
  fireEvent.change(screen.getByLabelText(en.payoutPolicyLabel), { target: { value: '1500' } });
}
afterEach(cleanup);

describe('UX-KTA-1 — an unread payout ledger never reads as an empty one', () => {
  it('RUNS FAIL: says unreadable, and NEVER "No payout runs yet."', async () => {
    api.listPayoutRuns.mockRejectedValue(new Error('runs_500'));
    view();
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/No payout runs yet/i)).toBeNull();
  });

  it('EMPTY: a genuinely empty ledger still says so', async () => {
    // The other arm — without it, "always unknown" passes the test above while
    // destroying the real all-clear an operator reconciles against.
    api.listPayoutRuns.mockResolvedValue([]);
    view();
    expect(await screen.findByText(/No payout runs yet/i)).toBeTruthy();
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });
});

describe('UX-KTA-1 — a blind money write is blocked, not merely warned about', () => {
  it('POLICY FAILS: the Set CTA is disabled so an unseen rate cannot be overwritten', async () => {
    api.getSharePolicy.mockRejectedValue(new Error('policy_500'));
    view();
    expect(await screen.findByText(en.payoutPolicyUnknown)).toBeTruthy();
    // It must not claim "no policy" either.
    expect(screen.queryByText(en.payoutPolicyNone)).toBeNull();
    typeRate();
    // `getByRole('button', {name: /set/i})` was the matcher here. On a MONEY-WRITE
    // control a loose regex is the wrong tool twice over: it would silently start
    // matching some other "Reset"/"Settings" button a later pass adds, and it
    // cannot tell the Set-policy CTA from anything else beginning "set". Resolve
    // the accessible name from the catalog instead — a renamed key then fails at
    // import (the honest failure) while a copy change still passes.
    const cta = screen.getByRole('button', { name: en.payoutPolicySetCta });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
  });

  it('POLICY OK: the rate is shown and the Set CTA becomes usable once a rate is typed', async () => {
    // The other arm: the block must be scoped to the unknown case only.
    //
    // This case used to assert `findByText(/10/)` plus the absence of the
    // "unreadable" chip — it did no typing and never looked at `disabled`, so
    // the name's promise ("the CTA is usable once a rate is typed") was unproven.
    // The CTA is gated on THREE things (`AdminCommercePage.tsx:225`):
    // `payoutBusy || !policyInput.trim() || policyFailed`. Asserting it enabled
    // therefore requires actually typing a rate — otherwise the empty-input gate
    // keeps it disabled and the "unreadable" gate is indistinguishable from it.
    api.getSharePolicy.mockResolvedValue(POLICY);
    view();
    // Post-settle anchor AND the rate itself: the chip carries the RESOLVED rate
    // (1234 bps → 12.34%), so it cannot paint before `getSharePolicy` answered.
    expect(await screen.findByText('Author share: 12.34%')).toBeTruthy();
    expect(screen.queryByText(en.payoutPolicyUnknown)).toBeNull();

    const cta = screen.getByRole('button', { name: en.payoutPolicySetCta }) as HTMLButtonElement;
    // Empty input — disabled for the ORDINARY reason, not the unreadable gate.
    expect(cta.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(en.payoutPolicyLabel), { target: { value: '1500' } });
    // …and with a rate typed it is genuinely usable, which is the half of the
    // rule that stops the fix rotting into "the Set CTA is always blocked".
    expect(cta.disabled).toBe(false);
  });

  it('a policy failure does not suppress the runs it DID read', async () => {
    // allSettled: one read failing must not blank the other.
    api.getSharePolicy.mockRejectedValue(new Error('policy_500'));
    api.listPayoutRuns.mockResolvedValue([]);
    view();
    await screen.findByText(/unreadable/i);
    expect(screen.getByText(/No payout runs yet/i)).toBeTruthy();
  });
});

describe('UX-KTA-1 — the gate blocks DERIVED writes only, never safe ones', () => {
  it('POLICY FAILS: createPayoutRun stays ENABLED — its payload is not derived from the policy', async () => {
    // ARCHITECT RULING (phase-1 review): the rule is NOT "unreadable state =>
    // no writes". It is "block exactly those writes whose PAYLOAD is derived
    // from the state you failed to read".
    //
    //   setSharePolicy(shareBps) -> sends { shareBps }, OVERWRITES  => block
    //   createPayoutRun()        -> sends NO BODY; the server computes the
    //                               split from its own stored policy => must
    //                               NOT block
    //
    // I nearly "hardened" this page by disabling every write path, copying the
    // capability firewall. That would have been a DEFECT: it denies a safe,
    // server-authoritative operation because an unrelated client read failed.
    // This test exists so that over-blocking fails loudly.
    api.getSharePolicy.mockRejectedValue(new Error('policy_500'));
    view();
    await screen.findByText(/unreadable/i);
    // Resolve the label from the CATALOG, not a hand-typed string: three tests
    // this session broke when copy changed. If the key is renamed this fails at
    // import, which is the honest failure; if the COPY changes the test still
    // passes, which is what we want — it is asserting behaviour, not wording.
    const create = screen.getByRole('button', { name: en.payoutRunCreateCta });
    expect((create as HTMLButtonElement).disabled).toBe(false);
  });

  it('POLICY FAILS: the Set-policy CTA is still blocked (the derived write)', async () => {
    // The positive half, asserted alongside so the pair reads as one rule.
    // TWIN of "POLICY FAILS: the Set CTA is disabled so an unseen rate cannot be
    // overwritten" (same gate, same probe w40g4-prh-setblock-r2); kept because this
    // file is a protected money test and this case pairs the block with the
    // createPayoutRun case above under the DERIVED-writes rule.
    api.getSharePolicy.mockRejectedValue(new Error('policy_500'));
    view();
    await screen.findByText(/unreadable/i);
    typeRate();
    // Safe write still enabled in the same state — the pair is one rule.
    expect((screen.getByRole('button', { name: en.payoutRunCreateCta }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: en.payoutPolicySetCta }) as HTMLButtonElement).disabled).toBe(true);
  });
});
