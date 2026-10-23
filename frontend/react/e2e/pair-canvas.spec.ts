import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './support/session.js';

/**
 * ADR 0773 G-10a — Pair Canvas in a real browser, BOTH polarities of its toggle.
 *
 * The G-10a plan called for a one-off human check on a deployed build. This is
 * that check as a ratchet: it runs on every `npm run ci`, which is the
 * difference between a check and an anecdote (the preset-inputs precedent).
 *
 * MODEL-FREE BY CONSTRUCTION. The lane has no provider key, so nothing here may
 * depend on a model turn. The ghost → review → keep → undo path is driven by the
 * TEMPLATE lane (`POST …/builder-pair/suggestions/from-chain`), which mints a
 * suggestion server-side without a model — the same `WorkflowEditSuggestion`
 * the Architect's `suggest-edits` produces, reviewed by the same UI. What the
 * model DOES with the tools is G-10b's job (docs/evals/builder-pair-architect.md).
 *
 * SERIAL + TENANT-SCOPED: `feature-toggles/admin/configs/<id>` is one shared
 * row (e2e/README.md trap 4). Flipping its GLOBAL status leaked into every
 * other spec running in parallel: with `builder-pair` on, the builder's right
 * rail opens on Pair instead of Inspect, so `preset-inputs-clickthrough` CT-E1/
 * E2/E4 never saw their Inspector field and main went red whenever the two
 * overlapped (2026-09-29). Each test now sets a PER-TENANT override for its own
 * personal tenant only — the global status is never written — and `afterAll`
 * removes exactly the overrides it added. (Serial mode is still required: every
 * `setToggle` is a read-modify-write of that ONE row, so two of this file's own
 * tests in parallel would lose each other's override. A red therefore skips the
 * cases after it.)
 *
 * Sabotage that turns it red: ignoring the per-tenant override (OFF — the read
 * is awaited and asserted, so the absence check cannot pass while toggles load);
 * a ⌘⏎ that keeps nothing; ⌘. opening the prompt at the first node instead of
 * the selected one (`Second step` is selected); "Fit to suggestion" ignoring
 * which ops still wait; the status edge counting connections as steps (seeded
 * 2 steps · 1 connection); a template chip misstating its size (pinned 1 step).
 *
 * CEILING (W54-PAIR-D4-1): both input-free fixture chains draw ONE step, so the
 * Keep-all case cannot tell "one undo per gesture" (ADR 0773 D4) from "one undo
 * per op". A two-step input-free fixture would reflow the pinned `/builder`
 * gallery baseline (ci.sh, ADR 0626 P2), which this file must not force.
 */

/** The personal tenant each request context logged into (the override key). */
const tenantOf = new WeakMap<APIRequestContext, string>();
const touchedTenants = new Set<string>();

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
  const tenantId = ((await res.json()) as { user?: { tenantId?: string } }).user?.tenantId;
  expect(tenantId, `login ${email} returned no tenant`).toBeTruthy();
  tenantOf.set(ctx, tenantId!);
}

async function readToggle(ctx: APIRequestContext): Promise<Record<string, unknown>> {
  const get = await ctx.get(`${API}/feature-toggles/admin/configs/builder-pair`);
  expect(get.ok(), `read toggle builder-pair: ${get.status()}`).toBe(true);
  return (await get.json()) as Record<string, unknown>;
}

async function setToggle(ctx: APIRequestContext, status: 'on' | 'off'): Promise<void> {
  const tenantId = tenantOf.get(ctx);
  expect(tenantId, 'setToggle before loginPersonal on this context').toBeTruthy();
  const config = await readToggle(ctx);
  const overrides = { ...((config.tenantOverrides as Record<string, unknown> | undefined) ?? {}), [tenantId!]: { status } };
  const put = await ctx.put(`${API}/feature-toggles/admin/configs/builder-pair`, {
    data: { ...config, id: 'builder-pair', tenantOverrides: overrides },
  });
  expect(put.ok(), `set builder-pair → ${status} for ${tenantId}: ${put.status()}`).toBe(true);
  touchedTenants.add(tenantId!);
}

/** Seed our own fixture — never measure whatever the shared seed left behind. */
async function seedWorkflow(ctx: APIRequestContext, workflowId: string): Promise<void> {
  const res = await ctx.post(`${API}/workflows`, {
    data: {
      workflowId,
      metadata: { name: 'Pair canvas e2e' },
      nodes: [
        { nodeId: 'first', typeId: 'core.noop', name: 'First step', config: {} },
        { nodeId: 'second', typeId: 'core.noop', name: 'Second step', config: {} },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'first', targetNodeId: 'second' }],
    },
  });
  expect(res.status(), `seed ${workflowId}: ${await res.text()}`).toBeLessThan(300);
}

