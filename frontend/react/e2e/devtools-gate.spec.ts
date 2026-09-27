import { test, expect, type APIRequestContext } from '@playwright/test';
import { API } from './support/session.js';

/**
 * The `developer-tools` gate actually gates (ADR 0196 Gate B) — BOTH polarities.
 *
 * WHY THIS IS ONE TEST AND NOT THREE. `CT-2` (network inspector), `CT-3` (per-turn
 * envelope inspector) and `CT-5` (manual-test runner nav) read as three separate
 * "confirm X is not visible" items in the tracker. They are not three leaks: they
 * are ONE gate. `features/developer-tools/feature.ts:24` owns all three —
 * "Engineering surfaces: the network inspector, the per-turn envelope (wire-shape)
 * inspector, and the manual-test runner. OFF for a clean install; the public demo
 * defaults ON." Every consumer reads the same `useFeatureAccess('developer-tools')`
 * (`chrome/Sidebar.tsx:34`, `chat/MessageBubble.tsx:302`,
 * `features/manual-tests/routes.tsx:23`). Testing it three times would imply three
 * independent guarantees that do not exist.
 *
 * WHY BOTH POLARITIES — this is the whole point, not thoroughness theatre.
 *
 * An absence assertion is the easiest test in the world to pass by accident.
 * `toHaveCount(0)` is satisfied when the page 404s, when the session is anonymous,
 * when an unrelated toggle hid the surface, when the app crashed — and, worst,
 * when the SELECTOR IS SIMPLY WRONG. A typo'd selector passes forever and reports
 * a guarantee nobody has.
 *
 * Asserting a positive control (a header rendered) is not enough: it proves *a*
 * page rendered, never that the forbidden selector was capable of matching
 * anything. So the ON case asserts the SAME selectors the OFF case denies. A
 * wrong selector fails ON. A dead route fails ON. A broken session fails ON. Only
 * a genuinely-gated surface passes both.
 *
 * That is also the sabotage proof for an absence family, and it is cheaper than
 * hand-reintroducing each leak: it re-proves the selectors on every run instead of
 * once at authoring time.
 *
 * DELIBERATELY NOT COVERED HERE:
 *   - `CT-3` (envelope inspector) needs a real assistant turn — a live model call
 *     — so it is out of reach of this lane. Same gate, so the gate itself is
 *     covered; the specific surface is not.
 *   - `CT-1`, `CT-6`, `CT-7` are demo-mode CONTENT, which ADR 0196 governs
 *     SEPARATELY from this toggle. The lane boots `OPENWOP_DEMO_MODE=true`
 *     (`scripts/ci.sh:106`), so in this posture those surfaces are legitimately
 *     present and asserting their absence would test the wrong configuration.
 *   - `CT-9`/`CT-10` forbid internal identifiers (`secretResolver.ts`,
 *     `spec/v1/*.md`). A literal string in the shipped bundle is a static-grep
 *     question; a browser would cost more and cover less, since it only sees the
 *     routes it happens to visit.
 */

/** Set a toggle to an explicit status. The shared `enableToggle` helper only ever
 *  turns things ON, and this spec needs OFF as a first-class state. */
async function setToggle(ctx: APIRequestContext, id: string, status: 'on' | 'off'): Promise<void> {
  const get = await ctx.get(`${API}/feature-toggles/admin/configs/${encodeURIComponent(id)}`);
  expect(get.ok(), `read toggle '${id}': ${get.status()}`).toBe(true);
  const config = (await get.json()) as Record<string, unknown>;
  const put = await ctx.put(`${API}/feature-toggles/admin/configs/${encodeURIComponent(id)}`, {
    data: { ...config, id, status },
  });
  expect(put.ok(), `set toggle '${id}' → ${status}: ${put.status()}`).toBe(true);
}

/**
 * Sign in to the caller's OWN personal workspace (no tenantId). The toggle admin
 * routes need an owner; an explicit tenantId makes the workspace somebody else's,
 * so `basis` never resolves `tenant-owner` and the writes 403.
 */
async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

/** The engineering surfaces this gate owns, by the most stable handle each has. */
const NETWORK_BUTTON = '.app-sidebar-net';              // chrome/Sidebar.tsx:230

/**
 * The manual-test runner is asserted at its ROUTE, not by its nav link, and that
 * is deliberate. `features/manual-tests/routes.tsx:23` hides the nav entry via
 * `nav.featureId`, but the route STAYS MOUNTED and deep-linkable — so a nav-only
 * assertion would pass while `/manual-tests` still served the runner to anyone
 * who typed the URL. `ManualTestsPage.tsx:51` gates the page itself; that is the
 * behaviour worth pinning.
 *
 * (The nav link also never appears on `/dashboard` at all: manual-tests is
 * admin-tier, so its entry lives in the admin rail, not the workspace sidebar.
 * Asserting its absence there would have been true for the wrong reason.)
 */
const MANUAL_TESTS_ROUTE = '/test';

