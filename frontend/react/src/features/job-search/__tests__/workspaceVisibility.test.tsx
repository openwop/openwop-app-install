/**
 * ADR 1036 D10 — applications are workspace-visible (ADR 0546), and the page
 * where a candidate starts a search says so.
 *
 * Before: nothing told a member that colleagues can see their applications, and
 * the Applications lede said "sent for you" over a workspace-wide list. The
 * disclosure renders inside the org gate: with no workspace there is nothing to
 * disclose, so the zero-org state must not carry it.
 *
 * Break it by deleting the `workspaceVisibility` Notice from ApplyGrantPage (the
 * first case reds), or by moving it above `<OrgSelectionState>` (the second reds).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Org } from '../../crm/crmOrgClient.js';

let ORGS: Org[] = [{ orgId: 'org-1', name: 'Acme' }];

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../jobSearchClient.js', () => ({
  listOrgs: vi.fn(async (): Promise<Org[]> => ORGS),
  listGrants: vi.fn(async () => []),
  createGrant: vi.fn(),
  revokeGrant: vi.fn(),
  queueCampaign: vi.fn(),
}));

const { ApplyGrantPage } = await import('../ApplyGrantPage.js');

const DISCLOSURE = 'Applications in this workspace are visible to its members. Your apply grants, answer bank, preferences and verification links stay yours alone.';

afterEach(() => { cleanup(); ORGS = [{ orgId: 'org-1', name: 'Acme' }]; });

describe('ADR 1036 D10 — the workspace-visibility disclosure', () => {
  it('is stated on the page where a candidate starts a search', async () => {
    render(<ApplyGrantPage />);
    expect(await screen.findByText(DISCLOSURE)).toBeTruthy();
  });

  it('is NOT shown when there is no workspace to disclose about', async () => {
    ORGS = [];
    render(<ApplyGrantPage />);
    // The zero-org state renders; wait for the orgs read to settle first.
    await screen.findByText(/workspace|organization/i);
    expect(screen.queryByText(DISCLOSURE)).toBeNull();
  });
});
