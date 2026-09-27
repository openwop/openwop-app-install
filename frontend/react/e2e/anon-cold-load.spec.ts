import { test, expect } from '@playwright/test';

/**
 * A cold, anonymous first visit still lands in a working session (ADR 0745 / ADR 0750).
 *
 * RFC 0200 §B.1 makes a credential-less PROTOCOL call a 401. The rule that decides which
 * calls count is ADR 0750's; this spec pins the product invariant any such rule must
 * keep, from a real Chromium rather than from header shapes a backend test typed by
 * hand: the anonymous visitor boots, is minted a session, and the protocol surface then
 * serves them. It deliberately does NOT assert "no 401 during load": ADR 0750's SPA
 * answers a first-call challenge by bootstrapping and retrying once, which is correct.
 *
 * The context starts with NO cookies (the config's storageState carries none).
 */
test('cold anonymous load: the app boots, a session is minted, and the protocol surface serves it', async ({ page, context }) => {
  await page.goto('/dashboard');
  await expect(page.locator('main#main-content')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);

  // Polled: the shell renders before its first backend call returns, so the cookie
  // lands AFTER `main` is visible (the CI e2e boot, via the `/api` proxy, read it at
  // 1.0 s and found none).
  await expect
    .poll(async () => (await context.cookies()).some((c) => c.name === '__session'), {
      message: 'the first visit mints the anonymous session cookie',
      timeout: 15_000,
    })
    .toBe(true);

  // A v2 protocol read from the page with the page's own credentials, as the app's runs
  // client makes it. The base mirrors `client/config.ts`'s dev fallback (e2e README
  // trap 2: in dev the app calls the backend directly, not through `/api`).
  const base = process.env.VITE_OPENWOP_BASE_URL ?? 'http://localhost:8080';
  const status = await page.evaluate(
    async (b) => (await fetch(`${b}/runs`, { credentials: 'include', headers: { 'OpenWOP-Version': '2.0', accept: 'application/json' } })).status,
    base,
  );
  expect(status, 'the anonymous visitor is served on the protocol surface, not challenged').toBe(200);
});
