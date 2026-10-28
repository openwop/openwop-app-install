/**
 * CE-12 — the three manual smokes owed after the 2026-09-30 releases, as specs so
 * they are never "owed" again:
 *
 *  1. The chat tools REVIEWS panel (`chat/reviews/ReviewInboxPanel`, the
 *     smoke's "ApprovalCard" — corrected w53: this spec never renders
 *     `interrupts/ApprovalCard.tsx`), a decision that lost the race (ADR 0778 D10,
 *     #4233): the server answers 409 and the panel says "resolved elsewhere" —
 *     never "Decision recorded". jsdom twin with a MOCKED 409:
 *     `ReviewInboxPanel.test.tsx` "a 409 says "resolved elsewhere"…"; this is the
 *     only run where the REAL backend produces the 409.
 *  2. Deleting a BOUND key on /access?tab=keys (ADR 0779 D7, #4234): the server
 *     refuses (409, live references), and a SEPARATE danger confirmation names the
 *     consumer. Cancelling it leaves the key in place.
 *  3. The chat header as a NON-ADMIN member (ADR 0779 D7, #4234): the provider
 *     card shows, but the "change" control (a workspace write the server refuses
 *     a member) is not offered. The owner of the same workspace does see it.
 *     HONEST CEILING (w53): its UI half NEVER RUNS in this repo. Both e2e lanes
 *     (ci.sh and e2e-routes.sh) boot with OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true, which
 *     makes every tenant a superadmin (`host/superadmin.ts` isSuperadminTenant), so the
 *     case skips itself after its API half. Its twins carry the claim:
 *     `src/byok/__tests__/byokReadOnly.test.tsx` ("the compact chat-header card offers a
 *     member no "Change"" + its admin polarity) and
 *     `backend/typescript/test/adr0711-byok-operator-gate.test.ts` (an editor is a
 *     member and is refused the BYOK writes with `host:byok:manage` named). Kept, not
 *     an A claim: it runs as written on any backend without DEV_OPEN.
 */
import { test, expect, type APIRequestContext, type Browser } from '@playwright/test';
import { API } from './support/session';

