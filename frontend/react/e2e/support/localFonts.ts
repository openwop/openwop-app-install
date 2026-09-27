/**
 * Local webfont serving for the e2e gate (root cause of the recurring
 * "webfont NetworkError" flake, diagnosed 2026-08-14 after six occurrences):
 * the app loads its fonts from the Google Fonts CDN (`index.html` preconnects,
 * `brand/defaults.ts` fontsHref), which made the design-system visual-contract
 * tests depend on an EXTERNAL network fetch inside the local merge gate. Any
 * CDN/DNS degradation — which persists across in-run retries, so retry guards
 * kept dying — failed tests whose contract is OUR CSS.
 *
 * This helper removes the dependency: it intercepts both Google Fonts hosts
 * and fulfills them from vendored copies (`e2e/assets/fonts/` — the css2
 * response captured with a Chromium UA, so the woff2 face set matches what
 * Playwright's browser would negotiate, plus its 15 latin/latin-ext woff2
 * files, ~230 KB, OFL-licensed). A woff2 the vendored set does not contain
 * fulfills as 404 — loud in the font-load assertions, never a silent
 * fall-through back to the network.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

export async function serveFontsLocally(page: Page): Promise<void> {
  const css = await fs.readFile(path.join(ASSETS, 'fonts.css'), 'utf8');
  await page.route('https://fonts.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css }));
  await page.route('https://fonts.gstatic.com/**', async (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    try {
      const body = await fs.readFile(path.join(ASSETS, name));
      await route.fulfill({ status: 200, contentType: 'font/woff2', body });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
}
