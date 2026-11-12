/**
 * ADR 1097 — the public `/start-trial` entry.
 *
 * Covers, against the real page and the real sign-in return helper:
 *  - SIGNED OUT: the header's own sign-in dialog opens and this exact URL is
 *    remembered (through the same-origin allowlist reader); no offer is read.
 *  - FIRST WORKSPACE: a signed-in visitor's workspaces are listed first (the read
 *    that provisions a new account's personal workspace), then the offer.
 *  - SUCCESS: "Continue to checkout" calls the EXISTING plan / bundle checkout
 *    with the link's target and cadence, and redirects to the live Stripe URL.
 *  - HONESTY: a session without `trialDays` is NOT followed; a demo checkout is
 *    never offered; every non-trial state is named with a way out.
 *  - FALLBACKS: invalid link, billing off (404), not allowed here (403, with the
 *    switch to the personal workspace), failed read (retry), no sign-in UI.
 *
 * Sabotage witness (ADR 1097 §6): dropping `session.trialDays &&` from the
 * redirect condition reds "a session without a trial is not followed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../../../client/requestJson.js';
import { takeReturn } from '../../../auth/signInReturn.js';
import type { TrialOffer } from '../billingClient.js';

const api = vi.hoisted(() => ({
  getTrialOffer: vi.fn(), buyPlan: vi.fn(), buyBundle: vi.fn(),
  listMyWorkspaces: vi.fn(), switchWorkspace: vi.fn(),
}));
const h = vi.hoisted(() => ({ backendUser: null as null | { userId: string }, resolved: true }));
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getTrialOffer: api.getTrialOffer, buyPlan: api.buyPlan, buyBundle: api.buyBundle,
}));
vi.mock('../../../client/workspaceClient.js', () => ({ listMyWorkspaces: api.listMyWorkspaces, switchWorkspace: api.switchWorkspace }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null, loading: false, isConfigured: true }) }));
vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: h.backendUser, resolved: h.resolved }) }));
import { StartTrialPage } from '../StartTrialPage.js';

const WS = {
  workspaces: [
    { workspaceId: 'user:u-1', name: 'Ada’s workspace', slug: 'ada', roles: ['owner'], kind: 'personal', active: true },
  ],
  active: 'user:u-1', personal: 'user:u-1',
};
const SHARED = {
  workspaces: [
    { workspaceId: 'user:u-1', name: 'Ada’s workspace', slug: 'ada', roles: ['owner'], kind: 'personal', active: false },
    { workspaceId: 'ws-team', name: 'Team Space', slug: 'team', roles: ['editor'], kind: 'shared', active: true },
  ],
  active: 'ws-team', personal: 'user:u-1',
};
/** `trialDays: null` drops the field (a non-available offer carries none). */
const offer = ({ trialDays, ...o }: Partial<Omit<TrialOffer, 'trialDays'>> & { trialDays?: number | null }): TrialOffer => ({
  target: 'plan:pro', cadence: 'month', status: 'available', checkout: 'live', cardRequired: true, ...o,
  ...(trialDays === null ? {} : { trialDays: trialDays ?? 7 }),
});
const refusal = (status: number, reason?: string) => new ApiError({ status, statusText: '', url: 'trial offer', body: reason ? { details: { reason } } : {} });

let signinClicks = 0;
function mount(entry: string, withTrigger = true) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      {withTrigger ? <button type="button" className="signin-trigger" onClick={() => { signinClicks++; }}>header sign in</button> : null}
      <Routes><Route path="/start-trial" element={<StartTrialPage />} /></Routes>
    </MemoryRouter>,
  );
}