const OPENAI_MODEL = 'gpt-5.6-terra';
const uniq = (): string => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function loginAs(ctx: APIRequestContext, data: Record<string, unknown>): Promise<string> {
  const res = await ctx.post(`${API}/test/login`, { data });
  expect(res.status(), `test/login ${JSON.stringify(data)}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { user: { userId: string } }).user.userId;
}

async function ok(res: Awaited<ReturnType<APIRequestContext['post']>>, what: string): Promise<void> {
  expect(res.status(), `${what}: ${await res.text()}`).toBeLessThan(300);
}

/** Found a workspace as its owner, store an OpenAI key and bind it as the chat
 *  config. A founded workspace, not the personal `user:` tenant: a signed-in
 *  personal tenant cannot store a secret without KMS (`secretResolver.setSecret`),
 *  which a local backend does not have. The chat config is what lets `/chat`
 *  render the conversation (and its rail) instead of the BYOK first-run gate. */
async function ownedWorkspaceWithChat(ctx: APIRequestContext, tag: string): Promise<{ ws: string; ref: string }> {
  const ws = `ws-ce12-${tag}-${uniq()}`;
  await loginAs(ctx, { email: `ce12-${tag}-owner-${uniq()}@e2e.test`, tenantId: ws });
  const ref = `openai:ce12-${tag}-${uniq()}`;
  await ok(await ctx.post(`${API}/byok/secrets`, { data: { credentialRef: ref, value: `sk-ce12-${uniq()}-0123456789abcdef` } }), 'store an OpenAI key');
  const cfg = await ctx.put(`${API}/byok/active-config`, { data: { provider: 'openai', model: OPENAI_MODEL, credentialRef: ref } });
  expect(cfg.status(), `bind it as the workspace chat config: ${await cfg.text()}`).toBeLessThan(300);
  return { ws, ref };
}

test.describe('CE-12 smokes', () => {
  test('Reviews panel: a decision that lost the race says "resolved elsewhere" (ADR 0778 D10)', async ({ page }) => {
    // The owner of the workspace may decide its gates.
    await ownedWorkspaceWithChat(page.request, 'approval');
    const workflowId = `wf.ce12.approval.${uniq()}`;
    const prompt = `CE-12 ship it? ${uniq()}`;
    await ok(await page.request.post(`${API}/workflows`, {
      data: { workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt } }], edges: [] },
    }), 'register the one-gate workflow');
    const started = await page.request.post('/api/runs', { data: { workflowId, inputs: {} } });
    expect(started.status(), await started.text()).toBe(201);
    const runId = ((await started.json()) as { runId: string }).runId;
    const bare = runId.slice(runId.lastIndexOf('/') + 1);
    await expect.poll(async () => ((await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as { status?: string }).status ?? '', {
      timeout: 20_000,
    }).toMatch(/^waiting/);
    const ints = ((await (await page.request.get(`${API}/runs/${encodeURIComponent(bare)}/interrupts`)).json()) as { interrupts: Array<{ interruptId: string; nodeId: string }> }).interrupts;
    const interruptId = ints.find((i) => i.nodeId === 'gate')?.interruptId;
    expect(interruptId, 'the gate opened an interrupt').toBeTruthy();

    // CT-AP-5 is a STALE card: another tab (or person) decided while this view had
    // not heard about it. The live inbox evicts a review the instant the
    // notifications stream delivers its frame (`reviewStatusStore` via the signal
    // bus) — correct, but it skips the very case under test. So this page's stream
    // is held closed: exactly an unrefreshed tab. Reads still reach the server.
    await page.route(/\/notifications\/stream/, (route) => route.abort());
    await page.goto('/chat');
    // The two chat layouts start the tools rail in different states: the single-chat
    // sidebar opens it closed, the multi-tab deck (`multi-tab-chat`, default on) opens
    // it on Conversations so the button reads "Close chat tools". Open it only if it is
    // closed, read off `aria-pressed`, which both layouts' launchers carry.
    const tools = page.getByRole('button', { name: /^(Open|Close) chat tools$/ });
    await expect(tools).toBeVisible({ timeout: 20_000 });
    if ((await tools.getAttribute('aria-pressed')) !== 'true') await tools.click();
    await page.getByRole('tab', { name: /^Reviews/ }).click();
    const card = page.locator('article, li, section, div').filter({ hasText: prompt }).last();
    await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 20_000 });

    // Someone else resolves it first (out of band), THEN this card tries to.
    await ok(await page.request.post(`${API}/reviews/${encodeURIComponent(`interrupt:${interruptId}`)}/actions/approve`, { data: {} }), 'out-of-band approve');
    await card.getByRole('button', { name: 'Approve' }).click();
    // It is said twice — on the card and in its live region — so any one visible copy will do.
    await expect(page.getByText('This review was just resolved elsewhere.').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Decision recorded/i)).toHaveCount(0);
  });

  test('Keys: deleting a key the AI default uses is refused, and the override names the consumer (ADR 0779 D7)', async ({ page }) => {
    const { ref } = await ownedWorkspaceWithChat(page.request, 'keys');
    const bind = await page.request.put(`${API}/byok/ai-default`, { data: { provider: 'openai', model: OPENAI_MODEL, credentialRef: ref } });
    expect(bind.status(), `bind it as the AI default: ${await bind.text()}`).toBeLessThan(300);

    await page.goto('/access?tab=keys');
    await page.getByRole('button', { name: `Delete ${ref}` }).click();
    // First confirmation: the ordinary "Delete key" modal.
    await page.getByRole('dialog').getByRole('button', { name: 'Delete key' }).click();
    // The server refuses (live reference) → a SEPARATE danger confirmation naming it.
    const override = page.getByRole('dialog').filter({ hasText: 'headless-ai default binding' });
    await expect(override).toBeVisible({ timeout: 15_000 });
    await expect(override.getByRole('button', { name: 'Delete anyway' })).toBeVisible();
    // Cancel: nothing is deleted.
    await override.getByRole('button', { name: /cancel/i }).click();
    await expect(override).toHaveCount(0);
    const refs = ((await (await page.request.get(`${API}/byok/secrets`)).json()) as { credentialRefs: string[] }).credentialRefs;
    expect(refs, 'the refused key is still stored').toContain(ref);
  });

  test('Chat header: a non-admin member sees the provider card without the "change" control; the owner sees it (ADR 0779 D7)', async ({ browser }: { browser: Browser }) => {
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    const { ws } = await ownedWorkspaceWithChat(ownerPage.request, 'chat');

    // A second human joins as a non-admin member of the SAME workspace.
    const member = await browser.newContext();
    const memberPage = await member.newPage();
    const memberId = await loginAs(memberPage.request, { email: `ce12-member-${uniq()}@e2e.test`, tenantId: ws, sharedWorkspace: true });
    await ok(await ownerPage.request.post(`${API}/orgs/${encodeURIComponent(ws)}/members`, {
      data: { subject: memberId, displayName: 'CE-12 member', roles: ['editor'] },
    }), 'owner adds the member as an editor');
    // No re-login: membership is re-checked per request (ADR 0015), so the same
    // session now resolves as a member of `ws`.
    const eff = (await (await memberPage.request.get(`${API}/access/effective`)).json()) as { basis?: string; scopes?: string[]; superadmin?: boolean };
    expect(eff.basis, 'the second human resolves as a MEMBER of the workspace').toBe('member');
    expect(eff.scopes ?? [], 'an editor does not hold host:byok:manage').not.toContain('host:byok:manage');
    expect((await memberPage.request.put(`${API}/byok/active-config`, { data: { provider: 'openai', model: OPENAI_MODEL, credentialRef: 'openai:any' } })).status(),
      'the server refuses the member the write the "change" control would make').toBe(403);
    // `OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true` (the standard e2e backend) makes EVERY tenant a
    // superadmin (`isSuperadminTenant`), and the UI rightly offers a superadmin "change" — so the
    // member half is only meaningful on a backend without dev-open. Say so; never pass vacuously.
    test.skip(eff.superadmin === true, 'SKIPS IN EVERY REPO LANE: OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true makes every tenant superadmin, and a superadmin is rightly offered "change". The UI claim is carried by byokReadOnly.test.tsx + backend adr0711-byok-operator-gate.test.ts; run this against a backend without DEV_OPEN.');

    for (const [who, page, offered] of [['owner', ownerPage, 1], ['member', memberPage, 0]] as const) {
      await page.goto('/chat');
      const header = page.locator('.chathdr-model');
      await expect(header, `${who}: the provider card renders in the chat header`).toContainText('OpenAI', { timeout: 20_000 });
      await expect(header.getByRole('button', { name: 'Change provider / model' }), `${who}: the change control`).toHaveCount(offered);
    }
    await owner.close();
    await member.close();
  });
});
