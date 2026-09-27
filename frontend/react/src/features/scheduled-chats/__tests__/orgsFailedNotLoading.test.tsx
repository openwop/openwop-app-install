/**
 * Sibling of `chat-widget/__tests__/orgsFailedNotLoading` — the same shape, on
 * the page that schedules RECURRING, SIDE-EFFECTING agent runs.
 *
 * `listOrgs().catch(() => setOrgs([]))` leaves `orgId` empty, so the load effect
 * never fires and `rows` stays `null` — a skeleton that never resolves and no
 * error anywhere. This page's ROWS read was already hardened (its error branch
 * carries a comment about not offering "create a scheduled chat" over a failed
 * read, because acting on that duplicates a cron job). The organization read one
 * level up bypassed all of it.
 *
 * HG-4 moved the page onto `ui/useOrgSelection` + `ui/OrgSelectionState`: the
 * hand-rolled `.catch` set BOTH `setOrgs([])` and the flag, so it still carried
 * the sentinel the flag exists to replace, and it had no zero-organization branch
 * at all. The strings asserted below are the SHARED ones, so a page that re-grew
 * its own copy — or the old "workspace" noun — goes red here.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listOrgs, listScheduledChats } = vi.hoisted(() => ({ listOrgs: vi.fn(), listScheduledChats: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../client/scheduledChatsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/scheduledChatsClient.js')>()),
  listOrgs, listScheduledChats,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));

import { ScheduledChatsPage } from '../ScheduledChatsPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const CHAT = {
  scheduledChatId: 's1', agentId: 'a1', cron: '0 9 * * *', enabled: true,
  prompt: 'daily standup', timezone: 'UTC',
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><ScheduledChatsPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listScheduledChats.mockResolvedValue([CHAT]);
});

const FAILED = 'The scheduled chats could not be read. This is a failed read, not an empty organization list.';

describe('a failed ORGANIZATION read is not a loading schedule', () => {
  it('says so instead of rendering the skeleton forever', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(FAILED);
    expect(document.querySelector('.skeleton')).toBeNull();
    // The zero-org state is a different claim, and the table's "create a scheduled
    // chat" instruction is the one that mints a DUPLICATE cron job when acted on.
    expect(document.body.textContent).not.toContain('No organizations');
    expect(document.body.textContent).not.toContain('No scheduled chats yet.');
    expect(listScheduledChats).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(FAILED);
  });

  it('read SUCCEEDS with []: the real zero-organization state, not a failure and not a skeleton', async () => {
    // The other polarity — and before HG-4 this page had no branch for it at all:
    // `orgId` stayed '', the rows load never fired, and the skeleton never resolved.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain('A scheduled chat belongs to an organization.');
    expect(document.body.textContent).not.toContain(FAILED);
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listScheduledChats).not.toHaveBeenCalled();
  });

  it('an organization with genuinely no scheduled chats still reads as empty', async () => {
    // The failure mode of this fix: a real empty state replaced by an org claim.
    listScheduledChats.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No scheduled chats yet.');
    expect(document.body.textContent).not.toContain(FAILED);
    expect(document.body.textContent).not.toContain('No organizations');
  });
});
