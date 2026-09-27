/**
 * UX_UPGRADE-app-builder AB-G1 + AB-G4 — the GitHub sync modal's two honesty
 * gaps.
 *
 * AB-G1: `getSyncBinding` returns `null` for NOT BOUND and THROWS when the read
 * fails, so `binding === null` alone cannot distinguish them. The modal treated
 * both as "not bound" and rendered the bind form — whose submit mints a NEW
 * webhook secret. Rebinding a canvas that was already bound leaves GitHub
 * signing with the old secret, so a failed READ could break a working webhook.
 *
 * AB-G4: a push that SUCCEEDED with warnings was rendered in the ERROR notice,
 * so "pushed, but 2 components had no equivalent" read as "the sync failed".
 * The sibling PublishModal already keeps the two apart.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { SyncModal } from '../SyncModal.js';

const { getSyncBinding, syncCanvasNow } = vi.hoisted(() => ({
  getSyncBinding: vi.fn(), syncCanvasNow: vi.fn(),
}));

// Spread the real module: EXPORT_TARGETS and the rest are read by the form.
vi.mock('../canvasEditorClient.js', async (orig) => ({
  ...(await orig<typeof import('../canvasEditorClient.js')>()),
  getSyncBinding, syncCanvasNow,
}));

const BINDING = {
  canvasId: 'cv-1', owner: 'acme', repo: 'storefront', branch: 'main',
  target: 'react-tailwind' as const, webhookId: 'wh-1', boundBy: 'u1', boundAt: '2026-07-25T00:00:00Z',
};

const open = async (): Promise<void> => {
  render(<SyncModal orgId="o1" canvasId="cv-1" onClose={() => {}} />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => { getSyncBinding.mockReset(); syncCanvasNow.mockReset(); });

describe('AB-G1 — a failed binding read is not "not bound"', () => {
  it('offers a retry instead of the bind form', async () => {
    getSyncBinding.mockRejectedValue(new Error('502 upstream'));
    await open();
    // The destructive path must be absent, not merely discouraged: submitting
    // the bind form would rotate the webhook secret.
    expect(screen.queryByLabelText('Repository owner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Bind repository' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // And the reason is still shown, not swallowed.
    expect(document.body.textContent).toContain('502 upstream');
  });

  it('the retry re-reads, and a binding that WAS there appears', async () => {
    getSyncBinding.mockRejectedValueOnce(new Error('502 upstream'));
    getSyncBinding.mockResolvedValueOnce(BINDING);
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(document.body.textContent).toContain('acme/storefront');
    // The stale error must not outlive the successful re-read.
    expect(document.body.textContent).not.toContain('502 upstream');
  });

  it('a genuine null STILL shows the bind form', async () => {
    // The fix must not cost the real not-bound path its only action.
    getSyncBinding.mockResolvedValue(null);
    await open();
    expect(screen.getByLabelText('Repository owner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bind repository' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('AB-G4 — warnings on a successful push are warnings', () => {
  it('renders them as a warning, not as an error', async () => {
    getSyncBinding.mockResolvedValue(BINDING);
    syncCanvasNow.mockResolvedValue({
      outcome: 'pushed', repoUrl: 'https://github.com/acme/storefront', branch: 'main',
      filesPushed: 12, deletedStale: 0, modelVersion: 3,
      warnings: ['screens[1].components[0]: no react-tailwind equivalent'],
    });
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sync now' })); });
    const notice = document.querySelector('.alert.warning');
    expect(notice?.textContent).toContain('no react-tailwind equivalent');
    expect(document.querySelector('.alert.error')).toBeNull();
  });

  it('a real failure is still an error', async () => {
    getSyncBinding.mockResolvedValue(BINDING);
    syncCanvasNow.mockRejectedValue(new Error('403 forbidden'));
    await open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sync now' })); });
    expect(document.querySelector('.alert.error')?.textContent).toContain('403 forbidden');
  });
});
