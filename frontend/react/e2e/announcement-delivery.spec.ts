/**
 * Announcement DELIVERY — the half `live-region.spec.ts` cannot reach.
 *
 * That spec proves the live regions are correctly SHAPED: they pre-exist their
 * messages, sit in the accessibility tree, and survive navigation. It proves
 * nothing about whether any real call site ever PUTS TEXT IN ONE. A correctly
 * shaped region that nothing writes to is silent in exactly the same way as a
 * broken one — the defect shipped in #2615, #2616 and #2620.
 *
 * The case is chosen for consequence, not convenience: a Copy button on `/cli`,
 * whose entire purpose is handing out shell commands, with `navigator.clipboard`
 * forced UNAVAILABLE. That is the genuine non-secure-context path (plain HTTP,
 * some embedded webviews) where optional chaining used to short-circuit the whole
 * promise chain so NEITHER handler ran: no toast, no error, no throw. The user
 * pressed Copy, nothing happened, and pasted something stale believing otherwise
 * (#2726).
 *
 * WHY THIS LIVES IN THE ROUTES LANE. `/cli` is admin-tier; the default e2e
 * session renders "Administrator access required". This lane boots a backend
 * with the test seams and authenticates as `admin@e2e.test`, exactly as
 * `feature-routes.spec.ts` does.
 *
 * WHAT IT STILL CANNOT PROVE: what a screen reader SAYS. It asserts the message
 * lands in the shell's ASSERTIVE live region — mounted empty, then written to —
 * which is the content-change path the ARIA spec defines announcement by.
 * Announcement happens inside the AT process; `VERIFY-6` stays open for that
 * residue.
 *
 * CORRECTED 2026-09-25. This spec used to assert the failure text inside a
 * `role="alert"` node IN THE TOAST REGION. PROF-UX-20 (f2862cdd6, 2026-09-02)
 * deliberately removed that role: alert-on-insertion is a SHOULD the app had
 * never verified, and it duplicated the explicit `announce()` every toast already
 * makes (DS-8, spoken twice). Errors now go ONLY to the primed assertive shell
 * region. The spec kept asserting the retired mechanism and went red that day,
 * unseen, because this lane is opt-in (`OPENWOP_CI_E2E_ROUTES=1`). It now asserts
 * the mechanism the product uses — and pins the retired one as ABSENT, so the two
 * cannot both come back.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { login, API } from './support/session.js';

// SERIAL. These blocks share one backend and one seeded tenant, and running them
// in parallel workers made results rotate run to run — copy passed then failed,
// payout passed/failed/passed. Nothing about the PRODUCT changed between those
// runs; the lane's concurrency did. Serialising costs seconds and removes a
// class of false signal that is worse than the time.
test.describe.configure({ mode: 'serial' });

const ENABLED = process.env.OPENWOP_E2E_ROUTES === '1';
// The ADMIN-TIER pages (`/cli`, the payout console) only grant admin on the
// SEEDED tenant, so they must stay on it — a per-describe tenant produced a deny
// card and "button not found". I tried that and it broke both. Only the
// org-picker block, which WRITES, gets its own tenant.
const TENANT = 'e2e-routes';

/** Replace `navigator.clipboard` before any app code runs. */
const stubClipboard = (value: 'unavailable' | 'working') => `(() => {
  const v = ${JSON.stringify(value)};
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: v === 'unavailable' ? undefined : { writeText: async () => undefined },
  });
})()`;

