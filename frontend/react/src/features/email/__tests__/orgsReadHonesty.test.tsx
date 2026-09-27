/**
 * EM-R2-1 (email round 2) — a failed orgs read must not render the no-orgs
 * claim (the session's recurring shape; both polarities pinned).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listOrgs: vi.fn(), listSegments: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOrgs: api.listOrgs, listSegments: api.listSegments };
});
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { EmailPage } from '../EmailPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listSegments.mockResolvedValue([]);
});
afterEach(cleanup);

describe('EM-R2-1 — email orgs honesty', () => {
  it('FAILED read: error card, never the no-orgs claim', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<MemoryRouter><EmailPage /></MemoryRouter>);
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    expect(screen.getByText(/template and campaign lists were never requested/i)).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
  it('TRUTHFUL empty: the real no-orgs state survives', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<MemoryRouter><EmailPage /></MemoryRouter>);
    expect(await screen.findByText(/organization/i, { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });
});
