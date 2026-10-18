import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { OFFLINE_E2E_PORT } from '../playwright.offline.config';
import { startFixtureServer, type FixtureServer } from './offlineFixtureServer';

/**
 * ADR 0873 Verification 2 (offline) and 3 (deploy-across), against fixture builds in
 * which `kicktodo` declares `/guide` and `/discover` (scripts/build-offline-fixture.mjs).
 * Builds A and B differ in the entry chunk, so B prunes most of A's hashed files.
 *
 * Not here: the D12 legs (a `last-known` route inside and after its TTL, another
 * tenant, after sign-out). They need a declaration with `entitlement: 'last-known'`
 * and join this file with D12.
 */
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.cache', 'offline-e2e');
const A = join(FIXTURES, 'A');
const B = join(FIXTURES, 'B');

const DECLARED = '/guide';
const DECLARED_LAZY = '/discover';
const UNDECLARED = '/showcase';

let server: FixtureServer;
test.beforeEach(async () => {
  server = await startFixtureServer(OFFLINE_E2E_PORT, A);
});
test.afterEach(async () => {
  await server.close();
});

/** The page is controlled by an activated worker, so its precache is complete. */
async function waitForControllingWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((ok) => navigator.serviceWorker.addEventListener('controllerchange', () => ok(), { once: true }));
  });
}

/** A client-side navigation, as a nav-rail click makes it, so the route's chunk is
 *  imported lazily by the running tab rather than by a document load. */
async function navigateInApp(page: Page, to: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, to);
}

/** Each route's own first heading (English, the default locale), so "rendered" means
 *  the route's screen and not an empty layout or an error state inside `<main>`. */
const HEADING: Record<string, string> = { [DECLARED]: 'Your guide', [DECLARED_LAZY]: 'Discover' };

async function expectRendered(page: Page, path: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  const heading = HEADING[path];
  if (!heading) throw new Error(`no expected heading for ${path}`);
  await expect(page.locator('main h1, main h2').first()).toHaveText(heading);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

function entryOf(html: string): string {
  const m = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!m) throw new Error('no entry chunk in the shell');
  return m[0];
}

test('V2: a declared route launches offline from the cached shell, and a screen never opened online loads from the precache', async ({ page }) => {
  const pageAssets = new Set<string>();
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/assets/')) pageAssets.add(p);
  });

  await page.goto(DECLARED);
  await expectRendered(page, DECLARED);
  await waitForControllingWorker(page);
  const openedOnline = new Set(pageAssets);

  await server.goOffline();

  // A fresh document load of the declared route: the network fails, the shell comes
  // from the cache (D5).
  const shell = await page.goto(DECLARED);
  expect(shell?.fromServiceWorker(), 'the document came from the worker').toBe(true);
  await expectRendered(page, DECLARED);

  // A screen the tab has never loaded: its lazy chunks were precached at install
  // (D6), not fetched by the page, so only the worker can supply them now.
  const offlineAssets: { path: string; fromWorker: boolean; ok: boolean }[] = [];
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/assets/')) offlineAssets.push({ path: p, fromWorker: r.fromServiceWorker(), ok: r.ok() });
  });
  await navigateInApp(page, DECLARED_LAZY);
  await expectRendered(page, DECLARED_LAZY);

  const neverOpenedOnline = offlineAssets.filter((a) => !openedOnline.has(a.path));
  expect(neverOpenedOnline.length, 'the lazy screen needed chunks the page never loaded online').toBeGreaterThan(0);
  for (const a of offlineAssets) {
    expect(a.ok, `${a.path} answered`).toBe(true);
    expect(a.fromWorker, `${a.path} came from the worker`).toBe(true);
  }
});

