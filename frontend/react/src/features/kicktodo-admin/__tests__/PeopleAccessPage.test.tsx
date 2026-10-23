/**
 * ADR 0438 A4 — the People & access aggregate lens. Pins the honesty contract:
 * the page renders COUNTS (members by role, per-org links/library) and the B16
 * consent posture, links out for anything person- or consent-scoped, and shows
 * a retryable error state — never a blank page over a failed read.
 *
 * Sabotage witnesses (w40 probes): raw role ids instead of localized labels,
 * hiding the roleless chip, a "Curated" chip on an uncurated org, a failed read
 * left on the loading card, a no-op Retry, or a wrong own-authority link target
 * each turn a case here red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminPeopleView } from '../../../client/kicktodoOrgClient.js';

const state = {
  getAdminPeople: vi.fn(async (): Promise<AdminPeopleView> => ({
    members: { total: 7, byRole: [{ role: 'admin', count: 2 }, { role: 'editor', count: 5 }, { role: 'role-ab12cd34', count: 1 }], rolelessCount: 1 },
    orgs: [
      { orgId: 'org:a', name: 'Acme Learning', memberCount: 5, cohortLinkCount: 2, libraryCurated: true },
      { orgId: 'org:b', name: 'Beta Guild', memberCount: 2, cohortLinkCount: 0, libraryCurated: false },
    ],
    consent: { cohortAggregatesGated: true },
  })),
};
vi.mock('../../../client/kicktodoOrgClient.js', () => ({
  getAdminPeople: () => state.getAdminPeople(),
}));
// ADR 0910 D11 — the page now hosts the Operator access panel; a non-superadmin
// sees nothing of it, and this lens test must not make its live access read.
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: { superadmin: false }, resolved: true }),
}));

import { PeopleAccessPage } from '../PeopleAccessPage.js';

const renderPage = () => render(<MemoryRouter><PeopleAccessPage /></MemoryRouter>);
afterEach(() => { cleanup(); state.getAdminPeople.mockClear(); });

describe('PeopleAccessPage — aggregate lens', () => {
  it('renders role counts, per-org aggregates, and the consent posture', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('7 members in this workspace.')).toBeTruthy());
    // Chips render LOCALIZED role labels (DESIGN.md rule 13); a custom role id
    // falls back verbatim; roleless people get their own localized chip.
    expect(screen.getByText('Admin: 2')).toBeTruthy();
    expect(screen.getByText('Editor: 5')).toBeTruthy();
    expect(screen.getByText('role-ab12cd34: 1')).toBeTruthy();
    expect(screen.getByText('1 without a role')).toBeTruthy();
    expect(screen.getByText('Acme Learning')).toBeTruthy();
    expect(screen.getByText('2 cohort links')).toBeTruthy();
    expect(screen.getByText('Curated library')).toBeTruthy();
    // Consent posture is declared (B16) and the own-authority links are present.
    expect(screen.getByText('Consent posture')).toBeTruthy();
    // Own-authority links point at their real surfaces (not merely labelled).
    expect(screen.getByRole('link', { name: 'Open access & roles' }).getAttribute('href')).toBe('/access');
    expect(screen.getByRole('link', { name: 'Open org programs' }).getAttribute('href')).toBe('/kicktodo/org-programs');
  });

  it('a failed read renders the retryable error state, never a blank page', async () => {
    state.getAdminPeople.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('The people & access lens could not be read.')).toBeTruthy());
    // Retryable means Retry re-reads and recovers, not merely that a button exists.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('7 members in this workspace.')).toBeTruthy();
    expect(screen.queryByText('The people & access lens could not be read.')).toBeNull();
    expect(state.getAdminPeople).toHaveBeenCalledTimes(2);
  });
});
