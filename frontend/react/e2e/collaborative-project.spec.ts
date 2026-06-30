import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * End-to-end test for the collaborative project (ADR 0054) — charter, member-scoped
 * visibility, group chat, and the convene cadence (Phases 1–4 / D6).
 *
 * ── OPT-IN / CI-SAFE ──────────────────────────────────────────────────────────
 * Gated on `OPENWOP_E2E_COLLAB=1`. Without it (the default CI path) every test in
 * this file SKIPS, so it never runs against an environment that lacks the seams.
 *
 * ── PREREQUISITES (run locally) ───────────────────────────────────────────────
 * 1. A backend on :8080 booted with the test seams + dev toggle admin:
 *      OPENWOP_TEST_AUTH_ENABLED=true \
 *      OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
 *      OPENWOP_STORAGE_DSN=memory:// \
 *      OPENWOP_SESSION_SECRET=dev-session-secret-at-least-32-characters-long \
 *      node backend/typescript/dist/index.js        # or your usual dev-run
 *    (`DEV_OPEN` lets any authenticated caller flip a toggle; the seam mints sessions.)
 * 2. The Vite dev server in COOKIE auth mode against that backend, so a `test/login`
 *    cookie authenticates the browser (prod parity):
 *      VITE_OPENWOP_AUTH_MODE=cookie VITE_OPENWOP_BASE_URL=/api \
 *        OPENWOP_DEV_PROXY_TARGET=http://localhost:8080 npm run dev
 *    (Playwright's webServer has `reuseExistingServer`, so it attaches to this one.)
 * 3. Browsers: `npx playwright install chromium`.
 *
 * ── RUN ───────────────────────────────────────────────────────────────────────
 *      OPENWOP_E2E_COLLAB=1 npm run test:e2e -- collaborative-project
 *
 * NOTE — the convene step (Phase 4) only dispatches turns when a model provider is
 * configured (BYOK). Without a key the agents can't actually reply, so this spec
 * asserts the convene is WIRED (the control exists, fires, and doesn't crash) rather
 * than asserting generated content. The fine-grained backend rules (turnPolicy clamp,
 * moderator∈members 422/404, private-project 404 across surfaces) are covered by
 * `backend/typescript/test/projects-route.test.ts`; this is the live-UX confirmation.
 */

const ENABLED = process.env.OPENWOP_E2E_COLLAB === '1';

// Same workspace for both users (co-tenant) so membership + private visibility are
// exercisable. `test/login` accepts an explicit tenantId; emails derive stable subjects.
const TENANT = 'e2e-collab';
const PROJECT_NAME = `E2E Collab ${Date.now()}`;
const AGENT_ID = 'core.openwop.agents.brief-writer'; // an installable demo agent

const api = '/v1/host/openwop-app';

interface LoginResponse { user: { userId: string } }

/** test/login (cookie seam) → userId; the `__session` cookie lands in `ctx`'s jar. */
async function login(ctx: APIRequestContext, email: string): Promise<string> {
  const res = await ctx.post(`${api}/test/login`, { data: { email, tenantId: TENANT } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as LoginResponse).user.userId;
}

test.describe('Collaborative project (ADR 0054) — end-to-end', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_COLLAB=1 + run a local backend with the test seams (see file header).');
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let ownerCtx: BrowserContext;
  let mateCtx: BrowserContext;
  let owner: Page;
  let mate: Page;
  let orgId = '';
  let agentRosterId = '';
  let outsiderRosterId = '';
  let mateId = '';
  let projectId = '';

  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return; // belt-and-suspenders: never touch a backend when disabled
    ownerCtx = await browser.newContext();
    mateCtx = await browser.newContext();
    const o = ownerCtx.request;

    // ── Owner: auth + workspace + agents (via the API, then the UI drives the feature) ──
    await login(o, 'owner@e2e.test');

    // Collaborative projects are always-on (graduated off the `project-collab`
    // toggle 2026-06-16) — no enable step; the surfaces serve unconditionally.
    orgId = (await (await o.post(`${api}/orgs`, { data: { name: 'E2E Org' } })).json()).orgId;
    agentRosterId = (await (await o.post(`${api}/roster`, { data: { persona: 'E2E Agent', agentRef: { agentId: AGENT_ID } } })).json()).rosterId;
    outsiderRosterId = (await (await o.post(`${api}/roster`, { data: { persona: 'Outsider Agent', agentRef: { agentId: AGENT_ID } } })).json()).rosterId;

    // ── Mate: a co-tenant org VIEWER (workspace:read), NOT yet a project member ──
    mateId = await login(mateCtx.request, 'mate@e2e.test');
    const addMate = await o.post(`${api}/orgs/${orgId}/members`, { data: { displayName: 'Mate', subject: mateId, roles: ['viewer'] } });
    expect(addMate.ok(), `add org member: ${await addMate.text()}`).toBeTruthy();

    owner = await ownerCtx.newPage();
    mate = await mateCtx.newPage();
  });

  test.afterAll(async () => {
    if (!ENABLED) return;
    await ownerCtx?.close();
    await mateCtx?.close();
  });

  test('Phase 1 — charter: create a project and author its charter', async () => {
    await owner.goto('/projects');
    await owner.getByLabel('Workspace').selectOption({ label: 'E2E Org' });
    await owner.getByLabel('New project name').fill(PROJECT_NAME);
    await owner.getByRole('button', { name: 'Create project' }).click();

    const link = owner.getByRole('link', { name: PROJECT_NAME });
    await expect(link).toBeVisible();
    await link.click();
    await expect(owner).toHaveURL(/\/projects\/[^/]+/);
    projectId = owner.url().match(/\/projects\/([^/?]+)/)?.[1] ?? '';
    expect(projectId).toBeTruthy();

    await owner.getByRole('tab', { name: 'Overview' }).click();
    await owner.getByRole('button', { name: 'Add a charter' }).click(); // no-charter empty-state CTA
    await owner.getByLabel('Goal').fill('Ship the Q3 launch');
    await owner.getByLabel('Status').selectOption('active');
    await owner.getByLabel('Health').selectOption('on-track');
    await owner.getByRole('button', { name: 'Save charter' }).click();

    await expect(owner.getByText('Ship the Q3 launch')).toBeVisible();
    // Scope to the chip so a stray "active"/"on-track" elsewhere can't trip strict mode.
    await expect(owner.locator('.chip', { hasText: 'active' })).toBeVisible();   // status chip
    await expect(owner.locator('.chip', { hasText: 'on-track' })).toBeVisible(); // health chip
  });

  test('Phase 2 — membership + private visibility (always-on)', async () => {
    // The Members + Chat tabs render unconditionally (always-on since 2026-06-16).
    await owner.getByRole('tab', { name: 'Members' }).click();

    // Make it private and confirm the selected state is exposed (aria-pressed).
    await owner.getByRole('button', { name: 'Private' }).click();
    await expect(owner.getByRole('button', { name: 'Private' })).toHaveAttribute('aria-pressed', 'true');

    // Add the agent, then Mate (person).
    await owner.getByLabel('Person or agent').selectOption({ label: 'E2E Agent (agent)' });
    await owner.getByRole('button', { name: 'Add', exact: true }).click();
    await owner.getByLabel('Person or agent').selectOption({ label: 'Mate (person)' });
    await owner.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(owner.getByText('E2E Agent')).toBeVisible();
    await expect(owner.getByText('Mate', { exact: true })).toBeVisible();
  });

  test('Phase 2 (authz) — a member reads but cannot write; a non-member is 404 across surfaces', async () => {
    // Mate IS a member → can SEE the private project.
    await mate.goto(`/projects/${projectId}`);
    await expect(mate.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();

    // …but membership is READ only — editing the charter 403s (surfaced as an error notice).
    await mate.getByRole('tab', { name: 'Overview' }).click();
    await mate.getByRole('button', { name: 'Edit', exact: true }).click(); // the charter exists now → "Edit"
    await mate.getByLabel('Goal').fill('Mate should not be able to save this');
    await mate.getByRole('button', { name: 'Save charter' }).click();
    await expect(mate.locator('.alert.error')).toBeVisible();

    // Owner removes Mate from the project.
    await owner.getByRole('tab', { name: 'Members' }).click();
    await owner.locator('li', { hasText: 'Mate' }).getByRole('button', { name: /^Remove/ }).click();

    // Mate reloads → the private project (and every owned surface) is now a uniform 404.
    await mate.goto(`/projects/${projectId}`);
    await expect(mate.getByText('Project not found.')).toBeVisible();
    await expect(mate.getByRole('heading', { name: PROJECT_NAME })).toHaveCount(0);
  });

  test('Phase 3 — group chat: open the project conversation (idempotent, one chat)', async () => {
    await owner.goto(`/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Chat' }).click();
    await owner.getByRole('button', { name: 'Open project chat' }).click();

    // Deep-links into the ONE shared chat surface (no second chat system).
    await expect(owner).toHaveURL(/\/chat(\?|$)/);
    await expect(owner.locator('main#main-content')).toBeVisible();
    await expect(owner.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Phase 4 — convene cadence: configure + convene (D6)', async () => {
    await owner.goto(`/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Chat' }).click();

    // Configure the cadence (moderator MUST be a project agent member).
    await owner.getByLabel('Moderator (chair)').selectOption({ label: 'E2E Agent' });
    await owner.getByLabel('Rounds').selectOption('2');
    await owner.getByLabel('Order').selectOption('round-robin');
    await owner.getByRole('button', { name: 'Save cadence' }).click();
    await expect(owner.getByText('Cadence saved.')).toBeVisible();

    // Backend guard: an agent that is NOT a project member can't be the moderator (422).
    const bad = await ownerCtx.request.patch(`${api}/projects/${projectId}`, { data: { moderatorRosterId: outsiderRosterId } });
    expect(bad.status(), `non-member moderator must be 422: ${await bad.text()}`).toBe(422);

    // Convene is WIRED (turn-taking itself needs a model provider — see header note).
    await owner.getByRole('button', { name: 'Open project chat' }).click();
    const convene = owner.getByRole('button', { name: 'Convene the team' });
    await expect(convene).toBeVisible();
    await convene.click();
    await expect(owner.getByText('Something went wrong')).toHaveCount(0);
  });
});