test('V2: offline, an undeclared route, "/" and every Cloud Run path fail as the network does', async ({ page }) => {
  await page.goto(DECLARED);
  await expectRendered(page, DECLARED);
  await waitForControllingWorker(page);

  // Visit each of them online first, so a cache that kept them would have them.
  for (const path of [UNDECLARED, '/', '/runs']) await page.goto(path);
  await page.goto(DECLARED);
  await waitForControllingWorker(page);
  const online = await page.evaluate(async () => (await fetch('/api/readiness')).headers.get('x-cloud-run'));
  expect(online, 'the API answered online').toMatch(/^\d+$/);

  await server.goOffline();

  for (const path of [UNDECLARED, '/', '/runs']) {
    await expect(page.goto(path), `${path} is not served offline`).rejects.toThrow(/net::ERR_/);
  }

  // D4: a never-cache request is never answered from a cache, including one the page
  // made successfully a moment ago.
  await page.goto(DECLARED);
  const api = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/readiness');
      return { answered: true, body: await r.text() };
    } catch {
      return { answered: false, body: '' };
    }
  });
  expect(api, 'the API fails offline').toEqual({ answered: false, body: '' });
});

test('V3: a tab open across a deploy lazy-loads its own version from the previous cache; a fresh load gets the new shell', async ({ page, context }) => {
  const bAssets = new Set(readdirSync(join(B, 'assets')).map((f) => `/assets/${f}`));
  const bEntry = entryOf(readFileSync(join(B, 'app-shell.html'), 'utf8'));

  const documentLoads: string[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documentLoads.push(new URL(r.url()).pathname);
  });

  await page.goto(DECLARED);
  await expectRendered(page, DECLARED);
  await waitForControllingWorker(page);

  // The deploy: B is served from now on, and A's chunks are gone (a missing file gets
  // the `**` rewrite, i.e. the shell as text/html). The worker updates to B's, which
  // takes over this tab (D7) and keeps A's cache as the previous version (D6).
  server.deploy(B);
  // Wait for `activated`, not just `controllerchange`: the push handlers' `activate`
  // claims the tab while the engine's `activate` may still be pruning versions, so the
  // tab can switch to B before retention has run. `activated` follows every waitUntil.
  await page.evaluate(async () => {
    const changed = new Promise<void>((ok) => navigator.serviceWorker.addEventListener('controllerchange', () => ok(), { once: true }));
    const reg = await navigator.serviceWorker.getRegistration();
    await reg?.update();
    await changed;
    const active = reg?.active;
    if (active && active.state !== 'activated') {
      await new Promise<void>((ok) => active.addEventListener('statechange', () => { if (active.state === 'activated') ok(); }));
    }
  });
  const shellCaches = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('openwop-offline-shell-')));
  expect(shellCaches, 'current and previous version are both kept').toHaveLength(2);

  const lazy: { path: string; fromWorker: boolean; ok: boolean; type: string }[] = [];
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/assets/')) lazy.push({ path: p, fromWorker: r.fromServiceWorker(), ok: r.ok(), type: r.headers()['content-type'] ?? '' });
  });
  await navigateInApp(page, DECLARED_LAZY);
  await expectRendered(page, DECLARED_LAZY);

  const prunedByDeploy = lazy.filter((a) => !bAssets.has(a.path));
  expect(prunedByDeploy.length, 'the tab needed chunks the deploy removed (otherwise this proves nothing)').toBeGreaterThan(0);
  for (const a of prunedByDeploy) {
    expect(a.fromWorker, `${a.path} came from the previous version's cache`).toBe(true);
    expect(a.type, `${a.path} is a script, not the shell`).toMatch(/javascript/);
  }
  expect(documentLoads, 'no stale-chunk reload was needed').toEqual([DECLARED]);

  // A fresh online navigation gets B's shell, not A's from a cache (D5 network-first).
  const fresh = await context.newPage();
  const doc = await fresh.goto(DECLARED);
  expect(entryOf(await doc!.text()), 'the new shell').toBe(bEntry);
  await expectRendered(fresh, DECLARED);
});
