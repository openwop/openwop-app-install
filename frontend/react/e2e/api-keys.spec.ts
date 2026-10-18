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
 *
 * Every refusal is asserted by its OWN reason, not a bare status: a 403 from a
 * different guard (the ADR 0795 D2 `key_scope_required` vendor gate, say) would
 * otherwise satisfy an ADR 0800 D1 `key_cannot_manage_keys` assertion. The chosen
 * lifetime is read back from the stored key, not from "expires <some date>".
 *
 * Breaks it (w53 probes, witnessed): the Run preset losing `runs:read`; the CLI
 * preset losing `workspace:read`; the page not clearing the issued key on Done; the
 * MCP-key label rule; a wrong lifetime sent for the chosen one.
 */

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

const RUN = { workflowId: 'openwop-app.uppercase', inputs: {} };
const DAY_MS = 86_400_000;

/** The parts of `GET …/developer-keys` this spec reads (the page's own list route). */
interface KeyList { keys: Array<{ name: string; createdAt: string; expiresAt?: string }> }
/** The host error envelope's `details.code`. */
interface CodedError { details?: { code?: string } }

/** ADR 0800 D1 — the refusal is THIS gate's, not some other 403. */
async function expectKeyCannotManageKeys(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<void> {
  expect(res.status()).toBe(403);
  expect(((await res.json()) as CodedError).details?.code).toBe('key_cannot_manage_keys');
}

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
      const read = await cli.get(`/api/runs/${encodeURIComponent(runId)}`);
      expect(read.status()).toBe(200);
      expect(await read.text(), 'the read returns THIS run').toContain(runId);
      expect((await cli.get(`/api/runs/${encodeURIComponent(runId)}/events/poll`)).status()).toBe(200);
      // A run key is protocol-only: the app's own routes ask a key for a
      // workspace scope it did not declare (ADR 0795 D2).
      const vendor = await cli.get(`${API}/roster`);
      expect(vendor.status()).toBe(403);
      expect(((await vendor.json()) as { details?: { code?: string } }).details?.code).toBe('key_scope_required');
      // And the key cannot mint or list keys (ADR 0800 D1).
      await expectKeyCannotManageKeys(await cli.post(`${API}/developer-keys`, { data: { name: 'wider' } }));
      await expectKeyCannotManageKeys(await cli.get(`${API}/developer-keys`));
    } finally {
      await cli.dispose();
    }

    // Done removes the key from the page: it is shown once — and a reload of the
    // list (what the page persists) never carries it either.
    await issued.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(token)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.mcp-key', { hasText: 'Laptop — CLI' })).toBeVisible();
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
    // "On the date chosen": the STORED expiry is 30 days after creation (± a day for
    // the client/server clock split) — not merely "some expiry".
    const listed = (await (await page.request.get(`${API}/developer-keys`)).json()) as KeyList;
    const stored = listed.keys.find((k) => k.name === 'Terminal');
    expect(stored?.expiresAt, 'the CLI key was stored with an expiry').toBeTruthy();
    const days = (Date.parse(stored?.expiresAt ?? '') - Date.parse(stored?.createdAt ?? '')) / DAY_MS;
    expect(Math.abs(days - 30), `stored lifetime ${days} days, chose 30`).toBeLessThan(1);

    const cli = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}), extraHTTPHeaders: { authorization: `Bearer ${token}`, 'OpenWOP-Version': '2' } });
    try {
      expect((await cli.get(`${API}/roster`)).status()).toBe(200);
      const create = await cli.post('/api/runs', { data: RUN });
      expect(create.status(), await create.text()).toBe(201);
      await expectKeyCannotManageKeys(await cli.get(`${API}/developer-keys`));
      // In the URL instead of the header, the same key is refused (ADR 0795 D5).
      const bare = await playwright.request.newContext({ ...(baseURL ? { baseURL } : {}) });
      try {
        const inUrl = await bare.get(`/api/runs?apiKey=${encodeURIComponent(token)}`);
        expect(inUrl.status()).toBe(401);
        // THIS refusal (the D5 header-only rule), not a generic missing-credential 401.
        expect(await inUrl.text()).toContain('not in the URL');
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
      const refused = await cli.get(`/api/runs/${encodeURIComponent(runId)}`);
      expect(refused.status()).toBe(403);
      // Refused for the missing protocol scope, not by some other guard.
      expect(await refused.text()).toContain('runs:read');
    } finally {
      await cli.dispose();
    }

    // The tab lists that key too, marked as an AI-client key.
    await page.goto('/access?tab=api-keys');
    await expect(page.locator('.mcp-key', { hasText: 'MCP: control' })).toContainText('AI client');
  });
});
