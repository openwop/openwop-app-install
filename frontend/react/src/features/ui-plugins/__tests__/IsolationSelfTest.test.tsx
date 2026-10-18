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
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';

vi.mock('../pluginClient.js', () => ({ callHostRpc: vi.fn(), isolationProbeUrl: () => '/api/host/openwop-app/ui-plugin/isolation-probe' }));

/** A handler that LIES: it forwards the undeclared method to the host AND answers
 *  method_not_allowed. Off by default — every other case runs the REAL handler. */
const forward = vi.hoisted(() => ({ lying: false }));
vi.mock('../PluginFrame.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../PluginFrame.js')>();
  const makePluginMessageHandler: typeof actual.makePluginMessageHandler = (pl, post, fwd, ...rest) => {
    if (!forward.lying) return actual.makePluginMessageHandler(pl, post, fwd, ...rest);
    return async (data) => {
      await fwd?.(data);
      post({ openwop: 'ui-plugin/1', id: 1, type: 'response', ok: false, error: { code: 'method_not_allowed' } });
    };
  };
  return { ...actual, makePluginMessageHandler };
});

import { IsolationSelfTest } from '../IsolationSelfTest.js';
import type { ServedPlugin } from '../pluginClient.js';

const plugin: ServedPlugin = { packName: 'p', packVersion: '1', pluginId: 'x', surface: 'artifact-viewer', hostApi: ['artifact.read'], entryPath: '/e', framePath: '/f', rpcPath: '/r' };

/** The result row for ONE leg — every verdict is read from its own row, never by
 *  counting PASS chips page-wide (two other legs' passes would satisfy a count). */
function legRow(label: RegExp): HTMLElement {
  const li = screen.getByText(label).closest('li');
  if (!li) throw new Error(`no result row for ${label}`);
  return li;
}
const ISOLATED = /^Isolated —/;
const EGRESS = /^Egress-denied —/;
const ALLOWLIST = /^Allowlist-bound —/;

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

beforeEach(() => { vi.useRealTimers(); forward.lying = false; });
afterEach(cleanup);

describe('allowlist leg — runs the REAL handler', () => {
  it('PASSes when an undeclared method is refused before reaching the host', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // makePluginMessageHandler is used unmocked: a method absent from hostApi must
    // answer method_not_allowed AND never call `forward`.
    await waitFor(() => expect(within(legRow(ALLOWLIST)).getByText('PASS')).toBeTruthy());
    expect(within(legRow(ALLOWLIST)).getByText('method_not_allowed')).toBeTruthy();
  });

  it('FAILs when the handler FORWARDS an undeclared method, even if it also answers refused', async () => {
    forward.lying = true;
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    // A refusal that still reached the host is not a refusal: `forwarded` decides.
    await waitFor(() => expect(within(legRow(ALLOWLIST)).getByText('FAIL')).toBeTruthy());
    expect(within(legRow(ALLOWLIST)).getByText('forwarded to the host — NOT refused')).toBeTruthy();
    expect(within(legRow(ALLOWLIST)).queryByText('PASS')).toBeNull();
  });
});

describe('isolated leg', () => {
  it('PASSes only for an opaque origin ("null")', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'isolated', origin: 'null' });
    await waitFor(() => expect(within(legRow(ISOLATED)).getByText('PASS')).toBeTruthy());
  });

  it('FAILs when the frame reports a real origin — the boundary is gone', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'isolated', origin: 'https://app.openwop.dev' });
    await waitFor(() => expect(within(legRow(ISOLATED)).getByText('FAIL')).toBeTruthy());
    // The observed value is shown verbatim so a reader can judge it.
    expect(within(legRow(ISOLATED)).getByText('https://app.openwop.dev')).toBeTruthy();
  });
});

describe('egress leg', () => {
  it('FAILs when the probe fetch RESOLVES — egress was not blocked', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'egress', blocked: false, note: 'fetch resolved' });
    await waitFor(() => expect(within(legRow(EGRESS)).getByText('FAIL')).toBeTruthy());
    expect(within(legRow(EGRESS)).getByText('fetch resolved')).toBeTruthy();
  });

  it('PASSes when the fetch is blocked', async () => {
    render(<IsolationSelfTest plugin={plugin} />);
    fireEvent.click(screen.getByRole('button'));
    postFromFrame({ leg: 'egress', blocked: true, note: 'TypeError' });
    await waitFor(() => expect(within(legRow(EGRESS)).getByText('PASS')).toBeTruthy());
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
    // The ISOLATED row must still be pending, not a pass (the egress row is pending
    // whatever happens, so a page-wide "checking…" proved nothing).
    expect(within(legRow(ISOLATED)).getByText(/checking…/)).toBeTruthy();
    expect(within(legRow(ISOLATED)).queryByText('PASS')).toBeNull();
    // Positive control: the SAME message from the real frame is accepted, so the
    // drop above was the source guard, not a dead listener.
    postFromFrame({ leg: 'isolated', origin: 'null' });
    await waitFor(() => expect(within(legRow(ISOLATED)).getByText('PASS')).toBeTruthy());
  });
});
