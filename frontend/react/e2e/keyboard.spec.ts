import { test, expect } from '@playwright/test';

/**
 * Keyboard-only flows (frontend enterprise-review Batch J accessibility).
 * The command palette is client-side (no backend) and is now lazy-mounted on
 * first activation (Batch F) — so this doubles as a regression guard that the
 * first ⌘K/Ctrl+K still opens it via the openSignal hand-off.
 *
 * Sabotage-witnessed (wave 53): the openSignal hand-off dropped (all three red);
 * the input-focus effect removed (cases 1-2 red); ArrowDown a no-op (case 2 red);
 * the window Escape listener not closing (case 3 red). ArrowDown jumping to the
 * last row passed the old "selection changed" check — the 0→1→2→1 walk below is
 * re-probed for it (w53g3-kbd-arrow-to-last-r2, -arrow-up-noop-r2).
 * Case 3's twin is `ui/__tests__/CommandPalette.escape.test.tsx` (jsdom, both
 * focus positions) — kept here because only this path presses the real key
 * through the lazy-mount hand-off.
 */
test.describe('command palette — keyboard only', () => {
  test('Ctrl+K opens it and focus lands in the search box', async ({ page }) => {
    await page.goto('/dashboard'); // ADR 0487 — '/' is the public home; the command palette is app chrome
    await page.waitForSelector('main#main-content');

    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel('Search commands')).toBeFocused();
  });

  test('arrow keys move the selection within the listbox', async ({ page }) => {
    await page.goto('/dashboard'); // ADR 0487 — '/' is the public home; the command palette is app chrome
    await page.waitForSelector('main#main-content');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    // At least THREE options, so a direction is observable: with two, "down"
    // and "up" (or "jump to the last") land on the same row (wave 49 lesson).
    const options = page.locator('.cmdk-list [role="option"]');
    await expect(options.nth(2)).toBeAttached();
    const selected = page.locator('.cmdk-list [role="option"][aria-selected="true"]');
    const input = page.getByLabel('Search commands');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute('data-idx', '0');

    // Down moves ONE row, down again moves one more, up comes back one. Each step
    // is a web-first assertion (no one-shot attribute read racing the render),
    // and the combobox's aria-activedescendant — what a screen reader follows —
    // moves with it.
    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveAttribute('data-idx', '1');
    await expect(input).toHaveAttribute('aria-activedescendant', 'cmdk-opt-1');
    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveAttribute('data-idx', '2');
    await page.keyboard.press('ArrowUp');
    await expect(selected).toHaveAttribute('data-idx', '1');
    await expect(input).toHaveAttribute('aria-activedescendant', 'cmdk-opt-1');
  });

  test('Escape closes the palette', async ({ page }) => {
    await page.goto('/dashboard'); // ADR 0487 — '/' is the public home; the command palette is app chrome
    await page.waitForSelector('main#main-content');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  });
});
