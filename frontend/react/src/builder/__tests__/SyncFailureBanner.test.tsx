/**
 * WFMU-1 (ADR 0481 collab lane) + its sibling — the autosave-failure banner must
 * ANNOUNCE to a screen reader. Both branches are Notices that mount ALREADY
 * containing their text, and a mounted-with-content live region announces only
 * later MUTATIONS (Notice.tsx) — so without the imperative `announce` primitive
 * the message is silent. The 409 `workflow_room_live` warning (role=status,
 * polite) was definitely silent; the error branch (role=alert) relied on
 * alert-on-insertion, which Notice.tsx says is NOT verified — so it is routed
 * through `announce` too, assertively. Born-red: strip either `announce` prop and
 * the matching assertion fails (0 calls).
 *
 * The expected announcement is the en COPY as a literal — never read back from
 * the rendered banner, which would agree with a wrong-but-consistent key (a 401
 * spoken AND shown as the server copy would pass).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../../ui/announce.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../ui/announce.js')>();
  return { ...mod, announce: vi.fn() };
});
const { announce } = await import('../../ui/announce.js');
const { SyncFailureBanner } = await import('../SyncFailureBanner.js');
const { useBuilderStore } = await import('../store/builderStore.js');

type BuilderState = ReturnType<typeof useBuilderStore.getState>;
/** Typed: replaces the sync fields wholesale (an absent status is REMOVED, not
 *  set to undefined), so no cast is needed under exactOptionalPropertyTypes. */
const setSync = (syncState: BuilderState['syncState'], status?: number, reason?: string): void =>
  useBuilderStore.setState((st) => {
    const { syncFailureStatus: _status, syncFailureReason: _reason, ...rest } = st;
    return { ...rest, syncState, ...(status !== undefined ? { syncFailureStatus: status } : {}), ...(reason !== undefined ? { syncFailureReason: reason } : {}) };
  }, true);

const TITLE = 'This workflow isn\'t saved to your account';
const AUTH = 'Your session expired, so recent edits exist only in this browser. Sign in again to save them.';
const SERVER = 'The server rejected the save, so recent edits exist only in this browser. Make another edit to retry.';
const ROOM_LIVE = 'This workflow is saving through a live session. Join the session (Go live) to edit together — solo edits stay in this browser until it ends.';

afterEach(() => {
  cleanup();
  vi.mocked(announce).mockClear();
  setSync('pending');
});
beforeEach(() => vi.mocked(announce).mockClear());

describe('SyncFailureBanner — screen-reader announcement (WFMU-1 + sibling)', () => {
  it('the 409 workflow_room_live WARNING announces POLITELY, with the SAME text it renders', () => {
    setSync('failed', 409, 'workflow_room_live');
    const { container } = render(<SyncFailureBanner />);
    expect(container.querySelector('p')?.textContent).toBe(ROOM_LIVE);
    // The announced string is EXACTLY the room-live copy — a fix that announced
    // the WRONG key would pass a "non-empty string" check but fail this.
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(ROOM_LIVE, { assertive: false }); // warning STATE = polite
  });

  it('an ERROR (401 auth) announces ASSERTIVELY, carrying both the title and the guidance', () => {
    setSync('failed', 401);
    const { container } = render(<SyncFailureBanner />);
    expect(container.querySelector('strong')?.textContent).toBe(TITLE);
    expect(container.querySelector('p')?.textContent).toBe(AUTH);
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    // full message (title + the AUTH guidance), assertively — unsaved work is a fault.
    expect(vi.mocked(announce)).toHaveBeenCalledWith(`${TITLE} ${AUTH}`, { assertive: true });
  });

  it('a 500 server error also announces assertively (every error status, not just 401)', () => {
    setSync('failed', 500);
    render(<SyncFailureBanner />);
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(`${TITLE} ${SERVER}`, { assertive: true });
  });

  it('renders nothing (and announces nothing) when the sync is not failed', () => {
    setSync('synced');
    const { container } = render(<SyncFailureBanner />);
    expect(container.firstChild).toBeNull();
    expect(vi.mocked(announce)).not.toHaveBeenCalled();
  });
});