const originalLocation = window.location;
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  h.backendUser = { userId: 'u-1' };
  h.resolved = true;
  signinClicks = 0;
  window.sessionStorage.clear();
  api.getTrialOffer.mockReset().mockResolvedValue(offer({}));
  api.buyPlan.mockReset().mockResolvedValue({ sessionId: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', mode: 'live', trialDays: 7 });
  api.buyBundle.mockReset().mockResolvedValue({ sessionId: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2', mode: 'live', trialDays: 14 });
  api.listMyWorkspaces.mockReset().mockResolvedValue(WS);
  api.switchWorkspace.mockReset().mockResolvedValue({ ok: true, active: 'user:u-1' });
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { ...originalLocation, assign } });
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'location', { configurable: true, writable: true, value: originalLocation });
});

describe('/start-trial — signed out', () => {
  it('offers sign-in, opens the HEADER dialog and remembers this exact URL; reads no offer', async () => {
    h.backendUser = null;
    mount('/start-trial?plan=pro&cadence=year');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in or create an account' }));
    expect(signinClicks).toBe(1);
    expect(takeReturn()).toBe('/start-trial?plan=pro&cadence=year');
    expect(api.getTrialOffer).not.toHaveBeenCalled();
    expect(api.buyPlan).not.toHaveBeenCalled();
  });
  it('a host with no sign-in UI says so instead of a dead button', async () => {
    h.backendUser = null;
    mount('/start-trial?plan=pro', false);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in or create an account' }));
    expect(await screen.findByText('Sign-in is not available on this site')).toBeTruthy();
    expect(takeReturn()).toBeNull(); // nothing left behind to hijack a later sign-in
  });
  it('waits for the session to resolve rather than flashing the sign-in card', async () => {
    h.backendUser = null;
    h.resolved = false;
    mount('/start-trial?plan=pro');
    expect(screen.getByRole('status', { name: 'Checking your trial…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in or create an account' })).toBeNull();
  });
});