test.describe('an action DELIVERS its announcement, not just its pixels', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_ROUTES=1 + a backend with the test seams (see e2e/support/session.ts).');
  test.describe.configure({ timeout: 60_000 });

  let ctx: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return;
    ctx = await browser.newContext();
    await login(ctx.request, 'admin@e2e.test', TENANT);
  });
  test.afterAll(async () => { await ctx?.close(); });

  test('a failed copy reaches an ALERT region, not only the screen', async () => {
    const page = await ctx.newPage();
    try {
      await page.addInitScript(stubClipboard('unavailable'));
      await page.goto('/cli');

      const copy = page.getByRole('button', { name: /copy install command/i });
      await expect(copy).toBeVisible();
      await copy.click();

      // Visible to sighted users — the toast renders the failure copy.
      const toasts = page.getByRole('region', { name: /notifications/i });
      await expect(toasts).toContainText(/couldn.t copy/i);

      // The assertion that matters: the failure is WRITTEN INTO the shell's
      // assertive region, which pre-exists it (live-region.spec.ts proves that
      // precondition). A styled toast alone would look identical on screen and
      // say nothing. Targeted by `data-owp-live` because the app has dozens of
      // live nodes and a role query would pick an arbitrary one.
      await expect(page.locator('[data-owp-live="assertive"]')).toContainText(/couldn.t copy/i);

      // ...and ONLY there. A `role="alert"` on the toast itself would be a second
      // region for the same message — spoken twice (DS-8), the shape PROF-UX-20
      // removed. Pinning its absence keeps the two mechanisms exclusive.
      await expect(toasts.getByRole('alert')).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test('a WORKING copy does not claim failure', async () => {
    // The other polarity, and not optional: without it the test above passes
    // against a build that announces "couldn't copy" unconditionally. An
    // assertion about a failure state is vacuous until something proves the
    // success state differs.
    const page = await ctx.newPage();
    try {
      await page.addInitScript(stubClipboard('working'));
      await page.goto('/cli');

      // Prove the surface actually rendered and the control is real BEFORE
      // asserting an absence — otherwise a deny card or a renamed button makes
      // this pass while testing nothing.
      const copy = page.getByRole('button', { name: /copy install command/i });
      await expect(copy).toBeVisible();
      await copy.click();

      await expect(page.getByText(/couldn.t copy/i)).toHaveCount(0);
      // Not announced either: the shell region must not carry the failure copy.
      await expect(page.locator('[data-owp-live="assertive"]')).not.toContainText(/couldn.t copy/i);
    } finally {
      await page.close();
    }
  });
});

/**
 * A FAILED READ must reach assistive tech too — and this one carries money.
 *
 * `AdminCommercePage` is the payout RECONCILIATION console. Its own source says
 * why the stakes differ from a normal empty state: "on a reconciliation console,
 * 'no payout runs' is a financial claim. An unread ledger must never make it."
 * The author reasoned that through for the VISIBLE copy; the announcement was
 * simply absent until #2848, and the ratchet — not a human sweep — found it,
 * because the gate is COMPOUND (`policyFailed || runsFailed`) and my hand-written
 * grep only matched the single-flag shape.
 *
 * Unlike the copy toast, a `warning` Notice with `announce` does NOT render its
 * own live region — it delegates to the shell's POLITE region and drops its own
 * role, so that one message never occupies two regions (the DS-8 double-announce).
 * So the assertion targets `[data-owp-live="polite"]` directly: that is where the
 * text has to land for anyone to hear it.
 */
test.describe('a failed READ announces, on a surface where silence costs money', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_ROUTES=1 + a backend with the test seams.');
  test.describe.configure({ timeout: 60_000 });

  let ctx2: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return;
    ctx2 = await browser.newContext();
    await login(ctx2.request, 'admin@e2e.test', TENANT);
  });
  test.afterAll(async () => { await ctx2?.close(); });

  test('an unread payout ledger reaches the polite live region', async () => {
    const page = await ctx2.newPage();
    try {
      // Fail BOTH reads the disclosure watches. `Promise.allSettled` means each
      // rejects independently, which is exactly why the gate is compound.
      await page.route('**/kicktodo/entitlements/share-policy', (r) => r.fulfill({ status: 500, body: '{}' }));
      await page.route('**/kicktodo/entitlements/payout-runs', (r) => r.fulfill({ status: 500, body: '{}' }));

      await page.goto('/admin/kicktodo/commerce');

      // Visible to sighted users…
      const notice = page.getByText(/payout|ledger|could not|unavailable/i).first();
      await expect(notice).toBeVisible();

      // …AND delivered to the shell's polite region. Without the second half a
      // sighted user sees "we could not read the ledger" and a screen-reader
      // user sees a page that looks complete.
      await expect(page.locator('[data-owp-live="polite"]').first()).not.toBeEmpty();
    } finally {
      await page.close();
    }
  });
});

