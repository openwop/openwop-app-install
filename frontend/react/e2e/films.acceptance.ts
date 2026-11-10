import { test, expect } from '@playwright/test';
import { API, login } from './support/session.js';
import { serveFontsLocally } from './support/localFonts.js';
import { blankFilm } from '../../../contracts/films.js';

/** Real HTTP authority + real DOM, RAF and two-window BroadcastChannel.
 * Run against the disposable filmAcceptanceServer; no model/media provider. */
test('shared films: manual grouped cues, presenter privacy, paired audience and recovery', async ({ page, context }, testInfo) => {
  const tenant = `org:film-browser-${Date.now()}`;
  await login(context.request, `film-${Date.now()}@test.invalid`, tenant);
  const org = await context.request.post(`${API}/orgs`, { data: { name: 'Film acceptance' } }); expect(org.status()).toBe(201);
  const orgId = ((await org.json()) as { orgId: string }).orgId;
  const root = `${API}/films/orgs/${encodeURIComponent(orgId)}/canvases`;
  const created = await context.request.post(root, { data: { name: 'A live visual story' } }); expect(created.status()).toBe(201);
  const id = ((await created.json()) as { canvasId: string }).canvasId;
  const film = blankFilm('A live visual story'); film.scenes[0]!.notes = 'PRIVATE-PRESENTER-CANARY';
  const saved = await context.request.patch(`${root}/${id}`, { data: { expectedVersion: 1, state: film } }); expect(saved.status()).toBe(200);
  const paidRequests: string[] = [];
  context.on('request', r => { if (r.method() === 'POST' && /\/(runs|speech|synthesize|generate)(\/|\?|$)/.test(r.url())) paidRequests.push(new URL(r.url()).pathname); });
  await serveFontsLocally(page);
  await page.goto(`/films/${id}?org=${encodeURIComponent(orgId)}`);
  await expect(page.getByLabel('Scene title', { exact: true })).toHaveValue('A live visual story');
  const editSaved = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes(`/canvases/${id}`));
  await page.getByLabel('Duration (milliseconds)', { exact: true }).fill('600');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await editSaved).status()).toBe(200);
  await page.getByRole('button', { name: 'Present live', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A live visual story', exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE-PRESENTER-CANARY')).toBeVisible();
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open audience window' }).click();
  const audience = await popup;
  await expect(audience.locator('.film-stage')).toBeVisible();
  await expect(audience.locator('#root')).toHaveAttribute('inert', '');
  await expect(audience.getByText('PRIVATE-PRESENTER-CANARY')).toHaveCount(0);
  await expect(audience.getByRole('button', { name: 'Next cue' })).toHaveCount(0);
  const privateFetches: string[] = [];
  audience.on('request', r => { if (/\/canvases\/|\/decktalk\/orgs\//.test(r.url())) privateFetches.push(r.url()); });
  await expect(audience.locator('.film-element').filter({ hasText: 'One visual story. Your pace.' })).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Next cue' }).click();
  await expect(audience.locator('.film-element').filter({ hasText: 'One visual story. Your pace.' })).toHaveCSS('opacity', '1');
  await page.waitForTimeout(1100);
  await expect(page.getByText(/Cue 2 of 2/)).toBeVisible();
  // A focused toolbar button must not swallow the presenter's arrow keys.
  await page.keyboard.press('ArrowLeft'); await expect(page.getByText(/Cue 1 of 2/)).toBeVisible();
  await page.keyboard.press('ArrowRight'); await expect(page.getByText(/Cue 2 of 2/)).toBeVisible();
  await page.getByRole('button', { name: 'Blank audience' }).click();
  await expect(audience.locator('.film-element')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show film' }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.classList.remove('theme-light', 'theme-dark'); document.documentElement.classList.add(`theme-${value}`); }, theme);
    await page.screenshot({ path: testInfo.outputPath(`presenter-${theme}.png`), fullPage: true });
    await audience.evaluate(value => { document.documentElement.classList.remove('theme-light', 'theme-dark'); document.documentElement.classList.add(`theme-${value}`); }, theme);
    await audience.screenshot({ path: testInfo.outputPath(`audience-${theme}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('presenter-mobile.png'), fullPage: true });
  await page.close();
  await expect(audience.getByText(/Presenter disconnected/)).toBeVisible({ timeout: 7000 });
  expect(privateFetches).toEqual([]); expect(paidRequests).toEqual([]);
});
