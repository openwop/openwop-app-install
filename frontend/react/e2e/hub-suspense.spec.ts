import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, enableToggle } from './support/session.js';

/**
 * Hub Suspense boundary — the hub's CHROME renders while its pane is still
 * loading (#2724).
 *
 * WHAT THIS CAN AND CANNOT PROVE — read before trusting a green run.
 *
 * The four projection hubs render lazy feature routes as their pane. With no
 * boundary of their own, that pane's suspension escapes to the SHELL boundary
 * (`App.tsx:330`), which wraps the whole `<Routes>` — so the user gets a bare
 * page skeleton instead of the hub's header and tab strip. #2724 gave each hub
 * its own panel-level boundary, matching `settings-shell/SettingsPage.tsx:54`.
 *
 * jsdom cannot see this: it has no chunk loading, so nothing ever suspends and
 * the boundary is never exercised. That is why the fix shipped with human-verify
 * items, and it is what this spec closes.
 *
 * THE SCENARIO IS FIRST MOUNT, NOT A TAB SWITCH — and getting that wrong would
 * have produced a test that passes forever without exercising anything. Measured
 * here, a tab switch does NOT suspend visibly: react-router 7 runs navigations
 * inside `startTransition`, and React deliberately keeps already-visible content
 * rather than replacing it with a fallback. Clicking a second tab with its chunk
 * stalled for 2s left the FIRST tab's content on screen the whole time, with no
 * fallback and no blanking, boundary or not. The boundary earns its keep on
 * FIRST MOUNT, where the pane has no previous content to preserve and React must
 * render a fallback — the only question being which boundary owns it.
 *
 * THE ASSERTION. `.state-card[aria-busy="true"]` is rendered only by a hub's own
 * `<Suspense fallback>`; the shell's fallback is an `aria-hidden` skeleton with
 * no such marker (`ui/Skeleton.tsx:18`). So the test asserts the hub's chrome
 * (header, and tab strip where the hub has one) is present AT THE SAME MOMENT
 * the pane reports busy — read in ONE evaluate() tick so the two facts are true
 * simultaneously rather than in sequence. Without the boundary the busy card
 * never appears and the header is gone, so the test cannot pass by not looking.
 *
 * Module responses are delayed (`armModuleDelay`) to hold that window open. Be
 * accurate about what the delay buys: with `DELAY_MS = 0` all four tests still
 * passed here, because Vite transforms each module on demand and that alone is
 * slower than the assertion. The delay is therefore FLAKE INSURANCE, not a
 * precondition — it keeps the window open on a faster host, a warm module cache,
 * or a future prod-build lane, where a zero-delay run would start losing the
 * race. It is not what makes the test bite.
 *
 * WHAT MAKES IT BITE was measured by sabotage: deleting the `<Suspense>` from
 * `ModelsHubPage` turned the `models` test red on the guard below and left the
 * other three green. A test that cannot fail when you break the thing it tests
 * is worse than no test, so that probe is the reason to trust this one.
 *
 * What this does NOT prove: that the production build splits these panes into
 * separate chunks at all. The lane runs `vite dev` (unbundled ESM). Which
 * boundary catches a suspension is a React tree semantic, not a bundler
 * artifact, so dev is faithful for THIS claim — but if a prod build inlined a
 * pane into the main chunk there would be no suspension in prod and the boundary
 * would be inert rather than wrong. That is a separate question.
 */

/** Wide enough to observe the suspended window without stalling the suite. */
const DELAY_MS = 1_000;

interface Hub {
  id: string;
  path: string;
  /** Toggles that must be on for this hub to project any pane at all. A hub with
   *  zero visible routes renders its empty state and has no boundary to test —
   *  the busy-card assertion below fails loudly rather than passing vacuously. */
  toggles: string[];
}

const HUBS: Hub[] = [
  { id: 'access', path: '/access', toggles: [] },
  { id: 'models', path: '/models', toggles: [] },
  { id: 'chat-deployment', path: '/chat-deployment', toggles: ['chat-deployment'] },
  {
    id: 'campaigns',
    path: '/campaign-studio',
    toggles: ['campaign-brief', 'campaign-orchestration', 'campaign-connectors', 'campaign-intel'],
  },
];