/**
 * AMBIGUITY MUST BE ASKED, NOT GUESSED — the canvas org picker (#2718).
 *
 * The canvas API is org-scoped (`/orgs/:orgId/canvases/:canvasId`) but the app
 * route carries only `:canvasId`, and `CanvasRecord` has no `orgId`. The link is
 * LOSSY. Every canvas surface used to paper over that with `orgs[0]?.orgId`: for
 * a member of ONE org that is right by accident, and for a member of several it
 * opened the wrong workspace and the canvas they actually clicked came back as a
 * generic load error. They could not reach it at all.
 *
 * This is the case a unit test cannot reach and a single-org fixture hides —
 * which is exactly why the defect survived: `orgs[0]` is correct for every
 * developer with one workspace, and for every test with one seeded org.
 *
 * No canvas needs to exist. `resolveCanvasOrg` runs BEFORE any fetch, so the
 * ambiguous branch renders the picker without ever asking the API — and that
 * ordering is itself the property under test: it must ASK before it reads, not
 * read wrongly and report a failure.
 */
test.describe('a lossy canvas link asks which workspace, instead of guessing', () => {
  test.skip(!ENABLED, 'Set OPENWOP_E2E_ROUTES=1 + a backend with the test seams.');
  test.describe.configure({ timeout: 60_000 });

  let ctx3: BrowserContext;
  const SECOND_ORG = 'Beta workspace';
  // ITS OWN TENANT. This block is the only one that MUTATES fixture state, and
  // creating an org in the shared `e2e-routes` tenant leaked both ways on the
  // first run: the picker found two "Beta workspace" buttons, and the payout
  // test — which had passed — started failing because the console's org state
  // had changed underneath it. A test that writes must not share a tenant with
  // tests that read.
  const ORG_TENANT = 'e2e-orgpicker';

  test.beforeAll(async ({ browser }) => {
    if (!ENABLED) return;
    ctx3 = await browser.newContext();
    await login(ctx3.request, 'admin@e2e.test', ORG_TENANT);
    // A SECOND org is the whole precondition. With one org `resolveCanvasOrg`
    // legitimately returns it and no picker should appear — so a single-org
    // fixture would let this pass against the old `orgs[0]` guess.
    // IDEMPOTENT: `beforeAll` runs once PER WORKER, and Playwright spreads this
    // block's tests across workers, so a bare POST created the org twice and
    // strict mode found two identically-named buttons. The API is not
    // idempotent; the setup has to be. (Tenant isolation alone did not fix this
    // — that was a second, separate bug.)
    const existing = await ctx3.request.get(`${API}/orgs`);
    expect(existing.ok(), `list orgs: ${await existing.text()}`).toBeTruthy();
    const orgs = ((await existing.json()) as { orgs?: Array<{ name?: string }> }).orgs ?? [];
    if (!orgs.some((o) => o.name === SECOND_ORG)) {
      const res = await ctx3.request.post(`${API}/orgs`, { data: { name: SECOND_ORG } });
      expect(res.ok(), `create second org: ${await res.text()}`).toBeTruthy();
    }
  });
  test.afterAll(async () => { await ctx3?.close(); });

  test('renders the picker when the link names no org and several are possible', async () => {
    const page = await ctx3.newPage();
    try {
      // Deliberately NO `?org=` — the shape an older link or a bookmark has.
      await page.goto('/app-builder/any-canvas-id');

      // It asks. The second org's name proves the choice is real rather than a
      // single-option formality.
      await expect(page.getByRole('button', { name: SECOND_ORG })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('choosing a workspace puts it on the URL, so the next read is scoped', async () => {
    const page = await ctx3.newPage();
    try {
      await page.goto('/app-builder/any-canvas-id');
      await page.getByRole('button', { name: SECOND_ORG }).click();
      // `?org=` is the whole mechanism — it is what makes the link non-lossy for
      // every subsequent read, and what `DocumentsPage` now emits on canvas links.
      await expect(page).toHaveURL(/[?&]org=/);
    } finally {
      await page.close();
    }
  });
});