async function openBuilder(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/builder/${encodeURIComponent(workflowId)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.builder-node').first().waitFor({ state: 'visible', timeout: 20_000 });
}

const PAIR_TAB = { role: 'tab' as const, name: 'Pair' };

/** Start waiting for the SPA's feature-assignment read BEFORE navigating; the
 *  returned function resolves to `builder-pair`'s resolved `enabled`. Until that
 *  read lands `useFeatureAccess` reports its fallback (off), so an absence
 *  check made earlier would pass whatever the override says. */
function awaitPairAssignment(page: Page): () => Promise<boolean | undefined> {
  const res = page.waitForResponse((r) => r.url().endsWith('/host/openwop-app/feature-toggles/assignments') && r.request().method() === 'GET');
  return async () => {
    const body = (await (await res).json()) as { assignments: Array<{ id: string; enabled: boolean }> };
    return body.assignments.find((a) => a.id === 'builder-pair')?.enabled;
  };
}

/** Drop focus to nothing — the review shortcuts are canvas-or-nowhere scoped. */
async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => { const el = document.activeElement; if (el instanceof HTMLElement) el.blur(); });
}

test.describe('Pair Canvas (ADR 0773 G-10a)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test.afterAll(async ({ request }) => {
    if (touchedTenants.size === 0) return;
    try {
      await loginPersonal(request, 'pair-e2e-admin@example.com');
      const config = await readToggle(request);
      const overrides = { ...((config.tenantOverrides as Record<string, unknown> | undefined) ?? {}) };
      for (const t of touchedTenants) delete overrides[t];
      await request.put(`${API}/feature-toggles/admin/configs/builder-pair`, { data: { ...config, id: 'builder-pair', tenantOverrides: overrides } });
    } catch (err) {
      console.warn(`[pair-canvas] could not remove its builder-pair tenant overrides: ${String(err)}`);
    }
  });

  // ADR 0773 G-10e — after graduation the Create-with-AI drawer no longer
  // exists, so OFF means a builder with NO AI surface (the kill switch), not
  // "the old builder". The ON case below is the positive control for the Pair
  // tab selector; the rendered node is the control that this page is a builder.
  test('OFF (kill switch): the builder renders with no Pair rail', async ({ page }) => {
    const ctx = page.request;
    await loginPersonal(ctx, 'pair-e2e-off@example.com');
    await setToggle(ctx, 'off');
    const id = `wf.e2e.pair.off.${Date.now()}`;
    await seedWorkflow(ctx, id);
    const pairEnabled = awaitPairAssignment(page);
    await openBuilder(page, id);
    await expect(page.locator('.builder-node').first()).toBeVisible();
    // The default is ON; only this tenant's override turns it off.
    expect(await pairEnabled(), 'the tenant override reached the resolver').toBe(false);
    await expect(page.getByRole(PAIR_TAB.role, { name: PAIR_TAB.name, exact: true })).toHaveCount(0);
  });

  test('ON: Pair · Inspect rail replaces the drawer; a selected node offers Ask', async ({ page }) => {
    const ctx = page.request;
    await loginPersonal(ctx, 'pair-e2e-on@example.com');
    await setToggle(ctx, 'on');
    const id = `wf.e2e.pair.on.${Date.now()}`;
    await seedWorkflow(ctx, id);
    const pairEnabled = awaitPairAssignment(page);
    await openBuilder(page, id);
    expect(await pairEnabled(), 'CONTROL: the ON override resolves enabled').toBe(true);
    await expect(page.getByRole(PAIR_TAB.role, { name: PAIR_TAB.name, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Inspect', exact: true })).toBeVisible();
    await page.locator('.builder-node').first().click();
    await expect(page.locator('.pair-node-toolbar').getByRole('button', { name: 'Ask', exact: true }).first()).toBeVisible();
  });

  test('ON, empty sheet: a template draws a ghost; Keep all lands it; one undo removes it', async ({ page }) => {
    const ctx = page.request;
    await loginPersonal(ctx, 'pair-e2e-draft@example.com');
    await setToggle(ctx, 'on');
    const id = `wf.e2e.pair.draft.${Date.now()}`;
    await page.goto(`/builder/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: 'What should this workflow do?' })).toBeVisible({ timeout: 20_000 });
    const templates = page.locator('.pair-first-draft__chains').getByRole('button');
    await expect(templates.first(), 'no input-free template offered on the empty sheet').toBeVisible({ timeout: 15_000 });
    await templates.first().click();

    // Ghosts, not nodes: nothing lands on the sheet until the person keeps it.
    const ghosts = page.locator('.builder-node--ghost');
    await expect(ghosts.first(), 'the template never drew as ghosts').toBeVisible({ timeout: 20_000 });
    const ghostCount = await ghosts.count();
    expect(ghostCount, 'both input-free fixture templates draw ONE step').toBe(1);
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(0);

    await page.getByRole('button', { name: 'Keep all' }).first().click();
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(ghostCount, { timeout: 10_000 });
    await expect(ghosts).toHaveCount(0);

    // One gesture, one undo step (ADR 0773 D4) — with ONE op this cannot tell a
    // per-gesture undo from a per-op one: the W54-PAIR-D4-1 ceiling (header).
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(0, { timeout: 10_000 });
  });
  /**
   * Keyboard only (G-10a's keyboard half). Both fixture templates draw ONE step,
   * so J/K stepping between ops is covered by the store tests
   * (`pairStoreWorkflowGuard` / `pairGapClosure`), not here; what a browser adds
   * is that the canvas-scoped shortcuts actually reach the store.
   */
  async function draftByKeyboard(page: Page, email: string): Promise<void> {
    await loginPersonal(page.request, email);
    await setToggle(page.request, 'on');
    await page.goto(`/builder/${encodeURIComponent(`wf.e2e.pair.keys.${Date.now()}`)}`, { waitUntil: 'domcontentloaded' });
    const template = page.locator('.pair-first-draft__chains').getByRole('button').first();
    await expect(template).toBeVisible({ timeout: 20_000 });
    await template.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.builder-node--ghost.is-focused'), 'a fresh suggestion focuses its first op').toHaveCount(1, { timeout: 20_000 });
    // The review shortcuts are canvas-scoped: focus on nothing, as after a click on the sheet.
    await blurActive(page);
  }
  const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

  test('ON, keyboard only: ⌘⏎ keeps the focused step, ⌘Z undoes it', async ({ page }) => {
    await draftByKeyboard(page, 'pair-e2e-keys-keep@example.com');
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(0, { timeout: 10_000 });
  });

  test('ON, keyboard only: ⌘⌫ drops the focused step and writes nothing', async ({ page }) => {
    await draftByKeyboard(page, 'pair-e2e-keys-drop@example.com');
    await page.keyboard.press(`${MOD}+Backspace`);
    await expect(page.locator('.builder-node--ghost.is-dropped')).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(0);
  });
  // ── ADR 0773 P11 — the canvas-parity details ──────────────────────────

  test('P11: Esc hides the review, J brings it back; the changes stay drawn', async ({ page }) => {
    await draftByKeyboard(page, 'pair-e2e-p11-esc@example.com');
    const instrument = page.getByRole('group', { name: 'Suggestion review' });
    await expect(instrument).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(instrument).toHaveCount(0);
    await expect(page.locator('.builder-node--ghost').first(), 'Esc must not drop the changes').toBeVisible();
    await page.keyboard.press('j');
    await expect(instrument).toBeVisible();
  });

  test('P11: the status edge counts the sheet; template chips say their size', async ({ page }) => {
    await loginPersonal(page.request, 'pair-e2e-p11-status@example.com');
    await setToggle(page.request, 'on');
    await page.goto(`/builder/${encodeURIComponent(`wf.e2e.pair.p11s.${Date.now()}`)}`, { waitUntil: 'domcontentloaded' });
    const chips = page.locator('.pair-first-draft__chains');
    // Both input-free fixture chains have nodeCount 1.
    await expect(chips.getByRole('button').first(), 'a template chip shows how many steps it draws').toContainText(/· 1 step(?!s)/, { timeout: 20_000 });
    await expect(chips.getByRole('link', { name: 'Browse all templates' })).toHaveAttribute('href', '/builder');
    await expect(page.locator('.pair-status')).toContainText('0 steps · 0 connections');
    // A seeded sheet whose counts differ (2 nodes, 1 edge): steps and
    // connections are each counted from their own collection.
    const seeded = `wf.e2e.pair.p11s2.${Date.now()}`;
    await seedWorkflow(page.request, seeded);
    await openBuilder(page, seeded);
    await expect(page.locator('.pair-status')).toContainText('2 steps · 1 connection');
  });

  test('P11: ⌘. with a node selected opens the prompt at that node', async ({ page }) => {
    const ctx = page.request;
    await loginPersonal(ctx, 'pair-e2e-p11-inline@example.com');
    await setToggle(ctx, 'on');
    const id = `wf.e2e.pair.p11i.${Date.now()}`;
    await seedWorkflow(ctx, id);
    await openBuilder(page, id);
    // The SECOND node, so "at the selected node" differs from "at the first node".
    await page.locator('.builder-node', { hasText: 'Second step' }).click();
    await blurActive(page);
    await page.keyboard.press(`${MOD}+.`);
    await expect(page.locator('.pair-node-toolbar').getByLabel(/Ask about Second step/)).toBeFocused({ timeout: 5_000 });
  });
  test('P11: the zoom menu offers "Fit to suggestion" only while changes wait', async ({ page }) => {
    await draftByKeyboard(page, 'pair-e2e-p11-fit@example.com');
    const zoomMenu = page.getByRole('button', { name: /^Zoom \d+% — presets & fit$/ });
    await zoomMenu.click();
    const fit = page.getByRole('menuitem', { name: 'Fit to suggestion' });
    await expect(fit).toBeVisible();
    await fit.click();
    // Keep the change: nothing waits, so the entry is gone. (The review keys
    // are canvas-scoped, so leave the zoom button first.)
    await blurActive(page);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.locator('.builder-node:not(.builder-node--ghost)')).toHaveCount(1, { timeout: 10_000 });
    await zoomMenu.click();
    // Positive control: the menu is open before the entry's absence is read.
    await expect(page.getByRole('menuitem', { name: /^Zoom to fit/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fit to suggestion' })).toHaveCount(0);
  });
});
