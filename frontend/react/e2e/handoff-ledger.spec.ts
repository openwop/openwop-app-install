import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API } from './support/session.js';

/**
 * ADR 0829 (structured handoffs) + ADR 0831 (team intent ledger) in a real
 * browser. Both are ALWAYS ON since 2026-10-07 (their toggles were removed), so
 * the unit tests prove the parts and this proves the person's path through them:
 *
 *   - Ledger: every project has the Ledger tab; start the ledger, propose a
 *     scope change with a reason, see it lead the page (decision-first), accept
 *     it as the owner, and watch the version move 1 → 2 with the accepted scope.
 *   - Handoff: picking a person opens the handoff dialog; "Assign with note"
 *     lands a note that the card shows, and it survives a reload (it was stored,
 *     not just rendered).
 *
 * MODEL-FREE. Nothing here needs a provider key. Each test logs into its OWN
 * personal workspace (no explicit tenantId, e2e/README.md trap 1 — the board is
 * admin-tier) and writes no toggle.
 */

const tenantOf = new WeakMap<APIRequestContext, string>();

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<{ tenantId: string; userId: string }> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${res.status()} ${await res.text()}`).toBe(201);
  const user = ((await res.json()) as { user?: { tenantId?: string; userId?: string } }).user;
  expect(user?.tenantId, `login ${email} returned no tenant`).toBeTruthy();
  tenantOf.set(ctx, user!.tenantId!);
  return { tenantId: user!.tenantId!, userId: user!.userId! };
}

async function seedProject(ctx: APIRequestContext, name: string): Promise<string> {
  const res = await ctx.post(`${API}/projects`, { data: { orgId: tenantOf.get(ctx), name } });
  expect(res.status(), `seed project: ${await res.text()}`).toBeLessThan(300);
  return ((await res.json()) as { id: string }).id;
}

async function seedCard(ctx: APIRequestContext, title: string): Promise<string> {
  const board = await ctx.post(`${API}/kanban/boards`, { data: { name: `handoff-e2e ${Date.now()}` } });
  expect(board.ok(), `seed board: ${await board.text()}`).toBe(true);
  const boardId = ((await board.json()) as { id: string }).id;
  const card = await ctx.post(`${API}/kanban/boards/${boardId}/cards`, { data: { title, columnId: 'todo' } });
  expect(card.ok(), `seed card: ${await card.text()}`).toBe(true);
  return boardId;
}

async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded' });
  // Control: this IS a rendered project page (Members is unconditional).
  await expect(page.getByRole('tab', { name: 'Members', exact: true })).toBeVisible({ timeout: 20_000 });
}

/** The card's assignee button → the native "Assign to" select. */
async function pickAssignee(page: Page, cardTitle: string, memberLabel: string): Promise<void> {
  const card = page.locator('.kb-card', { hasText: cardTitle }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByTitle('Assign this card to someone').click();
  const select = page.getByRole('combobox', { name: 'Assign to' });
  await expect(select.locator('option', { hasText: memberLabel })).toHaveCount(1, { timeout: 15_000 });
  await select.selectOption({ label: memberLabel });
}

const LEDGER_TAB = { role: 'tab' as const, name: 'Ledger' };

test.describe('Structured handoffs + team intent ledger (ADR 0829 / 0831)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('ledger: start, propose with a reason, the queue leads, owner accepts, version 1 → 2', async ({ page }) => {
    const ctx = page.request;
    await loginPersonal(ctx, 'ledger-e2e-on@example.com');
    await openProject(page, await seedProject(ctx, 'Ledger on'));

    await page.getByRole(LEDGER_TAB.role, { name: LEDGER_TAB.name, exact: true }).click();
    await expect(page.getByText('No team ledger yet')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Start the ledger' }).click();

    const now = page.getByRole('region', { name: 'What this project is for' });
    await expect(now).toBeVisible({ timeout: 15_000 });
    await expect(now.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(now.getByText('Owner: you', { exact: true })).toBeVisible();

    const scopeItem = `Self-serve onboarding ${Date.now()}`;
    await page.getByLabel('In scope', { exact: true }).fill(scopeItem);
    await page.getByLabel('Why (required)').fill('Agreed in the kickoff');
    await page.getByRole('button', { name: 'Propose', exact: true }).click();

    const pending = page.getByRole('region', { name: 'Proposed changes (1)' });
    await expect(pending).toBeVisible({ timeout: 15_000 });
    await expect(pending.getByText('Agreed in the kickoff')).toBeVisible();
    // Proposed is not accepted: the record has not moved yet.
    await expect(now.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(now.getByText(scopeItem)).toHaveCount(0);

    // Decision-first (DESIGN §4.5): the owner's queue renders ABOVE the record.
    // One evaluate so both positions come from the same frame.
    const order = await page.evaluate(() => {
      const q = document.getElementById('ledger-pending');
      const r = document.getElementById('ledger-now');
      if (!q || !r) return 'missing';
      return q.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING ? 'queue-first' : 'record-first';
    });
    expect(order, 'the waiting queue must lead the ledger page').toBe('queue-first');

    await pending.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(now.getByText('Version 2', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(now.getByText(scopeItem)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Proposed changes (1)' })).toHaveCount(0);

    // Stored, not just rendered.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole(LEDGER_TAB.role, { name: LEDGER_TAB.name, exact: true }).click();
    await expect(page.getByRole('region', { name: 'What this project is for' }).getByText(scopeItem)).toBeVisible({ timeout: 15_000 });
  });

  test('handoffs: picking a person opens the note; the card carries it after a reload', async ({ page }) => {
    const ctx = page.request;
    const email = 'handoff-e2e-on@example.com';
    await loginPersonal(ctx, email);
    const title = `Handoff on ${Date.now()}`;
    const boardId = await seedCard(ctx, title);
    await page.goto(`/boards/${encodeURIComponent(boardId)}`, { waitUntil: 'domcontentloaded' });

    await pickAssignee(page, title, email);
    const dialog = page.getByRole('dialog', { name: `Hand off to ${email}` });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // The intent starts as the card title; it is required, so clearing it
    // turns the send button off (positive control: filling turns it back on).
    const intent = dialog.getByLabel('What this is for');
    const send = dialog.getByRole('button', { name: 'Assign with note' });
    await expect(intent).toHaveValue(title);
    await intent.fill('');
    await expect(send).toBeDisabled();
    await intent.fill('Ship the pricing page copy');
    await expect(send).toBeEnabled();
    await dialog.getByLabel('Decided so far').fill('Three tiers\nAnnual discount 20%');
    await dialog.getByLabel('Still open').fill('Enterprise tier name?');
    await dialog.getByLabel('How sure are you?').selectOption('medium');
    await dialog.getByRole('button', { name: 'Assign with note' }).click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });

    const assertNote = async (): Promise<void> => {
      const card = page.locator('.kb-card', { hasText: title }).first();
      const toggle = card.getByRole('button', { name: 'Handoff note' });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await toggle.click();
      await expect(card.getByText('Ship the pricing page copy')).toBeVisible();
      await expect(card.getByText('Annual discount 20%')).toBeVisible();
      await expect(card.getByText('Enterprise tier name?')).toBeVisible();
      await expect(card.getByText('Confidence: medium')).toBeVisible();
    };
    await assertNote();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertNote();
  });
});
