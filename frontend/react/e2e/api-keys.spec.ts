import { test, expect, type APIRequestContext } from '@playwright/test';
import { API } from './support/session.js';

/**
 * ADR 0800 D2 — the API keys tab, end to end: a signed-in person creates a key
 * in the page, and THAT key — presented as a bearer with no cookie — starts a
 * run and reads it back.
 *
 * WHY A BROWSER TEST. The defect this tab closes was not in any one layer. The
 * key routes worked, the MCP key screen worked, and the scope gate worked; put
 * together they handed a CLI user a key that created a run and was then refused
 * reading it. Only "the key a person actually gets from the screen, used the way
 * a CLI uses it" exercises the join.
 *
 * The control case mints the MCP tab's "Read & act" scopes through the same
 * route and shows the read being refused — so the passing case is not passing
 * merely because this backend lets any key read.
 */

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

const RUN = { workflowId: 'openwop-app.uppercase', inputs: {} };

test.describe('API keys tab (ADR 0800)', () => {
  test.describe.configure({ timeout: 90_000 });

  test('a key created in the page starts a run and reads it back, with no cookie', async ({ page, playwright, baseURL }) => {
    await loginPersonal(page.request, `api-keys-${Date.now()}@e2e.test`);
    await page.goto('/access?tab=api-keys');

    await page.getByLabel('Name this key').fill('Laptop — CLI');
    await page.getByRole('button', { name: 'Create key' }).click();

    const issued = page.getByRole('region', { name: 'Your new key' });
    await expect(issued).toBeVisible();
    const token = (await issued.locator('pre').first().innerText()).trim();
    expect(token).toMatch(/^owk_/);
    // The CLI block names the two variables the CLI reads, with this key.
    await expect(issued).toContainText(/export OPENWOP_BASE_URL=https?:\/\/[^\s]+/);
    await expect(issued).toContainText(`export OPENWOP_API_KEY=${token}`);
    // It is listed, under the preset it was created with.
    await expect(page.locator('.mcp-key', { hasText: 'Laptop — CLI' })).toContainText('Run workflows');

    // A FRESH context: no session cookie, so the bearer is the only credential.
    const cli = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}), extraHTTPHeaders: { authorization: `Bearer ${token}`, 'OpenWOP-Version': '2' } });
    try {
      const create = await cli.post('/api/runs', { data: RUN });
      expect(create.status(), await create.text()).toBe(201);
      const { runId } = (await create.json()) as { runId: string };
      expect((await cli.get(`/api/runs/${encodeURIComponent(runId)}`)).status()).toBe(200);
      expect((await cli.get(`/api/runs/${encodeURIComponent(runId)}/events/poll`)).status()).toBe(200);
      // A run key is protocol-only: the app's own routes ask a key for a
      // workspace scope it did not declare (ADR 0795 D2).
      const vendor = await cli.get(`${API}/roster`);
      expect(vendor.status()).toBe(403);
      expect(((await vendor.json()) as { details?: { code?: string } }).details?.code).toBe('key_scope_required');
      // And the key cannot mint or list keys (ADR 0800 D1).
      expect((await cli.post(`${API}/developer-keys`, { data: { name: 'wider' } })).status()).toBe(403);
      expect((await cli.get(`${API}/developer-keys`)).status()).toBe(403);
    } finally {
      await cli.dispose();
    }

    // Done removes the key from the page: it is shown once.
    await issued.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(token)).toHaveCount(0);
  });

  test('the CLI preset reaches the workspace too, expires on the date chosen, and still cannot manage keys', async ({ page, playwright, baseURL }) => {
    await loginPersonal(page.request, `api-keys-cli-${Date.now()}@e2e.test`);
    await page.goto('/access?tab=api-keys');
    await page.getByLabel('Name this key').fill('Terminal');
    await page.getByRole('radio', { name: /CLI — act as me/ }).check();
    await page.getByLabel('Expires after').selectOption('30');
    await page.getByRole('button', { name: 'Create key' }).click();
    const issued = page.getByRole('region', { name: 'Your new key' });
    await expect(issued).toBeVisible();
    const token = (await issued.locator('pre').first().innerText()).trim();
    const row = page.locator('.mcp-key', { hasText: 'Terminal' });
    await expect(row).toContainText('CLI — act as me');
    await expect(row).toContainText(/expires /);

    const cli = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}), extraHTTPHeaders: { authorization: `Bearer ${token}`, 'OpenWOP-Version': '2' } });
    try {
      expect((await cli.get(`${API}/roster`)).status()).toBe(200);
      const create = await cli.post('/api/runs', { data: RUN });
      expect(create.status(), await create.text()).toBe(201);
      expect((await cli.get(`${API}/developer-keys`)).status()).toBe(403);
      // In the URL instead of the header, the same key is refused (ADR 0795 D5).
      const bare = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}) });
      try {
        expect((await bare.get(`/api/runs?apiKey=${encodeURIComponent(token)}`)).status()).toBe(401);
      } finally {
        await bare.dispose();
      }
    } finally {
      await cli.dispose();
    }
  });

  test('CONTROL — the MCP "Read & act" scopes start a run and are refused reading it', async ({ page, playwright, baseURL }) => {
    await loginPersonal(page.request, `api-keys-ctl-${Date.now()}@e2e.test`);
    const minted = await page.request.post(`${API}/developer-keys`, {
      data: { name: 'MCP: control', scopes: ['workspace:read', 'workspace:write', 'runs:create'] },
    });
    expect(minted.status(), await minted.text()).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const cli = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}), extraHTTPHeaders: { authorization: `Bearer ${token}`, 'OpenWOP-Version': '2' } });
    try {
      const create = await cli.post('/api/runs', { data: RUN });
      expect(create.status(), await create.text()).toBe(201);
      const { runId } = (await create.json()) as { runId: string };
      expect((await cli.get(`/api/runs/${encodeURIComponent(runId)}`)).status()).toBe(403);
    } finally {
      await cli.dispose();
    }

    // The tab lists that key too, marked as an AI-client key.
    await page.goto('/access?tab=api-keys');
    await expect(page.locator('.mcp-key', { hasText: 'MCP: control' })).toContainText('AI client');
  });
});
