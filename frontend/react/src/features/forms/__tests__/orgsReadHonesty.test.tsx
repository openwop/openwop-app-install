/**
 * FR-R2-1 (forms round 2) — a failed orgs read must not render the no-orgs
 * claim (instance seven of the session's shape; both polarities pinned).
 * This pins the FORMS PAGE wiring of the shared `OrgSelectionState`: its
 * `orgsFailed` flag and the forms-specific clauses. Sabotages that redden it
 * (grade-tests wave 8): `orgsFailed={false}`, `orgsFailed={true}`, or the
 * empty clause passed as the failed one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type FC = typeof import('../formsClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<FC['listOrgs']>(), listForms: vi.fn<FC['listForms']>(), listFormTemplates: vi.fn<FC['listFormTemplates']>(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../formsClient.js', async (orig) => {
  const actual = await orig<FC>();
  return { ...actual, ...api };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { FormsPage } from '../FormsPage.js';

beforeEach(() => {
  vi.resetAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
});
afterEach(cleanup);

describe('FR-R2-1 — forms orgs honesty', () => {
  it('FAILED read: error card, never the no-orgs claim', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><FormsPage /></MemoryRouter>);
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByText(/form list was never requested/i)).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    // The copy says the list was never requested — make that TRUE, not just shown.
    expect(api.listForms).not.toHaveBeenCalled();
  });
  it('TRUTHFUL empty: the real no-orgs state survives', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<MemoryRouter><FormsPage /></MemoryRouter>);
    // The empty state's OWN copy (the old /organization/i locator also matched
    // the failure title "Could not load your organizations").
    expect(await screen.findByText('No organizations', { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.getByText(/Forms belong to an organization/)).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });
});
