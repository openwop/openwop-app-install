/**
 * Shared-chunk headroom (2026-10-26) — the `settings` and `workforces` catalogs are LAZY
 * (resources.ts), so their pages must wait inside the route <Suspense> until the
 * namespace loads. Rendering before that paints raw keys ("auditTitle") to a real user.
 *
 * The suite preloads every lazy namespace (src/test/i18n-setup.ts), so no page test can
 * see this. Here the namespace bundle is genuinely removed and the real backend read held open, and
 * the page is rendered exactly as the router gets it: the `chrome/features.tsx` route
 * element (the lazy-imported page) under a <Suspense> inside <Routes>, the shape App.tsx
 * gives every routed page (its `RouteLoading` fallback is private; a marker stands in).
 * While held: only the fallback shows and no catalog key paints. Released: real copy.
 * Modelled on notifications/__tests__/assistantActionLoading.test.tsx, but the hold is
 * on the i18next backend read rather than a mocked hook, so react-i18next's own
 * suspension is what is tested.
 *
 * Sabotage-witnessed (each reds the named case, repeatably):
 *   - `useTranslation('settings', { useSuspense: false })` in AuditLogPage, and the same
 *     for `workforces` in WorkforcesGalleryPage → raw keys painted during the hold;
 *   - binding WorkforcesGalleryPage to the wrong namespace (`useTranslation('settings')`)
 *     → the page never requests `workforces`;
 *   - removing the <Suspense> boundary below → no fallback during the hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../index.js';
import { FEATURES } from '../../chrome/features.js';

// The gallery's reads and its demo-mode fork are not under test; keep them off the network.
vi.mock('../../client/workforcesClient.js', async (orig) => ({
  ...(await orig<typeof import('../../client/workforcesClient.js')>()),
  listWorkforces: vi.fn(async () => []),
}));
vi.mock('../../client/useDemoMode.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useDemoMode.js')>()),
  useDemoMode: () => false,
}));

type ReadCb = (err: unknown, data?: Record<string, unknown> | false) => void;
type Backend = { read: (lng: string, ns: string, cb: ReadCb) => void };
type Connector = { backend: Backend; state: Record<string, unknown> };

let bundle: Record<string, unknown> = {};
let release = (): void => {};
let requested = false;
let restoreRead = (): void => {};

/** Put `ns` back into the state a first visit sees: no bundle in the store, never
 *  loaded, and its backend read held open until `release()`. The real ADR 0490 backend
 *  then delivers it, so the page's own `useTranslation` does the suspending. */
function hold(ns: string): void {
  const connector = (i18n.services as unknown as { backendConnector: Connector }).backendConnector;
  bundle = { ...(i18n.getResourceBundle('en', ns) as Record<string, unknown>) };
  i18n.removeResourceBundle('en', ns);
  delete connector.state[`en|${ns}`];
  requested = false;
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const read = connector.backend.read;
  connector.backend.read = (lng, n, cb) => {
    if (n === ns) { requested = true; void gate.then(() => read(lng, n, cb)); }
    else read(lng, n, cb);
  };
  restoreRead = () => { connector.backend.read = read; };
  release = () => { open(); };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  release();
  restoreRead();
  cleanup();
  vi.unstubAllGlobals();
});

const CASES = [
  { ns: 'settings', path: '/audit-log', titleKey: 'auditTitle', title: 'Audit log' },
  { ns: 'workforces', path: '/workforces', titleKey: 'galleryTitle', title: 'Your AI workforces' },
] as const;

describe('a lazy-area page waits in its route Suspense for its namespace', () => {
  for (const { ns, path, titleKey, title } of CASES) {
    it(`${path} shows the fallback and no raw \`${ns}\` key until it loads, then real copy`, async () => {
      const route = FEATURES.find((r) => r.path === path);
      expect(route, `route ${path} not found`).toBeTruthy();
      hold(ns);
      const keys = Object.keys(bundle);
      expect(keys.length, `the ${ns} bundle was preloaded by setup`).toBeGreaterThan(20);

      const { container } = render(
        <MemoryRouter initialEntries={[path]}>
          <Suspense fallback={<p>Loading page</p>}>
            <Routes>
              <Route path={path} element={route!.element} />
            </Routes>
          </Suspense>
        </MemoryRouter>,
      );
      // Wait until the page itself has asked for its namespace: only then is the lazy
      // page module loaded and rendering, so a fallback below is the namespace's doing,
      // not the module's (a fixed sleep let a cold module import stand in for it).
      await waitFor(() => expect(requested, `the page never requested \`${ns}\``).toBe(true));
      await act(async () => { await Promise.resolve(); });
      const held = container.textContent ?? '';
      expect(keys.filter((k) => held.includes(k)), `raw ${ns} keys painted during the hold`).toEqual([]);
      expect(held, 'only the route fallback renders during the hold').toBe('Loading page');

      await act(async () => { release(); });

      // The released read lands asynchronously; the copy must arrive through t(), then paint.
      await waitFor(() => expect(i18n.t(`${ns}:${titleKey}`)).toBe(title));
      expect(await screen.findByRole('heading', { name: i18n.t(`${ns}:${titleKey}`) })).toBeTruthy();
      expect(screen.queryByText('Loading page')).toBeNull();
    });
  }
});
