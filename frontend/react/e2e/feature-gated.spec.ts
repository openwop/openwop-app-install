/**
 * Step-driven gated-feature e2e (ADR 0183) — goes beyond render: enables a toggle-OFF
 * feature via the seam, then drives a real interaction mirroring its manual-test case.
 * Showcases the auth+toggle harness on representative gated surfaces (UCP admin, Billing).
 *
 * Env-gated (OPENWOP_E2E_ROUTES=1) + backend on :8080 with the test seams (see
 * e2e/support/session.ts). Skips cleanly otherwise.
 */
import { test, expect } from '@playwright/test';
import { API, login, enableToggle } from './support/session.js';

const ENABLED = process.env.OPENWOP_E2E_ROUTES === '1';
const TENANT = 'e2e-gated';

test.describe('gated features — step-driven (ADR 0183)', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_ROUTES=1 + a local backend with the test seams (see e2e/support/session.ts).');
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('UCP admin: enable commerce-ucp, provision a client (UCP-01)', async ({ browser }) => {
    const ctx = await browser.newContext();
    await login(ctx.request, 'ucp-admin@e2e.test', TENANT);
    await enableToggle(ctx.request, 'commerce'); // UCP projects commerce
    await enableToggle(ctx.request, 'commerce-ucp');
    // A merchant org for the panel's org picker.
    await ctx.request.post(`${API}/orgs`, { data: { name: 'E2E Merchant' } });

    const page = await ctx.newPage();
    await page.goto('/commerce-ucp');
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    // The client-provisioning affordance from the manual UCP-01 case. Two "New client"
    // buttons can render (the ClientsCard header + the empty-state StateCard CTA), so
    // target the first.
    const newClient = page.getByRole('button', { name: /new client/i }).first();
    await expect(newClient).toBeVisible();
    await newClient.click();
    // The provision form (name field) appears.
    await expect(page.getByText(/name/i).first()).toBeVisible();
    await ctx.close();
  });

  test('Billing: enable billing, plan + manage render (BILL-01)', async ({ browser }) => {
    const ctx = await browser.newContext();
    await login(ctx.request, 'billing-admin@e2e.test', TENANT);
    await enableToggle(ctx.request, 'billing');

    const page = await ctx.newPage();
    await page.goto('/billing');
    await expect(page.locator('main').first()).toBeVisible();
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    // Demo-mode: the manage-billing control exists (clicking it toasts demo-mode).
    await expect(page.getByRole('button', { name: /manage/i })).toBeVisible();
    await ctx.close();
  });
});
