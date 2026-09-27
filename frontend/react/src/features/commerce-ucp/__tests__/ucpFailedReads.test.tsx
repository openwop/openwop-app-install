/**
 * UX_UPGRADE-commerce-ucp `HV-1` + `HV-2`, converted from prose into a ratchet.
 *
 * Both were recorded as human-verify items because they need a forced backend
 * failure. That deferral was wrong: they guard a defect class this repo has
 * fixed roughly twenty times, and a checklist line in a markdown file does not
 * fail a build when the next refactor reintroduces the bug.
 *
 * This page is the highest-stakes instance of the class found so far, because
 * the empty state's CTA MINTS AN OAUTH CREDENTIAL. `CommerceUcpPage.tsx:135`
 * spells the hazard out: provisioning a client whose siblings you cannot see
 * creates a DUPLICATE credential against the merchant's agent-commerce surface.
 * So a failed `listUcpClients` rendering "No agent clients yet — Provision one"
 * is not merely a false claim, it is a false claim wired to a button that
 * issues secrets.
 *
 * That same comment makes a second, sharper promise — the New-client button is
 * "Removed, not disabled — a disabled button still implies 'you may provision
 * here once ready'". Peer session openwop-app-3's rule is that a comment
 * asserting a user-visible guarantee is a test case, and that rule has found
 * more real defects this session than grepping for `.catch` did. Both promises
 * are pinned below, including the removed-vs-disabled distinction, which is
 * exactly the kind of nuance a later "let's just disable it" cleanup erases.
 *
 * BOTH ARMS, ALWAYS. Each describe pins the failure AND the genuinely-empty
 * answer, or the fix silently degrades into "always show the error" while the
 * suite stays green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ enabled: true }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: 'on', isBeta: false, variant: null, loading: false }),
}));

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  listUcpClients: vi.fn(),
}));
vi.mock('../commerceUcpClient.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../commerceUcpClient.js')>();
  return { ...orig, ...api };
});

import { CommerceUcpPage } from '../CommerceUcpPage.js';
import { messages as en } from '../i18n/en.js';

const ORG = { orgId: 'org_1', name: 'Merchant One' };
const CLIENT = {
  clientId: 'ucp_client_1',
  name: 'Checkout Agent',
  scopes: ['cart:write'] as const,
  createdAt: '2026-07-01T00:00:00.000Z',
};

function view(): void {
  render(<MemoryRouter initialEntries={['/commerce-ucp']}><CommerceUcpPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  access.enabled = true;
  api.listOrgs.mockResolvedValue([ORG]);
  api.listUcpClients.mockResolvedValue([]);
});
afterEach(cleanup);

describe('HV-2 — a failed merchants read never claims the workspace has no merchants', () => {
  it('FAILURE: shows the retryable failure card, not "No merchants yet"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    view();

    expect(await screen.findByText(en.orgsFailedTitle)).toBeTruthy();
    expect(screen.getByText(new RegExp('orgs_500'))).toBeTruthy();
    expect(screen.getByRole('button', { name: en.retry })).toBeTruthy();

    expect(screen.queryByText(en.noOrgsTitle)).toBeNull();
  });

  it('GENUINELY EMPTY: a real "no merchants" answer still renders the empty state', async () => {
    api.listOrgs.mockResolvedValue([]);
    view();

    expect(await screen.findByText(en.noOrgsTitle)).toBeTruthy();
    expect(screen.queryByText(en.orgsFailedTitle)).toBeNull();
  });
});

describe('HV-1 — a failed client read never offers to mint an OAuth credential', () => {
  it('FAILURE: says the read failed and withholds BOTH provision CTAs', async () => {
    api.listUcpClients.mockRejectedValue(new Error('clients_500'));
    view();

    expect(await screen.findByText(en.clientsFailedTitle)).toBeTruthy();
    expect(screen.getByText(new RegExp('clients_500'))).toBeTruthy();

    // The unfounded claim…
    expect(screen.queryByText(en.noClients)).toBeNull();
    // …and every path to the credential-minting form. There are TWO in the
    // healthy/empty renders (the header action and the empty-state CTA); a fix
    // that removed only one would still hand out a duplicate secret.
    expect(screen.queryAllByRole('button', { name: en.newClient })).toHaveLength(0);
  });

  it('FAILURE: the provision button is REMOVED, not merely disabled', async () => {
    // Pins the explicit promise at CommerceUcpPage.tsx:135. A disabled button
    // still says "you may provision here, once ready" — which is a claim about
    // a list we could not read. `queryAllByRole` finds disabled buttons too, so
    // this assertion genuinely distinguishes removed from disabled.
    api.listUcpClients.mockRejectedValue(new Error('clients_500'));
    view();

    await screen.findByText(en.clientsFailedTitle);
    const provisionButtons = screen.queryAllByRole('button', { name: en.newClient, hidden: true });
    expect(provisionButtons).toHaveLength(0);
  });

  it('GENUINELY EMPTY: a real "no clients" answer still offers to provision one', async () => {
    view();

    expect(await screen.findByText(en.noClients)).toBeTruthy();
    expect(screen.queryByText(en.clientsFailedTitle)).toBeNull();
    // Both CTAs are back — the empty state is reachable and actionable.
    expect(screen.queryAllByRole('button', { name: en.newClient }).length).toBeGreaterThan(0);
  });

  it('HEALTHY: real clients render, and neither designed state appears', async () => {
    api.listUcpClients.mockResolvedValue([CLIENT]);
    view();

    expect(await screen.findByText(CLIENT.name)).toBeTruthy();
    expect(screen.queryByText(en.clientsFailedTitle)).toBeNull();
    expect(screen.queryByText(en.noClients)).toBeNull();
  });
});
