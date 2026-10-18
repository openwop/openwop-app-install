/**
 * EMPTY-ON-FAIL-5 (ADR 0779 D7, the RTP-EMPTY-1 class) — a failed grants read is
 * NOT "No auto-apply authority issued".
 *
 * The catch set `grants` to [], so the table's empty state told the user "Nothing
 * is being submitted on your behalf" from a read that never came back: a false
 * SAFETY assurance on the page that controls automatic job applications. On a
 * failed read the page must say it could not CHECK, never that nothing is being
 * submitted.
 *
 * Break it by dropping the `grantsFailed ?` branch in ApplyGrantPage (or by
 * restoring `setGrants([])` in the catch with the flag ignored): the failure card
 * disappears and the empty "Nothing is being submitted" copy renders instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ApplyGrantView } from '../jobSearchClient.js';
import type { Org } from '../../crm/crmOrgClient.js';

const listGrants = vi.fn<(orgId: string) => Promise<ApplyGrantView[]>>();
const ORGS: Org[] = [{ orgId: 'org-1', name: 'Acme' }];

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async (): Promise<Org[]> => ORGS),
  listGrants: (orgId: string) => listGrants(orgId),
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
  queueCampaign: vi.fn(),
}));

const { ApplyGrantPage } = await import('../ApplyGrantPage.js');

const FAILED_TITLE = 'Couldn’t check your auto-apply authority';
const FAILED_BODY = 'Your grants could not be read, so we cannot tell whether anything is being submitted on your behalf. Retry before relying on this page.';
const EMPTY_TITLE = 'No auto-apply authority issued';
const EMPTY_BODY = 'Nothing is being submitted on your behalf. Issue a grant to let a campaign apply automatically within limits you set.';

beforeEach(() => { listGrants.mockReset(); });
afterEach(cleanup);

describe('EMPTY-ON-FAIL-5 — a failed grants read never claims nothing is being submitted', () => {
  it('a rejected read says it could not check, and NOT "Nothing is being submitted on your behalf"', async () => {
    listGrants.mockRejectedValue(new Error('grants_500'));
    render(<ApplyGrantPage />);
    expect(await screen.findByText(FAILED_TITLE)).toBeTruthy();
    expect(screen.getByText(FAILED_BODY)).toBeTruthy();
    expect(screen.queryByText(EMPTY_TITLE)).toBeNull();
    expect(screen.queryByText(EMPTY_BODY)).toBeNull();
  });

  it('Retry re-reads, and a successful empty read then states there are no grants', async () => {
    listGrants.mockRejectedValueOnce(new Error('grants_500')).mockResolvedValue([]);
    render(<ApplyGrantPage />);
    await screen.findByText(FAILED_TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();
    expect(listGrants).toHaveBeenCalledTimes(2);
  });

  it('a successful empty read still says no authority is issued (positive control)', async () => {
    listGrants.mockResolvedValue([]);
    render(<ApplyGrantPage />);
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByText(EMPTY_BODY)).toBeTruthy();
    expect(screen.queryByText(FAILED_TITLE)).toBeNull();
  });
});
