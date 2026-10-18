/**
 * CAPUX-1 — a DISCLOSURE must not be decided from an unread flag.
 *
 * THE BUG THIS PINS. The banner took `useDemoMode()` (a boolean) and kept its
 * probe in a `number | null`, so THREE distinct states collapsed into two:
 * "not resolved yet", "the read failed", and "resolved, host is durable" all
 * rendered nothing. On a host that genuinely loses the visitor's work, a failed
 * capability read therefore produced silence — and because every consumer of
 * `getCapabilities()` meets a failure with a `catch` that renders nothing, that
 * silence was invisible to 16,132 passing tests. It took a browser to see it.
 *
 * `client/demoMode.ts` had already argued this exact case for `/privacy` and
 * shipped `demoModeStatus()` / `useDemoModeStatus()` with an `'unknown'` state
 * to solve it. This surface simply never adopted it.
 *
 * The assertion that matters is the THIRD one: a failed read must SAY so. The
 * other two guard against over-correcting into a banner that cries wolf.
 *
 * ON THE FOURTH TEST, and why it exists. `undetermined` has two arms —
 * `probe === 'failed'` and `demoStatus === 'unknown'`. In the common path they
 * are REDUNDANT: both reads go through the same `getCapabilities()` cache, so
 * they fail together, and sabotaging either arm alone leaves the other covering
 * it (measured: only removing BOTH reddens tests 1-3). An arm no test can
 * falsify is an arm nobody can safely delete later. The fourth test isolates the
 * probe arm by pre-warming `demoMode` successfully and failing only the banner's
 * own later read — the narrow real case where the two diverge.
 *
 * Absence is only asserted AFTER the reads settle (the demoMode status reads
 * 'clean' and both capability reads were made) — never on a fixed sleep, which
 * passes while the probe is still in flight. Copy is pinned as en literals.
 *
 * Sabotage that turns it red: a storage regex that never matches, dropping the
 * announce effect, dropping the `probe === 'failed'` arm, rendering or speaking
 * a durable host's `probe === 0`, mapping a failed read to 0, or adding a
 * concrete durability claim to the "unknown" copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../auth/useAuth.js', () => ({ useAuth: () => ({ user: null }) }));

vi.mock('../../ui/announce.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../ui/announce.js')>();
  return { ...mod, announce: vi.fn() };
});
const { announce } = await import('../../ui/announce.js');

const getCapabilities = vi.fn();
vi.mock('../../client/runsClient.js', () => ({ getCapabilities: (...a: unknown[]) => getCapabilities(...a) }));

const { InMemoryHostBanner } = await import('../InMemoryHostBanner.js');
const demoMode = await import('../../client/demoMode.js');

const IN_MEM = { capabilities: { hostSurfaces: [{ name: 'host.cache', supported: true, implementation: 'in-memory' }] }, demoMode: true };
const DURABLE = { capabilities: { hostSurfaces: [{ name: 'host.cache', supported: true, implementation: 'postgres' }] }, demoMode: false };

const draw = () => render(<MemoryRouter><InMemoryHostBanner /></MemoryRouter>);

/** Settle signal for a DURABLE host: demoMode resolved 'clean' and the banner's
 *  own probe read has been made and drained. */
async function settledDurable(): Promise<void> {
  await waitFor(() => expect(demoMode.demoModeStatus()).toBe('clean'));
  await waitFor(() => expect(getCapabilities).toHaveBeenCalledTimes(2));
  await act(async () => { await Promise.all(getCapabilities.mock.results.map((r) => r.value)); });
}

beforeEach(() => {
  localStorage.clear();
  demoMode.clearDemoModeCache();
  getCapabilities.mockReset();
  vi.mocked(announce).mockClear();
});
afterEach(cleanup);

describe('CAPUX-1 — the in-memory disclosure distinguishes unknown from off', () => {
  it('in-memory host: discloses — with the demo copy and the privacy link', async () => {
    getCapabilities.mockResolvedValue(IN_MEM);
    draw();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Anonymous demo session.'));
    expect(screen.getByRole('status').textContent).not.toContain('Storage durability unknown.');
    expect(screen.getByRole('link', { name: /Privacy & cookies/ }).getAttribute('href')).toBe('/privacy');
  });

  it('a FAILED read is ANNOUNCED — this region mounts with its content, so the live role alone says nothing', async () => {
    getCapabilities.mockRejectedValue(new Error('network'));
    draw();
    await screen.findByRole('status');
    await waitFor(() => expect(vi.mocked(announce).mock.calls.length).toBeGreaterThan(0));
    expect(String(vi.mocked(announce).mock.calls[0]?.[0] ?? '')).toMatch(/^Storage durability unknown\. We couldn't read this host's storage configuration/);
  });

  it('a durable host announces NOTHING — the primitive must not fire when there is nothing to disclose', async () => {
    getCapabilities.mockResolvedValue(DURABLE);
    draw();
    await settledDurable();
    expect(vi.mocked(announce)).not.toHaveBeenCalled();
  });

  it('durable host: stays silent — silence is correct when we KNOW there is nothing to disclose', async () => {
    getCapabilities.mockResolvedValue(DURABLE);
    draw();
    await settledDurable();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('probe fails AFTER demoMode resolved: still discloses — isolates the probe arm', async () => {
    // Pre-warm demoMode on a successful read, so `demoStatus` is 'clean', NOT
    // 'unknown'. Only the banner's own probe then fails.
    getCapabilities.mockResolvedValue(DURABLE);
    await demoMode.loadDemoMode();
    expect(demoMode.demoModeStatus(), 'the pre-warm must succeed or this proves nothing').toBe('clean');
    getCapabilities.mockRejectedValue(new Error('network'));
    draw();
    const el = await screen.findByRole('status');
    expect(el.textContent ?? '').toContain('Storage durability unknown.');
    expect(el.textContent ?? '').not.toContain('not durable');
  });

  it('FAILED read: says the durability is unknown, rather than implying it by omission', async () => {
    getCapabilities.mockRejectedValue(new Error('network'));
    draw();
    const el = await screen.findByRole('status');
    expect(el.textContent ?? '').toContain('Storage durability unknown.');
    // And it must NOT assert either concrete claim it cannot support: the
    // non-durable copy ("Data on this host is not durable … in memory") or the
    // demo copy.
    expect(el.textContent ?? '').not.toContain('not durable');
    expect(el.textContent ?? '').not.toContain('in memory');
    expect(el.textContent ?? '').not.toContain('Anonymous demo session');
  });
});
