/**
 * ADR 0816 D7 — the push service worker opens only in-app paths.
 *
 * `public/sw-push.js` cannot import the SPA bundle, so it carries its own copy of
 * `isSafeActionUrl`. This test runs the REAL worker source against a fake
 * `self`: a click on a toast whose `actionUrl` is off-origin must open the inbox,
 * never the URL (it used to `openWindow(actionUrl)` unguarded), and the worker's
 * copy must agree with the SPA's rule on every probe.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isSafeActionUrl } from '../actionLabels.js';

const SOURCE = readFileSync(join(__dirname, '..', '..', '..', 'public', 'sw-push.js'), 'utf8');

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

const PROBES = [
  '/runs/r-1', '/inbox?approval=a%201', '/', 'https://evil.example/x', '//evil.example',
  'javascript:alert(1)', '/\\evil', '/a b', '/a\u0000b', '', 'runs/r-1', `/${'a'.repeat(3000)}`,
];

describe('ADR 0816 D7 — sw-push.js navigation guard', () => {
  it('opens an in-app path as given', async () => {
    expect(await click('/runs/r-1')).toBe('/runs/r-1');
  });

  it('opens the inbox, never the URL, for an off-origin or malformed actionUrl', async () => {
    for (const bad of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', 42]) {
      expect(await click(bad), String(bad)).toBe('/inbox');
    }
  });

  it('the worker copy agrees with the SPA rule on every probe', async () => {
    for (const probe of PROBES) {
      const opened = await click(probe);
      expect(opened === probe, JSON.stringify(probe)).toBe(isSafeActionUrl(probe));
    }
  });
});
