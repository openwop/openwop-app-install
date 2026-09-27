/**
 * A failed twin read must not OFFER THE LINK — the escalation of the
 * permanent-loading class (#2593) from "says something false" to "offers a
 * destructive write premised on something false".
 *
 * `!link` is the branch that renders both "{persona} isn't a twin of anyone
 * yet." and the "Make {persona} a twin of me" button. Resolving a failed read to
 * an empty view lands on it.
 *
 * The server cannot be the guard here, and that was checked rather than assumed:
 * `linkTwin` (`host/twinService.ts`) has NO already-linked rejection — it
 * silently re-links and revokes the prior twin's active grant. That is correct
 * for a deliberate admin re-link and indistinguishable from this one. So an
 * admin told "isn't a twin of anyone yet" by a network error can click once and
 * reassign someone else's twin, revoking their recall grant.
 *
 * Both arms are asserted: a failed read offers nothing, a successful read still
 * offers everything. The failure mode of this fix is a twin panel nobody can use.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getAgentTwin, linkTwinToUser } = vi.hoisted(() => ({
  getAgentTwin: vi.fn(), linkTwinToUser: vi.fn(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../twinClient.js', async (orig) => ({
  ...(await orig<typeof import('../twinClient.js')>()),
  getAgentTwin, linkTwinToUser,
}));
vi.mock('../../profiles/useMyIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../profiles/useMyIdentity.js')>()),
  useMyIdentity: () => ({ status: 'known', userId: 'u-me' }),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));

import { AgentTwinPanel } from '../AgentTwinPanel.js';

/** The agent is ALREADY someone else's twin — the state a failed read hides. */
const LINKED_TO_SOMEONE_ELSE = {
  link: { userId: 'u-other', linkedBy: 'admin', linkedAt: '2026-01-01T00:00:00Z' },
  grant: null,
};
const UNLINKED = { link: null, grant: null };

const mount = async (): Promise<void> => {
  render(<AgentTwinPanel rosterId="r1" persona="Ada" />);
  await act(async () => {});
};

const linkButton = (): HTMLElement | undefined =>
  screen.queryAllByRole('button').find((b) => /Make Ada a twin of me/.test(b.textContent ?? ''));

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getAgentTwin.mockResolvedValue(UNLINKED);
  linkTwinToUser.mockResolvedValue(UNLINKED);
});

describe('a failed twin read offers no link', () => {
  it('does not claim the agent is unlinked', async () => {
    getAgentTwin.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).not.toContain('isn’t a twin of anyone yet');
    expect(document.body.textContent).toContain('failed read, not an answer');
  });

  it('withholds the link button, so the destructive write cannot be reached', async () => {
    getAgentTwin.mockRejectedValue(new Error('503'));
    await mount();
    expect(linkButton()).toBeUndefined();
    expect(linkTwinToUser).not.toHaveBeenCalled();
  });

  it('does not sit on the loading branch either', async () => {
    // The bug this replaced: `view === null` meant both "loading" and "failed".
    getAgentTwin.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).not.toContain('Loading');
  });

  it('the retry recovers, and recovers into the REAL state', async () => {
    // Not just "the error clears" — the panel must end up showing the link it
    // could not read, which is the whole point of withholding the button.
    getAgentTwin.mockRejectedValueOnce(new Error('503')).mockResolvedValue(LINKED_TO_SOMEONE_ELSE);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(document.body.textContent).not.toContain('failed read, not an answer');
    expect(linkButton()).toBeUndefined(); // already linked — a different branch
  });

  it('a SUCCESSFUL read of an unlinked agent still offers the link', async () => {
    // The failure mode of this fix: a panel that never lets anyone link.
    await mount();
    expect(document.body.textContent).toContain('isn’t a twin of anyone yet');
    expect(linkButton()).toBeTruthy();
    await act(async () => { fireEvent.click(linkButton()!); });
    expect(linkTwinToUser).toHaveBeenCalledWith('r1', 'u-me');
  });
});
