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

const setSync = (patch: Record<string, unknown>) => useBuilderStore.setState(patch as never);

afterEach(() => {
  cleanup();
  vi.mocked(announce).mockClear();
  setSync({ syncState: 'pending', syncFailureStatus: undefined, syncFailureReason: undefined });
});
beforeEach(() => vi.mocked(announce).mockClear());

describe('SyncFailureBanner — screen-reader announcement (WFMU-1 + sibling)', () => {
  it('the 409 workflow_room_live WARNING announces POLITELY, with the SAME text it renders', () => {
    setSync({ syncState: 'failed', syncFailureStatus: 409, syncFailureReason: 'workflow_room_live' });
    const { container } = render(<SyncFailureBanner />);
    const pText = container.querySelector('p')?.textContent ?? '';
    expect(pText.length).toBeGreaterThan(0);
    // The announced string must be EXACTLY the banner's visible text — a fix that
    // announced the WRONG key would pass a "non-empty string" check but fail this.
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(pText, { assertive: false }); // warning STATE = polite
  });

  it('an ERROR (401 auth) announces ASSERTIVELY, carrying both the title and the guidance', () => {
    setSync({ syncState: 'failed', syncFailureStatus: 401, syncFailureReason: undefined });
    const { container } = render(<SyncFailureBanner />);
    const title = container.querySelector('strong')?.textContent ?? '';
    const detail = container.querySelector('p')?.textContent ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(detail.length).toBeGreaterThan(0);
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    // full message (title + guidance), assertively — unsaved work is a fault.
    expect(vi.mocked(announce)).toHaveBeenCalledWith(`${title} ${detail}`, { assertive: true });
  });

  it('a 500 server error also announces assertively (every error status, not just 401)', () => {
    setSync({ syncState: 'failed', syncFailureStatus: 500, syncFailureReason: undefined });
    render(<SyncFailureBanner />);
    expect(vi.mocked(announce)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(expect.any(String), { assertive: true });
  });

  it('renders nothing (and announces nothing) when the sync is not failed', () => {
    setSync({ syncState: 'synced', syncFailureStatus: undefined, syncFailureReason: undefined });
    const { container } = render(<SyncFailureBanner />);
    expect(container.firstChild).toBeNull();
    expect(vi.mocked(announce)).not.toHaveBeenCalled();
  });
});
