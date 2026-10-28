/**
 * EM-R2-1 (email round 2) — a failed orgs read must not render the no-orgs
 * claim (the session's recurring shape; both polarities pinned).
 *
 * What is pinned is EmailPage's WIRING into `ui/OrgSelectionState`: `orgsFailed`
 * (failed ≠ empty), `failedBody` (the email consequence clause) and `emptyBody`.
 * Sabotage-witnessed (/grade-tests wave 9, `w9g4-or-*`): passing `orgsFailed={false}`,
 * dropping `failedBody`, or folding an empty answer into the failed branch each turn
 * a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listOrgs: vi.fn(), listSegments: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listOrgs: api.listOrgs, listSegments: api.listSegments, listTopics: async () => ({ topics: [], max: 20 }),
    // ADR 0955 D7 — the page's sending-health card (a healthy sender).
    getSendingHealth: async () => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }) };
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
    // EXACT title: `/organization/` alone also matched the FAILED title
    // ("Could not load your organizations"), i.e. it passed in the wrong state.
    expect(await screen.findByText('No organizations', { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.getByText(/email templates and campaigns belong to an organization/i)).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
  });
});
