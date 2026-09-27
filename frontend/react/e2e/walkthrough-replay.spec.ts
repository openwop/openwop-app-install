/**
 * ADR 0368 Phase 5 — headless tour replay: the SAME saved workflow the user
 * plays in `/test` runs as an end-to-end test (tours-as-executable-specs).
 * Opt-in harness (like collab-ct): set TOUR_E2E=1 to run — needs the local
 * two-server stack (backend :8091 test-auth + vite :5173 cookie posture);
 * the CI sweep never pays for it.
 *
 * HITL steps can't wait for a human here: the spec plays the user — it types
 * the brief name into the spotlighted input, then resolves the open HITL
 * interrupt via the same API the chrome's "I did it" uses.
 */
import { test, expect } from '@playwright/test';
import { login, enableToggle, API } from './support/session';

test.skip(!process.env.TOUR_E2E, 'walkthrough replay harness — set TOUR_E2E=1 to run');

const TOUR_ID = 'walkthrough.campaign-studio.first-brief';

test('the Campaign Studio reference tour replays end-to-end (HITL played by the spec)', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  await login(ctx.request, `tour-${Date.now()}@e2e.test`, `org:tour-${Date.now()}`);
  for (const id of ['guided-tours', 'campaign-brief', 'manual-tests']) {
    expect(await enableToggle(ctx.request, id)).toBe(true);
  }
  // ADR 0435 — the reference walkthrough is SEEDED demo data now (it used to be
  // a builtin), so the tenant has to load it before there is anything to play.
  const seeded = await ctx.request.post(`${API}/example-data/seed`, { data: { steps: ['demo-walkthroughs'] } });
  expect(seeded.ok()).toBe(true);

  const page = await ctx.newPage();

  // Play from the /test runner — the PRD's surface.
  await page.goto('/test');
  const playBtn = page.getByRole('button', { name: /play/i }).first();
  await expect(playBtn).toBeVisible({ timeout: 30_000 });
  await playBtn.click();

  // Step 1 (scripted): the player opens the New-brief modal itself.
  await expect(page.locator('[data-tour="new-brief-form"]')).toBeVisible({ timeout: 30_000 });

  // Step 2 (HITL): the spec plays the user — type the name, resolve the interrupt.
  await page.locator('[data-tour="new-brief-form"] input').first().fill('[Tour] E2E brief');
  const runsRes = await ctx.request.get(`${API}/runs?limit=5`).catch(() => null);
  // Resolve via the run's open interrupt (the chrome's "I did it" path).
  const active = await page.evaluate(() => sessionStorage.getItem('openwop.walkthrough.active'));
  expect(active).toBeTruthy();
  const { runId } = JSON.parse(active!) as { runId: string };
  const ints = await ctx.request.get(`${API}/host/openwop-app/runs/${runId}/interrupts`);
  const open = ((await ints.json()) as { interrupts: Array<{ nodeId: string; resolvedAt?: string }> })
    .interrupts.find((i) => !i.resolvedAt);
  expect(open).toBeTruthy();
  await ctx.request.post(`${API}/runs/${runId}/interrupts/${open!.nodeId}`, { data: { resumeValue: { acked: true } } });

  // Steps 3–5 (scripted): create → checkpoint → Campaigns tab; then completion.
  await expect(page.locator('[role="tab"][id$="-tab-campaigns"][aria-selected="true"]')).toBeVisible({ timeout: 60_000 });
  void runsRes;

  // The run completed + progress recorded.
  await expect(async () => {
    const prog = await ctx.request.get(`${API}/host/openwop-app/guided-tours/progress`);
    const body = (await prog.json()) as { progress: Array<{ tourId: string; status: string }> };
    expect(body.progress.find((p) => p.tourId === TOUR_ID)?.status).toBe('completed');
  }).toPass({ timeout: 30_000 });

  await ctx.close();
});
