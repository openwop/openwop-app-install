import { test, expect } from '@playwright/test';

/**
 * Interaction tests for the shared ui/Modal primitive (GAP-ANALYSIS E7),
 * exercised through CreateBoardModal. Verifies the focus-trap + restore
 * (useFocusTrap), Escape-to-close, and backdrop-click-to-close that the
 * primitive owns, in a real browser.
 *
 * /boards is ADMIN-gated: an anonymous session renders the "Administrator
 * access required" state with no "+ New board" control, so each test signs in
 * via the test/login seam into the user's PERSONAL tenant (no explicit
 * tenantId) — the personal workspace has a deterministic owner-member, so the
 * session is workspace-admin. A shared `org:*` tenant would mint a plain
 * member and still hit the gate. Requires the backend on :8080 with the test
 * seams — see e2e/support/session.ts.
 */
test.describe('ui/Modal (via Create-board)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const ctx = page.context();
    const res = await ctx.request.post('/api/v1/host/openwop-app/test/login', {
      data: { email: `modal-${testInfo.workerIndex}@e2e.test` },
    });
    expect(res.status(), `login: ${await res.text()}`).toBe(201);
  });
  test('opens a labelled dialog and moves focus inside (focus-trap)', async ({ page }) => {
    await page.goto('/boards');
    await page.waitForSelector('main#main-content');
    await page.getByRole('button', { name: '+ New board' }).first().click();

    const dialog = page.getByRole('dialog', { name: 'Create a board' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // useFocusTrap moved focus into the dialog (the name input autofocuses).
    const focusInside = await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
    );
    expect(focusInside).toBe(true);
  });

  test('traps Tab within the dialog', async ({ page }) => {
    await page.goto('/boards');
    await page.waitForSelector('main#main-content');
    await page.getByRole('button', { name: '+ New board' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Create a board' })).toBeVisible();

    // Tab through more controls than the dialog has — focus must never escape it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(
        () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
      );
      expect(inside, `focus left the dialog after ${i + 1} Tab(s)`).toBe(true);
    }
  });

  test('Escape closes and restores focus to the opener', async ({ page }) => {
    await page.goto('/boards');
    await page.waitForSelector('main#main-content');
    const opener = page.getByRole('button', { name: '+ New board' }).first();
    await opener.click();
    await expect(page.getByRole('dialog', { name: 'Create a board' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Create a board' })).toHaveCount(0);
    await expect(opener).toBeFocused(); // useFocusTrap restored focus to the trigger
  });

  test('backdrop click closes; dialog-body click does not', async ({ page }) => {
    await page.goto('/boards');
    await page.waitForSelector('main#main-content');
    await page.getByRole('button', { name: '+ New board' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create a board' });
    await expect(dialog).toBeVisible();

    // Clicking inside the dialog body must NOT close it.
    await dialog.getByText('Create a board').first().click();
    await expect(dialog).toBeVisible();

    // Clicking the scrim (outside the dialog) closes it.
    await page.locator('.hire-scrim').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
  });
});
