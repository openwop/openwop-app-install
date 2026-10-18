/**
 * Nav-telemetry beacon + paywall funnel (strategy §8). Pins:
 *  - never activated (telemetry OFF ⇒ `view()` is never called) ⇒ NOTHING is sent;
 *  - `view()` posts the ADR 0512 nav count, and skips it for an unmatched route;
 *  - the Sidebar's locked links are read from the DOM as `sidebar` impressions,
 *    and a click on one is a `sidebar` click (delegated, no Sidebar code);
 *  - impressions dedupe once per feature + surface per page view; a new
 *    pathname counts again; clicks are never deduped; one batched POST per tick.
 *
 * Privacy-adjacent: telemetry OFF ⇒ nothing leaves the browser. The non-lock
 * controls DO carry a `?feature=` (wave 50: a plain `/chat` link was dropped for
 * lacking one, so a selector that read every link stayed green).
 * Sabotage that turns it red: flushing before activation; posting nav for an
 * unmatched route; skipping the dedupe / page-view reset / surface in the key;
 * one POST per event; reading any `a` instead of the Sidebar's lock selector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notePaywall, view, __resetPaywallBeacon } from '../paywallBeacon.js';

type Ev = { metric: string; featureId: string; surface: string };
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response(null, { status: 202 }));
const calls = () => fetchMock.mock.calls.map(([url, init]) =>
  ({ url, body: JSON.parse(String(init?.body)) as { events?: Ev[]; route?: string; source?: string } }));
const sent = (): Ev[] => calls().filter((c) => c.url.endsWith('/analytics/paywall')).flatMap((c) => c.body.events ?? []);
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  __resetPaywallBeacon();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/crm');
  document.body.innerHTML = '';
});
afterEach(() => { vi.unstubAllGlobals(); __resetPaywallBeacon(); document.body.innerHTML = ''; });

describe('paywall beacon', () => {
  it('never activated (telemetry OFF): emits nothing, even with locks reported', async () => {
    notePaywall('impression', 'crm', 'locked-page');
    notePaywall('click', 'crm', 'palette');
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('view() posts the nav count, and none for an unmatched route', async () => {
    view('/crm/deals/:dealId', 'sidebar');
    view(undefined, 'deep-link');
    await tick();
    const nav = calls().filter((c) => c.url.endsWith('/analytics/nav'));
    expect(nav).toHaveLength(1);
    expect(nav[0]!.body).toEqual({ route: '/crm/deals/:dealId', source: 'sidebar' });
  });

  it('events held before activation are sent on the first view, batched', async () => {
    notePaywall('impression', 'crm', 'locked-page');
    notePaywall('impression', 'twin-recall', 'palette');
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    view('/crm', 'deep-link');
    await tick();
    expect(sent()).toEqual([
      { metric: 'impression', featureId: 'crm', surface: 'locked-page' },
      { metric: 'impression', featureId: 'twin-recall', surface: 'palette' },
    ]);
    expect(calls().filter((c) => c.url.endsWith('/analytics/paywall'))).toHaveLength(1);
  });

  it('reads the Sidebar locks from the DOM, and counts a click on one', async () => {
    document.body.innerHTML = `
      <a class="app-nav-link" href="/marketplace/bundles?feature=crm">CRM</a>
      <a class="app-mobile-nav__item" href="/marketplace/bundles?feature=crm">CRM</a>
      <a class="app-nav-link" href="/marketplace/bundles?feature=twin-recall">Twin</a>
      <a class="app-nav-link" href="/chat">Chat</a>
      <a class="app-other-link" href="/marketplace/bundles?feature=okrs">OKRs elsewhere</a>`;
    view('/crm', 'deep-link');
    await tick();
    expect(sent()).toEqual([
      { metric: 'impression', featureId: 'crm', surface: 'sidebar' }, // desktop + mobile dedupe to one
      { metric: 'impression', featureId: 'twin-recall', surface: 'sidebar' },
    ]);
    document.querySelector<HTMLAnchorElement>('a[href="/chat"]')!.addEventListener('click', (e) => e.preventDefault());
    document.querySelector('a[href="/chat"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const lock = document.querySelector<HTMLAnchorElement>('a[href$="twin-recall"]')!;
    lock.addEventListener('click', (e) => e.preventDefault());
    lock.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // A feature link OUTSIDE the Sidebar's lock selector is not a sidebar click.
    const other = document.querySelector<HTMLAnchorElement>('a.app-other-link')!;
    other.addEventListener('click', (e) => e.preventDefault());
    other.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    expect(sent().filter((e) => e.metric === 'click')).toEqual([{ metric: 'click', featureId: 'twin-recall', surface: 'sidebar' }]);
  });

  it('dedupes impressions per feature + surface per page view; clicks are not deduped', async () => {
    view(undefined, 'deep-link');
    expect(notePaywall('impression', 'crm', 'locked-page')).toBe(true);
    expect(notePaywall('impression', 'crm', 'locked-page')).toBe(false);
    expect(notePaywall('impression', 'crm', 'palette')).toBe(true);
    expect(notePaywall('click', 'crm', 'palette')).toBe(true);
    expect(notePaywall('click', 'crm', 'palette')).toBe(true);
    window.history.replaceState(null, '', '/dashboard'); // a new page view
    expect(notePaywall('impression', 'crm', 'locked-page')).toBe(true);
    expect(notePaywall('impression', undefined, 'locked-page')).toBe(false);
    await tick();
    expect(sent().filter((e) => e.metric === 'impression')).toHaveLength(3);
    expect(sent().filter((e) => e.metric === 'click')).toHaveLength(2);
  });
});
