/**
 * ADR 0816 D7 — the push service worker opens only in-app paths.
 *
 * The service worker cannot import the SPA bundle, so it carries its own copy of
 * `isSafeActionUrl` (`sw/push-handlers.js`). This test runs the GENERATED worker
 * — the exact text the build emits as `/sw.js` (ADR 0873 D2) — against a fake
 * `self`: a click on a toast whose `actionUrl` is off-origin must open the inbox,
 * never the URL (it used to `openWindow(actionUrl)` unguarded), and the worker's
 * copy must agree with the SPA's rule on every probe.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateServiceWorker } from '../../../scripts/gen-service-worker.mjs';
import { isSafeActionUrl } from '../actionLabels.js';

const SOURCE = generateServiceWorker();

type Listener = (event: Record<string, unknown>) => void;

function bootWorker() {
  const listeners = new Map<string, Listener>();
  const openWindow = vi.fn(async (_url: string) => undefined);
  const showNotification = vi.fn(async () => undefined);
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow },
    registration: { showNotification },
    location: { origin: 'https://app.example' },
  };
  new Function('self', SOURCE)(self);
  return { listeners, openWindow, showNotification };
}

async function click(actionUrl: unknown): Promise<unknown> {
  const { listeners, openWindow } = bootWorker();
  let pending: Promise<unknown> = Promise.resolve();
  listeners.get('notificationclick')!({
    notification: { close: () => undefined, data: { actionUrl } },
    waitUntil: (p: Promise<unknown>) => { pending = p; },
  });
  await pending;
  return openWindow.mock.calls[0]?.[0];
}

// 2048 characters is the longest allowed path; 2049 is the first refused. DEL
// (0x7f) and NUL are control characters `\s` does not match, so only each
// copy's char-code loop rejects them.
const AT_LIMIT = `/${'a'.repeat(2047)}`;
const PAST_LIMIT = `/${'a'.repeat(2048)}`;
const PROBES = [
  '/runs/r-1', '/inbox?approval=a%201', '/', 'https://evil.example/x', '//evil.example',
  'javascript:alert(1)', '/\\evil', '/a b', '/a\u0000b', '/a\u007fb', '/a\tb', '', 'runs/r-1',
  `/${'a'.repeat(3000)}`, AT_LIMIT, PAST_LIMIT,
];

describe('ADR 0816 D7 — /sw.js navigation guard', () => {
  it('opens an in-app path as given', async () => {
    expect(await click('/runs/r-1')).toBe('/runs/r-1');
  });

  it('opens the inbox, never the URL, for an off-origin or malformed actionUrl', async () => {
    for (const bad of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', 42]) {
      expect(await click(bad), String(bad)).toBe('/inbox');
    }
  });

  it('opens a path at the 2048-char limit, and the inbox one past it or with DEL', async () => {
    // Literal outcomes, so a change made to BOTH copies still fails here.
    expect(await click(AT_LIMIT)).toBe(AT_LIMIT);
    expect(await click(PAST_LIMIT)).toBe('/inbox');
    expect(await click('/a\u007fb')).toBe('/inbox');
  });

  it('the worker copy agrees with the SPA rule on every probe', async () => {
    for (const probe of PROBES) {
      const opened = await click(probe);
      expect(opened === probe, JSON.stringify(probe)).toBe(isSafeActionUrl(probe));
    }
  });
});
