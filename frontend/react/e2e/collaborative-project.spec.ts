import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { API, login } from './support/session.js';

/**
 * End-to-end test for the collaborative project (ADR 0054) — charter, member-scoped
 * visibility, group chat, and the convene cadence (Phases 1–4 / D6).
 *
 * ── OPT-IN (`OPENWOP_E2E_COLLAB=1`) — BLOCKED-ON-PRODUCT, grade-tests wave 53 ──
 * Nothing sets the opt-in, and until wave 53 the spec could not have run anyway:
 * it called `/host/openwop-app/...` (earlier `/v1/host/...`), a path the Vite dev
 * proxy does not forward (only `/api` is proxied), so `test/login` answered 404
 * and `beforeAll` failed every case. It now uses the shared `API` + `login` from
 * `support/session.ts` and the current UI (the org picker is "Organization";
 * narrowing to Private confirms; a read-only member gets no editor at all).
 * MEASURED with the opt-in set against the gate's e2e backend: Phase 1, Phase 2
 * and Phase 2 (authz) PASS; **Phase 3 is RED** — "Open project chat" lands on
 * `/chat?conversation=<id>` (the id is the project's group conversation, which
 * `GET chat/sessions` returns with `ownerSubject: project` and the agent member
 * as a participant), the param is consumed, and the chat renders a BLANK new
 * chat with no "Convene the team" bar. So the opt-in stays until that is fixed
 * (grade-code row PROJ-CHAT-DEEPLINK-1); the gate would otherwise go red. It was
 * NOT loosened to pass.
 *
 * The explicit `TENANT` is deliberate: both users must be co-tenants, and
 * `/projects` is workspace-tier, so trap 1 in `support/session.ts` (admin pages
 * deny an explicit tenant) does not apply.
 *
 * NOTE — the convene step (Phase 4) only gets agent REPLIES when a model provider is
 * configured (BYOK). Without one this spec asserts the convene is WIRED: the button
 * posts the convene opener into the project conversation and no convene failure is
 * shown. The fine-grained backend rules (turnPolicy clamp, moderator∈members 422/404,
 * private-project 404 across surfaces) are covered by
 * `backend/typescript/test/projects-route.test.ts`; this is the live-UX confirmation.
 *
 * Sabotage (wave 53 reprobes, `w53g2-cp-*-r2`): show the charter Edit button to a
 * read-only member → Phase 2 (authz) red; drop the convene opener send → Phase 4 red.
 */

// Same workspace for both users (co-tenant) so membership + private visibility are
// exercisable. `test/login` accepts an explicit tenantId; emails derive stable subjects.
const ENABLED = process.env.OPENWOP_E2E_COLLAB === '1';
const TENANT = 'e2e-collab';
const PROJECT_NAME = `E2E Collab ${Date.now()}`;
const GOAL = 'Ship the Q3 launch';
const AGENT_ID = 'core.openwop.agents.brief-writer'; // an installable demo agent

