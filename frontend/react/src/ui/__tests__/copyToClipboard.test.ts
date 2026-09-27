/**
 * The two silent-copy shapes this helper exists to kill.
 *
 * Both were real, both were written independently in several files, and both
 * present to the user identically: press Copy, nothing happens, paste something
 * stale. These assert on what the USER IS TOLD, not on whether `writeText` was
 * called — the defect was never a missing call, it was a missing answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../toast.js', () => ({ toast: toasts }));
vi.mock('../../i18n/index.js', () => ({
  default: { t: (k: string) => k },
}));

import { copyToClipboard } from '../copyToClipboard.js';

const setClipboard = (v: unknown): void => {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: v, configurable: true });
};

beforeEach(() => {
  toasts.success.mockClear();
  toasts.error.mockClear();
});
afterEach(() => { setClipboard(undefined); });

describe('copyToClipboard', () => {
  it('reports success only when the write actually resolved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    await expect(copyToClipboard('npm i -g @openwop/cli')).resolves.toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('npm i -g @openwop/cli');
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  // SHAPE 1 — no clipboard API at all (any non-secure context). The old code
  // used `navigator.clipboard?.writeText(t).then(...)`, and optional chaining
  // short-circuits the WHOLE chain: no toast, no error, no throw. Pure silence.
  it('says so when there is no clipboard API, instead of doing nothing', async () => {
    setClipboard(undefined);
    await expect(copyToClipboard('x')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('treats a clipboard object without writeText as unavailable', async () => {
    setClipboard({});
    await expect(copyToClipboard('x')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  // SHAPE 2 — the write is REJECTED (permission denied, lost focus). The old
  // code caught it into an empty block with a comment saying so.
  it('says so when the write is rejected, instead of swallowing it', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });
    await expect(copyToClipboard('x')).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('never claims success on a failure', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('nope')) });
    await copyToClipboard('x', 'Copied!');
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('uses the caller message on success and the manual-copy message on failure', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await copyToClipboard('x', 'Install command copied');
    expect(toasts.success).toHaveBeenCalledWith('Install command copied');

    setClipboard(undefined);
    await copyToClipboard('x', 'Install command copied');
    expect(toasts.error).toHaveBeenCalledWith('chrome:copyFailedManual');
  });
});

/**
 * `successMessage: null` — for callers with their own inline "Copied ✓".
 *
 * The asymmetry is the point and is asserted in both directions: success can be
 * suppressed because the caller shows it; FAILURE CANNOT, because the silence
 * is the defect this helper exists to remove.
 */
describe('suppressible success, non-suppressible failure', () => {
  it('stays quiet on success when the caller owns the affordance', async () => {
    setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await expect(copyToClipboard('x', null)).resolves.toEqual({ ok: true });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('STILL reports a rejected write when success is suppressed', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(copyToClipboard('x', null)).resolves.toEqual({ ok: false, reason: 'rejected' });
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });

  it('STILL reports an absent clipboard when success is suppressed', async () => {
    setClipboard(undefined);
    await expect(copyToClipboard('x', null)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(toasts.error).toHaveBeenCalledTimes(1);
  });
});
