/**
 * Toast announcement contract.
 *
 * The rule these pin is not a preference: a live region INSERTED already holding
 * its text has not "changed", so it is not announced. Every toast is inserted
 * that way, so every variant is spoken EXPLICITLY through the shell's primed
 * region, and the toast node carries NO live role:
 *
 *   error      -> the shell's ASSERTIVE region   (interrupts — a failure must not queue)
 *   the rest   -> the shell's POLITE region
 *
 * PROF-UX-20 — `error` used to keep an inline `role="alert"` on the premise that
 * the user agent SHOULD fire an alert event "when the WAI-ARIA alert is
 * created". `ui/Notice.tsx` disclaims exactly that premise as unverified, and
 * every failure toast in the app rested on it. Errors are now announced the
 * same way successes always were.
 *
 * Never both for one message — that is DS-8.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, within, fireEvent } from '@testing-library/react';
import { GlobalLiveRegion } from '../announce.js';
import { toast, dismiss } from '../toast.js';
// The view directly: `Toaster` lazy-loads it, and these assertions are synchronous.
import { ToasterView as Toaster } from '../ToasterView.js';

function mount(): void {
  render(<><GlobalLiveRegion /><Toaster /></>);
}
// The shell's two regions BY NAME (`data-owp-live`), not by attribute: a bare
// `[aria-live="assertive"]` would match any assertive node in the document.
const polite = (): string => document.querySelector('[data-owp-live="polite"]')?.textContent ?? '';
const assertive = (): string => document.querySelector('[data-owp-live="assertive"]')?.textContent ?? '';

/**
 * Scope to the toast landmark. Once a message is BOTH rendered and spoken it
 * exists twice in the document, so an unscoped query is ambiguous — and the
 * shell's own assertive region is itself a `role="alert"` node. Keeping the two
 * apart is the point: `region()` proves what is on screen, `polite()` /
 * `assertive()` prove what is heard. They are different claims and a test that
 * conflates them proves neither.
 */
const region = (): ReturnType<typeof within> =>
  within(screen.getByRole('region', { name: 'Notifications' }));

beforeEach(() => { /* fresh document per test */ });
afterEach(cleanup);

describe('toast — announcement', () => {
  it('SUCCESS is spoken through the shell region (role=status would be silent)', () => {
    mount();
    act(() => { toast.success('Saved your changes'); });
    expect(polite()).toContain('Saved your changes');
  });

  it('INFO and WARNING are spoken too', () => {
    mount();
    act(() => { toast.info('Sync started'); });
    expect(polite()).toContain('Sync started');
    act(() => { toast.warning('Running low on credits'); });
    expect(polite()).toContain('Running low on credits');
  });

  it('ERROR is spoken through the shell\'s ASSERTIVE region, not the polite one (PROF-UX-20)', () => {
    // Errors used to rest on an inline `role="alert"` announcing on insertion —
    // the premise `ui/Notice.tsx` disclaims. Now the ONE mechanism is explicit,
    // and assertive: a failed action must not queue behind polite chatter.
    mount();
    act(() => { toast.error('Payment failed'); });
    expect(assertive()).toContain('Payment failed');
    expect(polite()).not.toContain('Payment failed');
    // Rendered in the landmark too — visible AND heard, once each.
    expect(region().getByText('Payment failed')).toBeTruthy();
  });

  it('NO toast carries an inline live role — one mechanism per message (DS-8)', () => {
    // The DS-8 arm: an inline role on the node PLUS the shell region would be
    // two regions for one message. Error included — that is the PROF-UX-20 half.
    mount();
    act(() => { toast.success('Done'); });
    act(() => { toast.error('Broke'); });
    expect(region().getByText('Done').closest('.toast')?.getAttribute('role')).toBeNull();
    expect(region().getByText('Broke').closest('.toast')?.getAttribute('role')).toBeNull();
    expect(region().queryByRole('alert')).toBeNull();
  });

  it('a REPEATED identical error re-announces (the coalesced path still speaks)', () => {
    mount();
    act(() => { toast.error('Save failed'); });
    const first = assertive();
    act(() => { toast.error('Save failed'); });
    expect(assertive()).not.toBe(first);
    expect(assertive()).toContain('Save failed');
  });

  it('a REPEATED identical toast re-announces rather than being swallowed', () => {
    // push() coalesces the visible toast (UI-4), but the event happened again;
    // announce() flips an invisible marker so the string still reads as changed.
    mount();
    act(() => { toast.success('Copied'); });
    const first = polite();
    act(() => { toast.success('Copied'); });
    expect(polite()).not.toBe(first);
    expect(polite()).toContain('Copied');
  });
});

