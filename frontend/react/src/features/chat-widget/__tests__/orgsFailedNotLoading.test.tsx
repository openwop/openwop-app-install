/**
 * The permanent-loading class re-entering ONE LEVEL UP, on three pages whose
 * rows read was already hardened.
 *
 * All three do `listOrgs().catch(() => setOrgs([]))`. `[]` means both "this
 * tenant has no workspaces" and "we could not read them", and the second reading
 * is not cosmetic here: `orgId` stays `''`, so the `if (orgId) load(orgId)`
 * effect NEVER FIRES. `rows` therefore stays `null` and `error` stays `null` —
 * the page renders its loading skeleton forever, with nothing anywhere saying
 * why. The rows-level fix cannot catch it, because THE STATE THAT FAILED IS NOT
 * THE STATE THE PAGE RENDERS.
 *
 * Covered here for `chat-widget`; the sibling files cover `scheduled-chats` and
 * `custom-domains`, which have the identical shape.
 *
 * HG-4 UPDATE — this page has since moved onto `ui/useOrgSelection` +
 * `ui/OrgSelectionState`, so the copy below is the SHARED copy and the
 * zero-organization arm is new: the page had NO branch for it, so a tenant that
 * genuinely has none reached the identical permanent skeleton by the honest
 * route. Strings are asserted in full, not as a regex spanning old and new
 * wording — a test indifferent to the noun cannot guard the noun.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listWidgets } = vi.hoisted(() => ({ listOrgs: vi.fn(), listWidgets: vi.fn() }));
vi.mock('../../../client/chatWidgetClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/chatWidgetClient.js')>()),
  listOrgs, listWidgets,
}));
// No `useFeatureAccess` mock: `WidgetsPage` does not import it. `chat-widget`
// graduated to always-on (ADR 0134, no `toggleDefault`), and the page's
// hard-coded always-on `access` literal plus its unreachable not-enabled branch
// are gone. A mock of a module the subject never imports is scenery that makes
// a file look like it covers a gate.

import { WidgetsPage } from '../WidgetsPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const WIDGET = { widgetId: 'w1', agentId: 'a1', allowedDomains: ['example.com'], enabled: true };

const mount = async (): Promise<void> => {
  render(<WidgetsPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listWidgets.mockResolvedValue([WIDGET]);
});

describe('a failed WORKSPACE read is not a loading widget list', () => {
  it('stops rendering the skeleton forever with no explanation', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The widget list could not be read. This is a failed read, not an empty organization list.',
    );
    // …and never as the empty answer: a failed read may not borrow it.
    expect(document.body.textContent).not.toContain('No organizations');
    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('the retry re-runs the workspace read, not just the rows read', async () => {
    // The effect is the ONLY place `listOrgs` runs, so a retry that does not
    // re-trigger it would clear the error and restore the permanent skeleton.
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('a tenant that genuinely has no organizations is NOT reported as failed', async () => {
    // The failure mode of this fix: a real empty tenant told its read broke.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('read SUCCEEDS with []: the zero-organization state, never an endless skeleton', async () => {
    // NEW with HG-4. This page had a failed-read branch and no empty-read one, so
    // `orgs === []` left `orgId` '', the widgets read never fired, `rows` stayed
    // null, and the skeleton below rendered forever — the same dead end, reached
    // from the honest side.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain(
      'Chat widgets belong to an organization.',
    );
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listWidgets).not.toHaveBeenCalled();
  });

  it('a successful read still lists the widgets', async () => {
    await mount();
    expect(document.body.textContent).toContain('example.com');
  });
});
