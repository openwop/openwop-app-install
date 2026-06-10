import { test, expect } from '@playwright/test';

/**
 * Keyboard-only flows (frontend enterprise-review Batch J accessibility).
 * The command palette is client-side (no backend) and is now lazy-mounted on
 * first activation (Batch F) — so this doubles as a regression guard that the
 * first ⌘K/Ctrl+K still opens it via the openSignal hand-off.
 */
test.describe('command palette — keyboard only', () => {
  test('Ctrl+K opens it and focus lands in the search box', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('main#main-content');

    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Search commands')).toBeFocused();
  });

  test('arrow keys move the selection within the listbox', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('main#main-content');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    const selected = () => page.locator('.cmdk-list [role="option"][aria-selected="true"]');
    await expect(selected()).toHaveCount(1);
    const first = await selected().getAttribute('data-idx');
    await page.keyboard.press('ArrowDown');
    const second = await selected().getAttribute('data-idx');
    expect(second).not.toBe(first);
  });

  test('Escape closes the palette', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('main#main-content');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  });
});