/**
 * NOTE for whoever extends this with a tab CLICK. Target the hub's own
 * `<Tabs idBase>` (`[role="tab"][id^="<idBase>-tab-"]`), never a bare
 * `getByRole('tab')`: the Access hub renders a SECOND tablist for its
 * Workspace/Personal scope pill (`idBase="access-scope"`), so `.nth(1)` there
 * clicks "Personal" and changes scope instead of switching tab — a green test
 * that exercised nothing. (And see the docblock: a tab switch does not suspend
 * visibly in the first place.)
 */

/**
 * Sign in to the caller's OWN PERSONAL workspace — deliberately WITHOUT a
 * tenantId.
 *
 * Three of the four hubs are `tier: 'admin'`, and `chrome/AdminLayout` renders
 * an honest "Administrator access required" card instead of the page unless
 * `isAdminCaller` holds (`client/useEffectiveAccess.ts:59`). An explicit
 * tenantId makes the workspace somebody else's as far as the session is
 * concerned, so `basis` never resolves `tenant-owner` and the hubs render the
 * deny card — no chrome, no pane, nothing to assert.
 *
 * (Shared `login()` requires a tenantId, so this stays local rather than
 * widening a helper eight other specs depend on.)
 */
async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

/**
 * Delay every JS/TS module response so the pane's suspended window is wide
 * enough to observe. Armed BEFORE navigation: the hub page is itself lazy, so
 * the sequence is hub-chunk (delayed) → hub renders chrome → pane-chunk
 * (delayed) → the window this spec measures.
 */
async function armModuleDelay(page: Page): Promise<void> {
  await page.route(/\.(t|j)sx?(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    // A request can still be parked in the delay when the test unroutes or the
    // page navigates away; continuing it then throws "Route is already handled".
    // That is harness teardown, never a product failure, so it must not turn a
    // green assertion red.
    await route.continue().catch(() => undefined);
  });
}

test.describe('hub Suspense boundary (#2724)', () => {
  test.describe.configure({ timeout: 120_000 });

  for (const hub of HUBS) {
    // One test PER HUB, not one test looping four hubs: a loop stops at the first
    // failure and hides the other three, and the sabotage probe needs exactly one
    // hub to go red while the rest stay green.
    test(`${hub.id}: hub chrome renders while its pane is still loading`, async ({ page }) => {
      await loginPersonal(page.request, `hub-suspense-${hub.id}@e2e.test`);
      for (const id of hub.toggles) {
        expect(await enableToggle(page.request, id), `${hub.id}: toggle '${id}' could not be enabled`).toBe(true);
      }

      await armModuleDelay(page);
      await page.goto(hub.path);

      // Wait for the hub's OWN header — proof the hub page itself has mounted and
      // we are past the shell boundary. Until this appears the shell is legitimately
      // showing its skeleton (the hub page is lazy too), which is not what we test.
      await expect(
        page.locator('.page-header'),
        `${hub.id}: the hub page never mounted`,
      ).toBeVisible({ timeout: 60_000 });

      // Both facts in ONE tick, so "chrome present" and "pane suspended" are true
      // SIMULTANEOUSLY rather than sequentially (the pane could otherwise resolve
      // between two awaits and let a broken build slip through).
      const snap = await page.evaluate(() => ({
        suspended: !!document.querySelector('.state-card[aria-busy="true"]'),
        header: !!document.querySelector('.page-header'),
      }));

      // THE GUARD. Only the hub's own <Suspense fallback> renders a busy card; the
      // shell's fallback is an aria-hidden skeleton. If the boundary is missing,
      // the pane's suspension escapes to the shell and this is false.
      expect(
        snap.suspended,
        `${hub.id}: no hub-owned busy card while the pane loaded — either the suspension escaped to the shell boundary, or the pane resolved before the snapshot`,
      ).toBe(true);
      expect(
        snap.header,
        `${hub.id}: the hub header was not on screen while its pane suspended`,
      ).toBe(true);

      // And it recovers: the pane resolves and the chrome is still intact.
      await page.unroute(/\.(t|j)sx?(\?.*)?$/);
      await expect(page.locator('.page-header')).toBeVisible();
    });
  }
});
