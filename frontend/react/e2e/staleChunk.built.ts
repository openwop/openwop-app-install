import { test, expect } from '@playwright/test';

/**
 * ADR 0874 W-STALE — a tab left open across a deploy still recovers from a stale chunk.
 *
 * Runs against the PRODUCTION build (playwright.built.config.ts), because the dev
 * server has no hashed chunks and no preload helper.
 *
 * The deploy is simulated the way Firebase Hosting behaves: once the release changes,
 * an old chunk URL is answered by the SPA rewrite with `index.html` (`text/html`), so
 * the browser refuses it as a module. `main.tsx` listens for `vite:preloadError` and
 * reloads once; the reload fetches the current shell and the route renders.
 *
 * Why it exists (ADR 0874 W-STALE): the ADR proposed `build.modulePreload: false` and
 * required proof that the one-shot reload still fires without JS preload lists. It
 * does (this test passed on that build too), but the latency witness rejected the
 * change, so the test stays as a standing guard on the reload for today's build.
 *
 * Sabotage witness (recorded in the ADR): with the `main.tsx` listener renamed and
 * the build re-run, this test goes red — the tab never reloads (1 load, not 2).
 */

/** Two public site-tier pages in different features, so the second is a lazy chunk the
 *  tab has not loaded yet. Both render without a backend (this lane has none). */
const START = '/showcase';
const TARGET = '/guide';

test('W-STALE: a stale lazy chunk reloads the tab exactly once, then the route renders', async ({ page }) => {
  const documentLoads: string[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documentLoads.push(new URL(r.url()).pathname);
  });

  await page.goto(START);
  await expect(page.locator('main').first()).toBeVisible();

  // The deploy lands: the NEXT chunk the tab asks for is gone, and the hosting
  // rewrite answers with the shell. Only one request is made stale, because after
  // the reload the tab holds the new release's chunk names, which all exist.
  let staleServed = 0;
  await page.route(/\/assets\/c-[A-Za-z0-9_-]+\.js$/, async (route) => {
    if (staleServed > 0) return route.continue();
    staleServed += 1;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>shell</body></html>' });
  });

  // A client-side navigation, as a nav-rail click makes it (React Router listens
  // for popstate), so the route's chunk is imported lazily rather than by a reload.
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, TARGET);

  await expect.poll(() => documentLoads.length, { message: 'the tab reloads after the stale chunk', timeout: 15_000 }).toBe(2);
  expect(staleServed, 'the simulated deploy actually served a stale chunk').toBe(1);
  expect(documentLoads[1], 'the reload is of the route the user navigated to').toBe(TARGET);

  await expect(page.locator('main').first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${TARGET}$`));

  // Exactly once: no second reload after the route settles.
  await page.waitForTimeout(2_000);
  expect(documentLoads, 'exactly one reload').toHaveLength(2);
});