test.describe('developer-tools gate (ADR 0196 Gate B)', () => {
  // SERIAL, and this is load-bearing. `feature-toggles/admin/configs/<id>` is
  // SHARED configuration, not per-test state: run the two polarities in parallel
  // and each overwrites the other's write, so the page under assertion sees
  // whichever landed last. Measured — the same two tests reported opposite
  // results on consecutive `--workers=2` runs before this line existed. A
  // separate tenant per test does NOT isolate it, because the config is not
  // tenant-scoped.
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  /**
   * RESTORE THE SHARED ROW. This spec writes a toggle that is global, not
   * tenant-scoped, and the serial order ends on OFF — so without this the lane
   * leaves `developer-tools` DISABLED for whatever backend it ran against.
   * Harmless in CI (`OPENWOP_STORAGE_DSN=memory://`, it evaporates), but a
   * developer running the lane against their own persistent backend silently
   * loses the network inspector and the manual-test runner afterwards, with
   * nothing to connect the cause to the effect.
   *
   * Best-effort: a failed restore must not turn a passing suite red, so it
   * warns rather than throws.
   */
  let priorStatus: string | undefined;
  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${API}/feature-toggles/admin/configs/developer-tools`);
    if (res.ok()) priorStatus = ((await res.json()) as { status?: string }).status;
  });
  test.afterAll(async ({ request }) => {
    if (!priorStatus) return;
    const get = await request.get(`${API}/feature-toggles/admin/configs/developer-tools`);
    if (!get.ok()) return;
    const config = (await get.json()) as Record<string, unknown>;
    const put = await request.put(`${API}/feature-toggles/admin/configs/developer-tools`, {
      data: { ...config, id: 'developer-tools', status: priorStatus },
    });
    if (!put.ok()) console.warn(`[devtools-gate] could not restore developer-tools to '${priorStatus}'`);
  });
  for (const { status, label } of [
    { status: 'on' as const, label: 'ON — the surfaces are present (positive control for these selectors)' },
    { status: 'off' as const, label: 'OFF — the surfaces are gone (a clean install shows no engineering UI)' },
  ]) {
    test(`developer-tools ${label}`, async ({ page }) => {
      await loginPersonal(page.request, `devtools-${status}@e2e.test`);
      await setToggle(page.request, 'developer-tools', status);

      await page.goto('/dashboard');

      // Positive control for the PAGE: the sidebar footer exists in both states,
      // so a blank page or a dead session fails here rather than sliding past the
      // absence assertion below.
      await expect(
        page.locator('.app-sidebar-foot'),
        'the app shell never rendered — nothing below this can mean anything',
      ).toBeVisible({ timeout: 60_000 });

      const net = page.locator(NETWORK_BUTTON);
      if (status === 'on') {
        await expect(net, 'network inspector button missing while developer-tools is ON').toHaveCount(1);
      } else {
        await expect(net, 'network inspector button LEAKED while developer-tools is OFF').toHaveCount(0);
      }

      // The DEEP LINK, which is the path a nav-only gate would leak.
      //
      // The DEEP LINK — the path a nav-only gate would leak. The route stays
      // mounted either way (`ManualTestsPage.tsx:47`); the PAGE gates itself, so
      // this asserts the page's state, not the route's existence.
      //
      // Matched on the denied card's own title rather than `.state-card__title`:
      // that class matches ANY StateCard, and the ENABLED runner renders cards of
      // its own, so the broad selector reported "still gated" on a page that had
      // loaded fine. Copy-coupled and so i18n-fragile — acceptable only because
      // the lane runs English and the string is distinctive; if it fails after a
      // rewording, that is this line's fault, not a leak.
      await page.goto(MANUAL_TESTS_ROUTE);
      const denied = page.getByText('Developer tools are off', { exact: false });
      if (status === 'on') {
        await expect(
          denied,
          'manual-test runner refused to load while developer-tools is ON — the gate is stuck closed',
        ).toHaveCount(0);
      } else {
        await expect(
          denied,
          'manual-test runner served itself on a DEEP LINK while developer-tools is OFF',
        ).toHaveCount(1);
      }

      // CROSS-FILE RACE GUARD. `mode: 'serial'` orders the tests INSIDE this file,
      // but Playwright parallelises across FILES and the toggle config is NOT
      // tenant-scoped — it is one shared row. `feature-routes.spec.ts:25` enables
      // whatever toggles the manual-test catalog names, so the day a suite is
      // added for a `developer-tools`-gated feature, it will flip this out from
      // under the assertions above.
      //
      // No suite does today (checked: zero `developer-tools` hits in `suites.ts`),
      // so this cannot fire yet. It exists so that when it does, the failure says
      // WHY instead of looking like the gate broke.
      const after = await page.request.get(`${API}/feature-toggles/admin/configs/developer-tools`);
      const stillSet = ((await after.json()) as { status?: string }).status;
      expect(
        stillSet,
        `another spec changed the shared 'developer-tools' toggle mid-test (expected '${status}', found '${stillSet}') — this is cross-file interference, not a gate failure`,
      ).toBe(status);
    });
  }
});