describe('/start-trial — signed in', () => {
  it('lists workspaces (provisioning the first one) before reading the offer for the link target', async () => {
    mount('/start-trial?bundle=crm&cadence=year');
    await screen.findByRole('button', { name: 'Continue to checkout' });
    expect(api.listMyWorkspaces).toHaveBeenCalledTimes(1);
    expect(api.getTrialOffer).toHaveBeenCalledWith({ bundleId: 'crm' }, 'year');
    expect(api.listMyWorkspaces.mock.invocationCallOrder[0]).toBeLessThan(api.getTrialOffer.mock.invocationCallOrder[0]!);
  });
  it('success: states the server’s days and workspace, calls the existing plan checkout, redirects to Stripe', async () => {
    mount('/start-trial?plan=pro');
    expect(await screen.findByRole('heading', { name: 'Start your 7-day free trial of Pro' })).toBeTruthy();
    expect(screen.getByText('The trial will belong to the workspace Ada’s workspace.')).toBeTruthy();
    expect(screen.getByText(/You will enter a card at checkout/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_1'));
    expect(api.buyPlan).toHaveBeenCalledWith('pro', 'month');
    expect(api.buyBundle).not.toHaveBeenCalled();
  });
  it('a bundle goes through the existing bundle checkout with its cadence; no-card copy follows the server', async () => {
    api.getTrialOffer.mockResolvedValue(offer({ target: 'bundle:crm', cadence: 'year', trialDays: 14, cardRequired: false, label: 'CRM' }));
    mount('/start-trial?bundle=crm&cadence=year');
    expect(await screen.findByRole('heading', { name: 'Start your 14-day free trial of CRM' })).toBeTruthy();
    expect(screen.getByText(/No card is needed to start/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
    await waitFor(() => expect(api.buyBundle).toHaveBeenCalledWith('crm', 'year'));
    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_2');
  });
  it('a session without a trial is not followed, and says why', async () => {
    api.buyPlan.mockResolvedValue({ sessionId: 'cs_3', url: 'https://checkout.stripe.com/c/pay/cs_3', mode: 'live' });
    mount('/start-trial?plan=pro');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to checkout' }));
    expect(await screen.findByText(/This checkout would not include a trial/)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'See other options' }).getAttribute('href')).toBe('/billing');
  });
  it('a checkout refusal shows the server’s sentence, never a redirect', async () => {
    api.buyPlan.mockRejectedValue(new ApiError({ status: 409, statusText: '', url: 'plan checkout', body: { message: 'This workspace already has a plan. Change it in the billing portal.' } }));
    mount('/start-trial?plan=pro');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue to checkout' }));
    expect(await screen.findByText('This workspace already has a plan. Change it in the billing portal.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('/start-trial — honest fallbacks', () => {
  it('an invalid link names no plan and links to pricing; no read is made', async () => {
    mount('/start-trial?plan=platinum');
    expect(await screen.findByText('This link does not name a plan')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See plans' }).getAttribute('href')).toBe('/pricing');
    expect(api.getTrialOffer).not.toHaveBeenCalled();
  });
  it('billing off (404) says billing is not set up', async () => {
    api.getTrialOffer.mockRejectedValue(refusal(404));
    mount('/start-trial?plan=pro');
    expect(await screen.findByText('Billing is not set up on this site')).toBeTruthy();
  });
  it('not allowed in a shared workspace (403): names it and offers the personal workspace, then re-reads', async () => {
    api.listMyWorkspaces.mockResolvedValue(SHARED);
    api.getTrialOffer.mockRejectedValueOnce(refusal(403));
    mount('/start-trial?plan=pro');
    expect(await screen.findByText(/for Team Space/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use my personal workspace' }));
    await waitFor(() => expect(api.switchWorkspace).toHaveBeenCalledWith('user:u-1'));
    expect(await screen.findByRole('button', { name: 'Continue to checkout' })).toBeTruthy();
    expect(api.getTrialOffer).toHaveBeenCalledTimes(2);
  });
  it('an anonymous-session refusal (403 anonymous_session) asks to sign in', async () => {
    api.getTrialOffer.mockRejectedValue(refusal(403, 'anonymous_session'));
    mount('/start-trial?plan=pro');
    expect(await screen.findByRole('button', { name: 'Sign in or create an account' })).toBeTruthy();
  });
  it('a failed read is a retryable failure, not a "no trial" answer', async () => {
    api.getTrialOffer.mockRejectedValueOnce(refusal(500));
    mount('/start-trial?plan=pro');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Continue to checkout' })).toBeTruthy();
  });
  it('a demo checkout (no Stripe key) is never offered as a trial', async () => {
    api.getTrialOffer.mockResolvedValue(offer({ checkout: 'demo' }));
    mount('/start-trial?plan=pro');
    expect(await screen.findByText('Checkout is not connected on this site')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue to checkout' })).toBeNull();
  });
  const STATES: Array<[TrialOffer['status'], string]> = [
    ['not_for_sale', 'Pro is not for sale here'],
    ['no_trial', 'Pro has no free trial'],
    ['trial_used', 'This workspace has already had its Pro trial'],
    ['already_subscribed', 'This workspace already has Pro'],
    ['included_in_plan', 'Your plan already includes Pro'],
  ];
  for (const [status, title] of STATES) {
    it(`${status}: named, no checkout button, a link to the normal page`, async () => {
      api.getTrialOffer.mockResolvedValue(offer({ status, trialDays: null }));
      mount('/start-trial?plan=pro');
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Continue to checkout' })).toBeNull();
      expect(screen.getByRole('link', { name: 'See other options' }).getAttribute('href')).toBe('/billing');
    });
  }
  it('a bundle fallback links to that bundle in the store', async () => {
    api.getTrialOffer.mockResolvedValue(offer({ target: 'bundle:crm', status: 'no_trial', trialDays: null, label: 'CRM' }));
    mount('/start-trial?bundle=crm');
    expect(await screen.findByText('CRM has no free trial')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See other options' }).getAttribute('href')).toBe('/marketplace/bundles?bundle=crm');
  });
});
