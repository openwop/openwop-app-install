/**
 * ADR 0493 — the self-test's VERDICT logic.
 *
 * The failure mode this guards is specific and nasty: a security page that shows
 * green ticks it did not earn is worse than the prose it replaced. So the cases
 * asserted here are mostly the ones that must NOT read as a pass — an unanswered
 * probe, a forwarded (i.e. un-refused) method, a non-opaque origin, a resolved
 * egress fetch — plus the genuine passes, because a test that only pins failures
 * stays green if the thing regresses to "always fail".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../pluginClient.js', () => ({ callHostRpc: vi.fn() }));

import { IsolationSelfTest } from '../IsolationSelfTest.js';
import type { ServedPlugin } from '../pluginClient.js';

const plugin = { packName: 'p', packVersion: '1', pluginId: 'x', surface: 'artifact-viewer', hostApi: ['artifact.read'], entryPath: '/e' } as ServedPlugin;

/** Post a probe message as if it came from the hidden frame. The component
 *  authenticates by window REFERENCE (the frame is an opaque origin, so
 *  `event.origin` is "null" and cannot be trusted), so the test must supply the
 *  real contentWindow — which is also a check that the guard is by-reference. */
function postFromFrame(payload: Record<string, unknown>): void {
  const frame = document.querySelector('iframe') as HTMLIFrameElement | null;
  const ev = new MessageEvent('message', { data: { probe: 'openwop-isolation', ...payload } });
  Object.defineProperty(ev, 'source', { value: frame?.contentWindow });
  act(() => { window.dispatchEvent(ev); });
}

beforeEach(() => { vi.useRealTimers(); });
afterEach(cleanup);

describe('allowlist leg — runs the REAL handler', () => {
  it('PASSes when an undeclared method is refused before reaching the host', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // makePluginMessageHandler is used unmocked: a method absent from hostApi must
    // answer method_not_allowed AND never call `forward`.
    await waitFor(() => expect(screen.getAllByText(/PASS/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Allowlist-bound/i)).toBeTruthy();
  });
});

describe('isolated leg', () => {
  it('PASSes only for an opaque origin ("null")', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'isolated', origin: 'null' });
    await waitFor(() => expect(screen.getAllByText(/PASS/).length).toBeGreaterThanOrEqual(2));
  });

  it('FAILs when the frame reports a real origin — the boundary is gone', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'isolated', origin: 'https://app.openwop.dev' });
    await waitFor(() => expect(screen.getByText(/FAIL/)).toBeTruthy());
    // The observed value is shown verbatim so a reader can judge it.
    expect(screen.getByText('https://app.openwop.dev')).toBeTruthy();
  });
});

describe('egress leg', () => {
  it('FAILs when the probe fetch RESOLVES — egress was not blocked', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'egress', blocked: false, note: 'fetch resolved' });
    await waitFor(() => expect(screen.getByText(/FAIL/)).toBeTruthy());
  });

  it('PASSes when the fetch is blocked', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'egress', blocked: true, note: 'TypeError' });
    await waitFor(() => expect(screen.getAllByText(/PASS/).length).toBeGreaterThanOrEqual(2));
  });
});

describe('the honesty properties', () => {
  it('no-BYOK is ASSERTED, never PASS — it is not probed', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // "asserted" appears twice by design — the chip AND the explanatory note —
    // so match both deliberately rather than with a getBy that would throw.
    await waitFor(() => expect(screen.getAllByText(/asserted/i).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/No-BYOK is ASSERTED, not probed/i)).toBeTruthy();
    // And it must never be reported as a PASS.
    const chips = screen.getAllByText(/asserted/i).map((n) => n.textContent ?? '');
    expect(chips.some((c) => /PASS/.test(c))).toBe(false);
  });

  it('an unanswered probe goes INCONCLUSIVE, not PASS', async () => {
    vi.useFakeTimers();
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // Never post a frame message — the probe simply never answers.
    await act(async () => { vi.advanceTimersByTime(5000); });
    vi.useRealTimers();
    await waitFor(() => expect(screen.getAllByText(/no answer/i).length).toBe(2));
  });

  it('ignores a message that did not come from the probe frame', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // A forged message with no `source` — the by-reference guard must drop it.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { probe: 'openwop-isolation', leg: 'isolated', origin: 'null' },
      }));
    });
    // isolated must still be pending, not a pass.
    expect(screen.getAllByText(/checking…/i).length).toBeGreaterThan(0);
  });
});
