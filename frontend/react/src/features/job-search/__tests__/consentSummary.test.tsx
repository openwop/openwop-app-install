/**
 * ADR 0541 P4 — the consent surface, after `/ux-review`.
 *
 * The review found two real gaps and these pin the fixes:
 *
 *  1. The form collected six bounds and let the user authorise automatic
 *     submission without ever seeing them said back. A user who cannot describe
 *     what they authorised has not consented to it.
 *  2. Issuing had LESS friction than revoking — the higher-stakes act was the
 *     easier one. The submit is now gated on a complete, restated set of bounds.
 *
 * w52 (round 1 graded this C): the restated numbers were the DEFAULTS (25, 4)
 * and `toContain('4')` matched the expiry date's "14", and nothing read what
 * `createGrant` was sent — so the consent was never bound to the action. The
 * typed values are now distinct (37 / 9 / 6, none in the date), the restatement
 * is asserted by phrase, and issuing asserts the EXACT bounds sent (cs-binding).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ApplyGrantView } from '../jobSearchClient.js';

type Client = typeof import('../jobSearchClient.js');
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<Client['listOrgs']>(),
  listGrants: vi.fn<Client['listGrants']>(),
  createGrant: vi.fn<Client['createGrant']>(),
  revokeGrant: vi.fn<Client['revokeGrant']>(),
  queueCampaign: vi.fn<Client['queueCampaign']>(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../jobSearchClient.js', () => api);

const ISSUED: ApplyGrantView = {
  grantId: 'g1', subjectId: 'u1', grantedBy: 'u1', campaignId: 'spring-search', maxSubmits: 37, submitsUsed: 0,
  maxPrepared: 9, preparedUsed: 0, ratePerHour: 6, tiers: [], origins: ['boards.example.com', 'jobs.example.com'],
  expiresAt: '2027-03-14T00:00:00.000Z', revokedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
};

import { ApplyGrantPage } from '../ApplyGrantPage.js';

const field = (label: RegExp): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;

async function fillEverything(): Promise<void> {
  fireEvent.change(field(/campaign/i), { target: { value: 'spring-search' } });
  // Distinct from the DEFAULTS (25 / 10 / 4) and from every digit in the date.
  fireEvent.change(field(/maximum applications/i), { target: { value: '37' } });
  fireEvent.change(field(/queued for review/i), { target: { value: '9' } });
  fireEvent.change(field(/applications per hour/i), { target: { value: '6' } });
  fireEvent.change(field(/^sites/i), { target: { value: 'boards.example.com\njobs.example.com' } });
  fireEvent.change(field(/expires/i), { target: { value: '2027-03-14' } });
}

describe('the consent restatement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
    api.listGrants.mockResolvedValue([]);
    api.createGrant.mockResolvedValue(ISSUED);
    render(<ApplyGrantPage />);
  });
  afterEach(cleanup);

  it('will not let a user authorise until every bound is set', async () => {
    const issue = await screen.findByRole('button', { name: /issue grant/i });
    expect((issue as HTMLButtonElement).disabled, 'issuing must not be easier than revoking').toBe(true);
    expect(screen.getByText(/fill in every limit/i)).toBeTruthy();
  });

  it('states the bounds back in plain language once they are complete', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    // The specific numbers must appear — a generic "you are authorising this
    // campaign" would be the same non-consent in friendlier words.
    const summary = screen.getByText(/you are authorising up to/i);
    expect(summary.textContent).toContain('up to 37 automatic applications');
    expect(summary.textContent).toContain('at most 6 per hour');
    expect(summary.textContent, 'the site COUNT is part of the scope being consented to').toContain('on 2 sites');
    expect(summary.textContent, 'revocability is part of what makes this safe to agree to').toMatch(/revoke/i);
  });

  it('enables issuing only once the restatement exists, and issues EXACTLY the bounds restated', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    const issue = screen.getByRole('button', { name: /issue grant/i }) as HTMLButtonElement;
    expect(issue.disabled).toBe(false);
    // The consent is bound to the action: what is sent is what was said back.
    fireEvent.click(issue);
    await waitFor(() => expect(api.createGrant).toHaveBeenCalledWith('org-1', {
      campaignId: 'spring-search', maxSubmits: 37, maxPrepared: 9, ratePerHour: 6,
      origins: ['boards.example.com', 'jobs.example.com'],
      // `new Date('2027-03-14')` parses a date-only string as UTC midnight.
      expiresAt: '2027-03-14T00:00:00.000Z',
    }));
    expect(api.createGrant).toHaveBeenCalledTimes(1);
  });

  it('makes the restatement the BUTTON’s description, not text beside it', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    const issue = screen.getByRole('button', { name: /issue grant/i });
    const describedBy = issue.getAttribute('aria-describedby');
    expect(describedBy, 'a screen-reader user must hear the bounds as part of the control').toBe('job-search-consent');
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/you are authorising up to/i);
  });

  it('withdraws the restatement when a bound is removed', async () => {
    await screen.findByRole('button', { name: /issue grant/i });
    await fillEverything();
    // Clearing the sites removes the SCOPE, so the consent is no longer
    // describable and the button must lock again rather than silently
    // authorising an unscoped grant.
    fireEvent.change(field(/^sites/i), { target: { value: '' } });
    expect((screen.getByRole('button', { name: /issue grant/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/fill in every limit/i)).toBeTruthy();
  });
});