describe('toast — the region is reachable, not just audible', () => {
  it('the stack is a LABELLED LANDMARK so it can be navigated to on demand', () => {
    // Announcement is ephemeral: a user mid-sentence when a toast fires, or who
    // arrives late, otherwise has no route back to it. React Aria's pattern.
    mount();
    act(() => { toast.info('Export ready'); });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.textContent).toContain('Export ready');
  });

  it('the landmark is NOT a live region — a container region plus item roles is DS-8', () => {
    mount();
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.getAttribute('aria-live')).toBeNull();
  });
});

describe('toast — dismissal', () => {
  it('dismissing removes the toast from the landmark', () => {
    mount();
    let id = 0;
    act(() => { id = toast.info('Temporary'); });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).toContain('Temporary');
    act(() => { dismiss(id); });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).not.toContain('Temporary');
  });
});

describe('toast — timing is adjustable (WCAG 2.2.1)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const shown = (): string => screen.getByRole('region', { name: 'Notifications' }).textContent ?? '';

  it('an ERROR persists until dismissed — it may carry an instruction ("copy it manually")', () => {
    vi.useFakeTimers();
    mount();
    let id = 0;
    act(() => { id = toast.error('Copy it manually'); });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(shown()).toContain('Copy it manually');
    act(() => { dismiss(id); });
  });

  it('a timed toast pauses while hovered and resumes with the time it had LEFT', () => {
    vi.useFakeTimers();
    mount();
    act(() => { toast.success('Paused toast', 4000); });
    const stack = screen.getByRole('region', { name: 'Notifications' });
    act(() => { vi.advanceTimersByTime(2500); });
    fireEvent.mouseEnter(stack);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(shown()).toContain('Paused toast');
    fireEvent.mouseLeave(stack);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown()).toContain('Paused toast'); // ~1.5 s were left, not zero
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown()).not.toContain('Paused toast');
  });

  it('dismissing the last focused toast by keyboard does not leave the clock frozen', () => {
    vi.useFakeTimers();
    mount();
    act(() => { toast.error('Sticky'); });
    // Errors persist, so earlier tests' toasts may still be stacked: take this one's.
    const close = within(region().getByText('Sticky').closest('.toast') as HTMLElement).getByRole('button');
    act(() => { close.focus(); });
    act(() => { fireEvent.click(close); });
    act(() => { vi.advanceTimersByTime(0); });
    act(() => { toast.info('Later', 4000); });
    act(() => { vi.advanceTimersByTime(4100); });
    expect(shown()).not.toContain('Later');
  });
});

describe('toast — persistent errors cannot wall off the page', () => {
  it('shows the newest four, and one control dismisses every toast', () => {
    mount();
    act(() => { ['E1', 'E2', 'E3', 'E4', 'E5'].forEach((m) => toast.error(m)); });
    const r = region();
    expect(r.queryByText('E1')).toBeNull(); // oldest waits its turn
    expect(r.getByText('E5')).toBeTruthy();
    act(() => { fireEvent.click(r.getByRole('button', { name: /Dismiss all/ })); });
    expect(screen.getByRole('region', { name: 'Notifications' }).textContent).toBe('');
  });
});
