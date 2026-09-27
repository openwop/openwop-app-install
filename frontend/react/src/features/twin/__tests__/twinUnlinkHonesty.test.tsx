/**
 * HIGH-1 / TWIN-UX-3 (unlink lane) + TWIN-UX-13 — the two honesty branches the
 * review found missing after the first pass:
 *
 *   1. `removed:false` — a stale second tab that unlinks an already-unlinked
 *      agent must hear "there was no twin link to remove", never "Twin link
 *      removed." The key existed in all four locales and was referenced NOWHERE;
 *      these tests are what make it reachable and keep it so.
 *
 *   2. The write/refetch split — a revoke that SUCCEEDED followed by a re-read
 *      that failed must report the revoke's own outcome and degrade the VIEW,
 *      not invent a failure for the consent action (TWIN-UX-13's fix, which had
 *      no test).
 *
 *   3. MEDIUM-2 — the self-case confirm body is its own sentence
 *      (`unlinkConfirmBodySelf`), not a pronoun spliced into `{{name}}'s`
 *      ("revokes your's consent").
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getAgentTwin, unlinkTwin, revokeRecall, confirmMock } = vi.hoisted(() => ({
  getAgentTwin: vi.fn(), unlinkTwin: vi.fn(), revokeRecall: vi.fn(), confirmMock: vi.fn(),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../twinClient.js', async (orig) => ({
  ...(await orig<typeof import('../twinClient.js')>()),
  getAgentTwin, unlinkTwin, revokeRecall,
}));
vi.mock('../../../ui/confirm.js', async (orig) => ({
  ...(await orig<typeof import('../../../ui/confirm.js')>()),
  confirm: confirmMock,
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

const LINKED_TO_ME = {
  link: { userId: 'u-me', linkedBy: 'admin', linkedAt: '2026-01-01T00:00:00Z' },
  grant: { scopes: ['memory'], version: 1, grantedAt: '2026-01-02T00:00:00Z' },
};

const mount = async (): Promise<void> => {
  render(<AgentTwinPanel rosterId="r1" persona="Ada" />);
  await act(async () => {});
};
const clickButton = async (name: RegExp): Promise<void> => {
  const b = screen.getAllByRole('button').find((x) => name.test(x.textContent ?? ''));
  expect(b, `button ${name} must be on screen`).toBeTruthy();
  await act(async () => { fireEvent.click(b!); });
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getAgentTwin.mockResolvedValue(LINKED_TO_ME);
  unlinkTwin.mockResolvedValue({ removed: true });
  revokeRecall.mockResolvedValue({ removed: true });
  confirmMock.mockResolvedValue(true);
});

describe('unlink no-op honesty (removed:false)', () => {
  it('a real unlink says "Twin link removed."', async () => {
    await mount();
    await clickButton(/^Unlink$/);
    expect(document.body.textContent).toContain('Twin link removed.');
    expect(document.body.textContent).not.toContain('There was no twin link to remove.');
  });

  it('a stale-tab unlink that removed nothing says so, and does NOT claim removal', async () => {
    unlinkTwin.mockResolvedValue({ removed: false });
    await mount();
    await clickButton(/^Unlink$/);
    expect(document.body.textContent).toContain('There was no twin link to remove.');
    expect(document.body.textContent).not.toContain('Twin link removed.');
  });
});

describe('MEDIUM-2 — the self-case confirm body', () => {
  it('uses the dedicated self sentence, never a spliced possessive', async () => {
    await mount();
    await clickButton(/^Unlink$/);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const body = String(confirmMock.mock.calls[0]![0].body);
    expect(body).toContain('revokes your consent');
    // The broken splice this replaces: `{{name}}'s` filled with "your".
    expect(body).not.toContain('your’s');
    expect(body).not.toContain("your's");
  });
});

describe('TWIN-UX-13 — the write/refetch split', () => {
  it('a successful revoke whose re-read fails reports SUCCESS and degrades the view', async () => {
    await mount();
    getAgentTwin.mockRejectedValue(new Error('503'));
    await clickButton(/^Revoke recall$/);
    // The consent action's own outcome, reported on its own:
    expect(document.body.textContent).toContain('Recall revoked.');
    // The VIEW degrades to the failed-read state — no invented action failure:
    expect(document.body.textContent).toContain('failed read, not an answer');
    expect(document.body.textContent).not.toContain('Action failed.');
  });

  it('a FAILED revoke still reports the failure (the split did not eat real errors)', async () => {
    revokeRecall.mockRejectedValue(new Error('revoke exploded'));
    await mount();
    await clickButton(/^Revoke recall$/);
    expect(document.body.textContent).toContain('revoke exploded');
    expect(document.body.textContent).not.toContain('Recall revoked.');
  });
});
