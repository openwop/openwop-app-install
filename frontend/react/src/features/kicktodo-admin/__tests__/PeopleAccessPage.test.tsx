/**
 * ADR 0438 A4 — the People & access aggregate lens. Pins the honesty contract:
 * the page renders COUNTS (members by role, per-org links/library) and the B16
 * consent posture, links out for anything person- or consent-scoped, and shows
 * a retryable error state — never a blank page over a failed read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = {
  getAdminPeople: vi.fn(async () => ({
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
    expect(screen.getByText('Open access & roles')).toBeTruthy();
    expect(screen.getByText('Open org programs')).toBeTruthy();
  });

  it('a failed read renders the retryable error state, never a blank page', async () => {
    state.getAdminPeople.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await waitFor(() => expect(screen.getByText('The people & access lens could not be read.')).toBeTruthy());
    expect(screen.getByText('Retry')).toBeTruthy();
  });
});
