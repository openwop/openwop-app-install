import { expect, type Page, type APIRequestContext } from '@playwright/test';
import { compileFilmPerformance, type FilmPerformance } from '../../../../contracts/filmPerformance.js';
import type { FilmSpec } from '../../../../contracts/films.js';
/** Real UI capture/save/reload and paused seek; the same fixture runs for both source owners. */
export async function exerciseFilmRehearsal(page: Page, request: APIRequestContext, endpoint: string, film: FilmSpec, checkDraftNavigation?: () => Promise<void>): Promise<void> {
  await page.getByRole('button', { name: 'Rehearse and replay', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start timing rehearsal' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start timing rehearsal' }).click();
  await expect(page.getByText('Capturing cue timings only.')).toBeVisible();
  await page.waitForTimeout(200); // An authored hold is part of the recorded performance.
  await checkDraftNavigation?.();
  await page.getByRole('button', { name: 'Next cue', exact: true }).click();
  const body = page.locator('.film-stage').first().locator('.film-element--body');
  await expect(body).toHaveCSS('opacity', '1');
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Stop and review timing' }).click();
  await page.getByRole('button', { name: 'Preview timing', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Replay paused' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeEnabled();
  await expect(body).toHaveCSS('opacity', '0');
  await page.getByLabel('Take name', { exact: true }).fill('Browser rehearsal');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/performances?revision='));
  await page.getByRole('button', { name: 'Save new take' }).click();
  const saved = await response; expect([200, 201]).toContain(saved.status());
  const take = await saved.json() as { id: string; performance: FilmPerformance };
  expect(JSON.stringify(take)).not.toContain('PRIVATE');
  await expect(page.getByText('Private timing take saved. Previous takes are unchanged.')).toBeVisible();
  await page.getByRole('button', { name: 'Play replay' }).click();
  await expect(body).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: 'Play replay' })).toBeVisible();
  const slider = page.getByRole('slider', { name: 'Seek timing replay' });
  const bounds = await slider.boundingBox(); expect(bounds).not.toBeNull();
  await slider.click({ position: { x: bounds!.width * .55, y: bounds!.height / 2 } });
  const atMs = Number(await slider.inputValue());
  const expected = compileFilmPerformance(film, take.performance)(atMs);
  await expect.poll(async () => Number(await body.evaluate(el => getComputedStyle(el).opacity))).toBeCloseTo(expected.step === 0 ? 0 : expected.progress, 2);
  await expect(page.getByRole('button', { name: 'Play replay' })).toBeVisible();
  await page.waitForTimeout(150); expect(Number(await slider.inputValue())).toBe(atMs);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rehearse and replay' })).toBeVisible();
  await page.getByRole('button', { name: 'Rehearse and replay' }).click();
  await page.getByRole('combobox', { name: 'Your saved timing takes', exact: true }).selectOption(take.id);
  await expect(page.getByRole('slider', { name: 'Seek timing replay' })).toHaveValue('0');
  await expect(page.locator('.film-stage').first().locator('.film-element--body')).toHaveCSS('opacity', '0');
  expect((await request.get(endpoint)).status()).toBe(200);
}
