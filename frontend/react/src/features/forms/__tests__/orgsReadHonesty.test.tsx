/**
 * FR-R2-1 (forms round 2) — a failed orgs read must not render the no-orgs
 * claim (instance seven of the session's shape; both polarities pinned).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listOrgs: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../formsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOrgs: api.listOrgs };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { FormsPage } from '../FormsPage.js';

beforeEach(() => {
  vi.clearAllMocks();
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
  });
  it('TRUTHFUL empty: the real no-orgs state survives', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<MemoryRouter><FormsPage /></MemoryRouter>);
    expect(await screen.findByText(/organization/i, { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });
});