test.describe('Collaborative project (ADR 0054) — end-to-end', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_COLLAB=1 — opt-in until PROJ-CHAT-DEEPLINK-1 is fixed (see header).');
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let ownerCtx: BrowserContext;
  let mateCtx: BrowserContext;
  let owner: Page;
  let mate: Page;
  let orgId = '';
  let outsiderRosterId = '';
  let mateId = '';
  let projectId = '';

  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return; // never touch a backend when disabled
    ownerCtx = await browser.newContext();
    mateCtx = await browser.newContext();
    const o = ownerCtx.request;

    // ── Owner: auth + workspace + agents (via the API, then the UI drives the feature) ──
    await login(o, 'owner@e2e.test', TENANT);

    // Collaborative projects are always-on (graduated off the `project-collab`
    // toggle 2026-06-16) — no enable step; the surfaces serve unconditionally.
    const org = await o.post(`${API}/orgs`, { data: { name: 'E2E Org' } });
    expect(org.status(), `create org: ${await org.text()}`).toBe(201);
    orgId = ((await org.json()) as { orgId: string }).orgId;
    // Created for its SIDE EFFECT: the cadence test selects this agent by its
    // visible label ('E2E Agent'). The status IS asserted: a failed create would
    // otherwise surface ~100 lines later as "option not found".
    const agent = await o.post(`${API}/roster`, { data: { persona: 'E2E Agent', agentRef: { agentId: AGENT_ID } } });
    expect(agent.ok(), `create 'E2E Agent' roster: ${await agent.text()}`).toBe(true);
    const outsider = await o.post(`${API}/roster`, { data: { persona: 'Outsider Agent', agentRef: { agentId: AGENT_ID } } });
    expect(outsider.ok(), `create 'Outsider Agent' roster: ${await outsider.text()}`).toBe(true);
    outsiderRosterId = ((await outsider.json()) as { rosterId: string }).rosterId;

    // ── Mate: a co-tenant org VIEWER (workspace:read), NOT yet a project member ──
    mateId = await login(mateCtx.request, 'mate@e2e.test', TENANT);
    const addMate = await o.post(`${API}/orgs/${orgId}/members`, { data: { displayName: 'Mate', subject: mateId, roles: ['viewer'] } });
    expect(addMate.ok(), `add org member: ${await addMate.text()}`).toBe(true);

    // The ONE chat gates on a configured model (the BYOK provider picker renders
    // instead of the conversation). Bind the host-managed free tier, as the
    // wizard's "Try it free" does — no key is stored. Replies still need the
    // operator's managed key; this spec asserts only that convene is WIRED.
    const bind = await o.put(`${API}/byok/active-config`, { data: { provider: 'openwop-free', model: 'auto', credentialRef: 'managed:openwop-free' } });
    expect(bind.ok(), `bind managed chat: ${bind.status()} ${await bind.text()}`).toBe(true);

    owner = await ownerCtx.newPage();
    mate = await mateCtx.newPage();
  });

  test.afterAll(async () => {
    await ownerCtx?.close();
    await mateCtx?.close();
  });

  test('Phase 1 — charter: create a project and author its charter', async () => {
    await owner.goto('/projects');
    // The org picker's label is 'Organization' (`ui:orgPickerLabel`); a bare
    // getByLabel('Workspace') resolved to the mobile nav ("Workspace quick access").
    await owner.getByRole('combobox', { name: 'Organization', exact: true }).selectOption({ label: 'E2E Org' });
    await owner.getByLabel('New project name', { exact: true }).fill(PROJECT_NAME);
    await owner.getByRole('button', { name: 'Create project' }).click();

    const link = owner.getByRole('link', { name: PROJECT_NAME });
    await expect(link).toBeVisible();
    await link.click();
    await expect(owner).toHaveURL(/\/projects\/[^/?]+/);
    projectId = owner.url().match(/\/projects\/([^/?]+)/)?.[1] ?? '';
    expect(projectId).not.toBe('');

    await owner.getByRole('tab', { name: 'Overview' }).click();
    await owner.getByRole('button', { name: 'Add a charter' }).click(); // no-charter empty-state CTA
    await owner.getByLabel('Goal', { exact: true }).fill(GOAL);
    await owner.getByLabel('Status', { exact: true }).selectOption('active');
    await owner.getByLabel('Health', { exact: true }).selectOption('on-track');
    await owner.getByRole('button', { name: 'Save charter' }).click();

    await expect(owner.getByText(GOAL, { exact: true })).toBeVisible();
    // Scope to the chip so a stray "active"/"on-track" elsewhere can't trip strict mode.
    await expect(owner.locator('.chip', { hasText: /^active$/ })).toBeVisible();   // status chip
    await expect(owner.locator('.chip', { hasText: /^on-track$/ })).toBeVisible(); // health chip

    // The SAVE, not just the render: read the charter back from the server.
    const read = await ownerCtx.request.get(`${API}/projects/${projectId}`);
    expect(read.status()).toBe(200);
    expect(((await read.json()) as { charter?: { goal?: string } }).charter?.goal).toBe(GOAL);
  });

  test('Phase 2 — membership + private visibility (always-on)', async () => {
    await owner.getByRole('tab', { name: 'Members' }).click();

    // Make it private. Narrowing scope asks first (ADR 0608 D8 — a confirm dialog
    // whose action is "Make private"); then the selected state is exposed (aria-pressed).
    const privateBtn = owner.getByRole('button', { name: 'Private', exact: true });
    await expect(privateBtn).toHaveAttribute('aria-pressed', 'false');
    await privateBtn.click();
    await owner.getByRole('button', { name: 'Make private', exact: true }).click();
    await expect(privateBtn).toHaveAttribute('aria-pressed', 'true');

    // Add the agent, then Mate (person).
    // Each add lands (its Remove control appears) before the next pick: the picker
    // resets after an add, so selecting during the first write was undone by it.
    await owner.getByLabel('Person or agent', { exact: true }).selectOption({ label: 'E2E Agent (agent)' });
    await owner.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(owner.getByRole('button', { name: 'Remove E2E Agent' })).toBeVisible();
    await owner.getByLabel('Person or agent', { exact: true }).selectOption({ label: 'Mate (person)' });
    await owner.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(owner.getByRole('button', { name: 'Remove Mate' })).toBeVisible();
  });

  test('Phase 2 (authz) — a member reads but cannot write; a non-member is 404 across surfaces', async () => {
    // Mate IS a member → can SEE the private project.
    await mate.goto(`/projects/${projectId}`);
    await expect(mate.getByRole('heading', { name: PROJECT_NAME })).toBeVisible();

    // …but membership is READ only. The page says so, and offers no charter editor:
    // the read-only notice is the positive control that the page resolved its access
    // before the absence below is read.
    await mate.getByRole('tab', { name: 'Overview' }).click();
    await expect(mate.getByText('You have read-only access to this project.', { exact: false })).toBeVisible();
    await expect(mate.getByText(GOAL, { exact: true })).toBeVisible();
    await expect(mate.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(mate.getByRole('button', { name: 'Add a charter' })).toHaveCount(0);

    // The server is the authority, not the hidden button: a direct write is refused,
    // and the charter is unchanged when the owner reads it back.
    const write = await mateCtx.request.patch(`${API}/projects/${projectId}`, {
      data: { charter: { goal: 'Mate should not be able to save this' } },
    });
    expect(write.status(), await write.text()).toBe(403);
    const after = await ownerCtx.request.get(`${API}/projects/${projectId}`);
    expect(((await after.json()) as { charter?: { goal?: string } }).charter?.goal).toBe(GOAL);

    // Owner removes Mate from the project.
    await owner.getByRole('tab', { name: 'Members' }).click();
    await owner.getByRole('button', { name: 'Remove Mate' }).click();
    await expect(owner.getByRole('button', { name: 'Remove Mate' })).toHaveCount(0);

    // Mate reloads → the private project (and every owned surface) is now a uniform 404.
    await mate.goto(`/projects/${projectId}`);
    await expect(mate.locator('#main-content').getByText('Project not found.', { exact: true })).toBeVisible();
    await expect(mate.getByRole('heading', { name: PROJECT_NAME })).toHaveCount(0);
    const gone = await mateCtx.request.get(`${API}/projects/${projectId}`);
    expect(gone.status()).toBe(404);
  });

  test('Phase 3 — group chat: open the project conversation (idempotent, one chat)', async () => {
    await owner.goto(`/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Chat' }).click();
    await owner.getByRole('button', { name: 'Open project chat' }).click();

    // Deep-links into the ONE shared chat surface (no second chat system).
    await expect(owner).toHaveURL(/\/chat\?conversation=[^&]+/);
    const first = new URL(owner.url()).searchParams.get('conversation');
    // The shared chat opened THIS project's group conversation: only a project
    // conversation carries the "Convene the team" bar (ADR 0054 D6).
    await expect(owner.locator('main#main-content')).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Convene the team' })).toBeVisible({ timeout: 15_000 });

    // Idempotent: opening it again lands on the SAME conversation.
    await owner.goto(`/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Chat' }).click();
    await owner.getByRole('button', { name: 'Open project chat' }).click();
    await expect(owner).toHaveURL(/\/chat\?conversation=[^&]+/);
    expect(new URL(owner.url()).searchParams.get('conversation')).toBe(first);
  });

  test('Phase 4 — convene cadence: configure + convene (D6)', async () => {
    await owner.goto(`/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Chat' }).click();

    // Configure the cadence (moderator MUST be a project agent member).
    await owner.getByLabel('Moderator (chair)', { exact: true }).selectOption({ label: 'E2E Agent' });
    await owner.getByLabel('Rounds', { exact: true }).selectOption('2');
    await owner.getByLabel('Order', { exact: true }).selectOption('round-robin');
    await owner.getByRole('button', { name: 'Save cadence' }).click();
    await expect(owner.getByText('Cadence saved.')).toBeVisible();

    // Backend guard: an agent that is NOT a project member can't be the moderator (422).
    const bad = await ownerCtx.request.patch(`${API}/projects/${projectId}`, { data: { moderatorRosterId: outsiderRosterId } });
    expect(bad.status(), `non-member moderator must be 422: ${await bad.text()}`).toBe(422);

    // Convene is WIRED (turn-taking itself needs a model provider — see header note):
    // the opener lands in the conversation, and none of the convene failures shows.
    await owner.getByRole('button', { name: 'Open project chat' }).click();
    const convene = owner.getByRole('button', { name: 'Convene the team' });
    await expect(convene).toBeVisible();
    await convene.click();
    await expect(owner.getByText('Let’s convene the team — where do things stand on this project', { exact: false })).toBeVisible();
    await expect(owner.getByText('Couldn’t convene the project team', { exact: false })).toHaveCount(0);
    await expect(owner.getByText('No agents on this project are available yet', { exact: false })).toHaveCount(0);
    await expect(owner.getByText('The moderator you chose for this project is not available', { exact: false })).toHaveCount(0);
  });
});
