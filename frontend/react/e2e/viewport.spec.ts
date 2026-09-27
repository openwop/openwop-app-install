import { test, expect, type APIRequestContext } from '@playwright/test';
import { API, enableToggle } from './support/session.js';

/**
 * No HORIZONTAL OVERFLOW at narrow viewports.
 *
 * WHAT THIS COVERS, AND WHAT IT DOES NOT — read before marking anything "responsive".
 *
 * The lane had ZERO responsive coverage before this (`grep -rln setViewportSize
 * e2e/` returned nothing) against ~31 open viewport items in
 * `docs/steward/UX-ASSESSMENT.md`. This closes ONE property of those items — the
 * only one that is objectively machine-checkable without a human or a pixel
 * baseline: does the page force the document to scroll sideways.
 *
 * It does NOT see clipped text, unreadable type sizes, touch targets that are too
 * small, or a layout that is technically within bounds and still unusable. Those
 * stay human. Do not let one assertion close 31 items — reclassify them
 * individually.
 *
 * WHY DOCUMENT-LEVEL, AND WHY NO ALLOWLIST. `global.css` has 20 `overflow-x: auto`
 * containers (`.table-scroll:1822`, the kanban board at :6700 whose own comment
 * says boards scroll inside their container once they exceed content width, the
 * manifest preview, …). The app already uses the correct pattern: wide content
 * scrolls in ITS OWN container, never the document. So document-level overflow is
 * essentially always a defect here, and this ships with no allowlist. If a route
 * fails, that is a finding to investigate — not an entry to add. An allowlist
 * created before a real case is how a gate quietly becomes decorative.
 *
 * THE POSITIVE CONTROL IS THE HARD PART. `scrollWidth <= clientWidth` is trivially
 * true of a page that rendered almost nothing: a 404, an empty state, a bare
 * skeleton, or the "Administrator access required" card that admin-tier routes
 * show when the session does not resolve owner. That last one is not theoretical —
 * it silently emptied three hub pages while the hub Suspense spec (#2739) was
 * being written, and every assertion below it would have passed on an apology.
 *
 * So each route must prove it laid out REAL CONTENT: `main` visible, AND not one
 * of the known degenerate states, AND a rendered height that clears a floor a
 * deny card cannot. Only then does "no overflow" mean anything.
 */

/** Narrowest widely-supported phone width; the tracker's items say 360/768/1280. */
const NARROW = { width: 360, height: 780 };

/** A deny card / 404 is short. A real page is not. */
const MIN_CONTENT_HEIGHT = 200;

/** Routes that are workspace-tier (no admin gate) so a plain session renders them. */
const ROUTES = ['/dashboard', '/chat', '/runs', '/boards', '/agents', '/inbox'];

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

test.describe('narrow viewport — no horizontal overflow', () => {
  test.describe.configure({ timeout: 90_000 });

  for (const route of ROUTES) {
    test(`${route} @${NARROW.width}px`, async ({ page }) => {
      await page.setViewportSize(NARROW);
      await loginPersonal(page.request, 'viewport@e2e.test');
      await page.goto(route);

      await expect(page.locator('main').first()).toBeVisible({ timeout: 60_000 });

      // Let late content (data fetches, deferred panels) land before measuring —
      // overflow that appears only once rows arrive is exactly the interesting case.
      await page.waitForTimeout(1_500);

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const main = document.querySelector('main');
        const text = main?.textContent ?? '';
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          mainHeight: main?.getBoundingClientRect().height ?? 0,
          notFound: text.includes('Page not found'),
          denied: text.includes('Administrator access required'),
          // A toggle-off feature route renders a short "<Feature> is not enabled"
          // StateCard. It is not a 404 and not the admin deny card, so neither
          // check above sees it — and it can clear MIN_CONTENT_HEIGHT, which
          // would let "no overflow" pass on a page that laid out nothing real.
          notEnabled: /is not enabled/i.test(text),
          // The widest element that actually crosses the viewport edge, so a
          // failure names the culprit instead of just the number.
          widest: (() => {
            let worst = { sel: '', right: 0 };
            for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.right > worst.right) {
                worst = {
                  sel: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`,
                  right: Math.round(r.right),
                };
              }
            }
            return worst;
          })(),
        };
      });

      // POSITIVE CONTROL — prove real content, or the overflow check means nothing.
      expect(m.notFound, `${route}: rendered "Page not found" — the route did not resolve`).toBe(false);
      expect(m.denied, `${route}: rendered the admin deny card — the session did not resolve owner`).toBe(false);
      expect(m.notEnabled, `${route}: rendered the "not enabled" card — the feature toggle is off for this tenant`).toBe(false);
      expect(
        m.mainHeight,
        `${route}: main is only ${Math.round(m.mainHeight)}px tall — too empty for "no overflow" to mean anything`,
      ).toBeGreaterThan(MIN_CONTENT_HEIGHT);

      // THE CLAIM. +1 absorbs sub-pixel rounding, not a real overflow.
      expect(
        m.scrollWidth,
        `${route}: document scrolls sideways at ${NARROW.width}px `
          + `(scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}). `
          + `Widest element reaches x=${m.widest.right}: ${m.widest.sel}. `
          + `Wide content belongs in its own overflow-x container, not the document.`,
      ).toBeLessThanOrEqual(m.clientWidth + 1);
    });
  }
});

/**
 * The DETAIL-route shape — where the overflow actually was.
 *
 * The list routes above are a real gate, but they miss the two page shapes that
 * exist ONLY on a detail surface, and both shipped mobile overflow this week
 * (`CCUX-4` / `CCUX-5`, follow-up to ADR 0519/0522):
 *
 *   1. A header action cluster of FOUR controls (back + delete + publish + save).
 *      `.page-header__actions` was pinned `flex-shrink: 0` — correct at desktop,
 *      where a long title must not squeeze it — and measured 410px in a 360px
 *      viewport, so the DOCUMENT scrolled sideways.
 *   2. A copyable-URL row: a long unbroken URL in a `.u-flex-1 <code>` cannot
 *      shrink below its min-content width, so it ejected the copy button
 *      offscreen.
 *
 * Neither shape is reachable from a list route, so neither was covered. Both were
 * found by hand at 360px; this is the regression gate so the next one is not.
 *
 * The entity is seeded through the REAL create path (POST, then PATCH status),
 * not a fixture — a detail page that only renders for hand-built state proves
 * nothing about the page users reach. Every setup step is asserted so a failure
 * names the setup instead of surfacing later as a confusing overflow miss.
 */
test.describe('narrow viewport — detail routes', () => {
  test.describe.configure({ timeout: 90_000 });

  test(`/forms/:formId @${NARROW.width}px`, async ({ page }) => {
    await page.setViewportSize(NARROW);
    await loginPersonal(page.request, 'viewport-detail@e2e.test');

    // The route 404s behind the toggle; skip rather than fail if this build does
    // not ship the feature at all (the helper's documented contract).
    const on = await enableToggle(page.request, 'forms');
    test.skip(!on, 'forms toggle unknown in this build');

    const orgs = await page.request.get(`${API}/orgs`);
    expect(orgs.status(), `orgs: ${await orgs.text()}`).toBe(200);
    const orgsBody = (await orgs.json()) as { orgs?: { orgId?: string }[] };
    const orgId = orgsBody.orgs?.[0]?.orgId;
    // A throw rather than `expect(...).toBeTruthy()`: the expect asserts but does
    // NOT narrow the type, and a non-null assertion would trade a compile error
    // for a runtime one. This keeps the same diagnostic and narrows honestly.
    if (!orgId) throw new Error(`no org for this session — cannot reach an org-scoped detail route (got ${JSON.stringify(orgsBody).slice(0, 200)})`);

    const created = await page.request.post(`${API}/forms/orgs/${orgId}/forms`, {
      data: {
        // A long title is part of the fixture, not decoration: it is what pushes
        // the header cluster toward the viewport edge.
        title: 'Wholesale partner onboarding and compliance intake',
        fields: [
          { key: 'name', label: 'Name', type: 'text', required: true },
          { key: 'email', label: 'Email', type: 'email', required: true },
        ],
        createToContact: true,
      },
    });
    expect(created.status(), `create form: ${await created.text()}`).toBe(201);
    const formId = ((await created.json()) as { formId?: string }).formId;
    if (!formId) throw new Error('create returned 201 without a formId');

    // PUBLISHED so the page renders the copyable hosted/public URL rows — a draft
    // hides them, and they are half of what this test exists to cover.
    const pub = await page.request.patch(`${API}/forms/orgs/${orgId}/forms/${formId}/status`, {
      data: { status: 'published' },
    });
    expect(pub.status(), `publish: ${await pub.text()}`).toBe(200);

    await page.goto(`/forms/${encodeURIComponent(formId)}?org=${encodeURIComponent(orgId)}`);
    await expect(page.locator('main').first()).toBeVisible({ timeout: 60_000 });
    // A DETERMINISTIC wait, not a fixed sleep: this test knows exactly what must
    // be on screen before measuring — the action cluster and a URL row are the
    // two shapes under test. Waiting for them removes the "was 1.5s enough on a
    // loaded CI box?" flake vector that a `waitForTimeout` leaves behind, and it
    // fails with a useful message if they never arrive.
    await expect(page.locator('.page-header__actions > *').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('code').first()).toBeVisible({ timeout: 30_000 });

    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const main = document.querySelector('main');
      const text = main?.textContent ?? '';
      let worst = { sel: '', right: 0 };
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > worst.right) {
          worst = {
            sel: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`,
            right: Math.round(r.right),
          };
        }
      }
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        mainHeight: main?.getBoundingClientRect().height ?? 0,
        // The detail page's own degenerate state: a stale or foreign id renders
        // "Form not found" instead of the builder, and every assertion below
        // would pass on it.
        notFound: /not found/i.test(text),
        headerActions: document.querySelectorAll('.page-header__actions > *').length,
        // The OTHER shape under test: the published form's copyable URL rows.
        // Asserted separately from the publish call because a 200 from the API
        // does not prove the block RENDERED — and if it ever moves behind another
        // condition, this test would silently stop covering half its claim.
        urlRows: document.querySelectorAll('code').length,
        worst,
      };
    });

    // POSITIVE CONTROL — prove the BUILDER rendered, and that the header really
    // is carrying the multi-control cluster this test exists to hold.
    expect(m.notFound, 'rendered a not-found state — the seeded form did not resolve').toBe(false);
    expect(m.mainHeight, `main is only ${Math.round(m.mainHeight)}px tall — too empty to measure`).toBeGreaterThan(MIN_CONTENT_HEIGHT);
    expect(
      m.headerActions,
      'the header action cluster is missing — an empty cluster would be a false pass',
    ).toBeGreaterThanOrEqual(3);
    expect(
      m.urlRows,
      'no <code> URL row rendered — the published-form URL block is the second shape '
        + 'this test covers, and without it that half is a false pass',
    ).toBeGreaterThanOrEqual(1);

    expect(
      m.scrollWidth,
      `/forms/:formId scrolls sideways at ${NARROW.width}px `
        + `(scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}). `
        + `Widest element reaches x=${m.worst.right}: ${m.worst.sel}.`,
    ).toBeLessThanOrEqual(m.clientWidth + 1);
  });
});

/**
 * ADR 0139 adaptive-navigation correction — the ≤860px quick-access bar must
 * remain separate from the demo-host banner and the app body must reserve its
 * height. This supersedes the old floating-launcher overlap regression gate.
 *
 * Runs ANONYMOUSLY on purpose: the banner only renders for signed-out visitors
 * on a host with in-memory storage surfaces (this e2e backend is memory://).
 * If the banner ever stops rendering here, the visibility expect fails rather
 * than the test passing vacuously.
 */
test.describe('mobile chat — quick access never covers the session banner', () => {
  test.describe.configure({ timeout: 90_000 });

  for (const width of [320, 360, 390, 430]) {
    test(`/chat @${width}px`, async ({ page, context }) => {
      await context.clearCookies(); // anonymous — the banner is signed-out chrome
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/chat');

      const banner = page.locator('.demo-host-banner');
      const quickAccess = page.getByRole('navigation', { name: 'Workspace quick access' });
      await expect(banner, 'banner missing — the anonymous in-memory disclosure should render here').toBeVisible({ timeout: 60_000 });
      await expect(quickAccess, 'quick access missing — ≤860px must show persistent workspace navigation').toBeVisible();
      await expect(quickAccess.getByRole('button', { name: 'More' })).toBeVisible();

      const rects = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
        const body = document.querySelector('.app-body');
        return {
          quickAccess: r('.app-mobile-nav'),
          banner: r('.demo-host-banner'),
          bodyPaddingBottom: body ? Number.parseFloat(getComputedStyle(body).paddingBottom) : 0,
        };
      });
      expect(rects.quickAccess).not.toBeNull();
      expect(rects.banner).not.toBeNull();
      expect(
        (rects.quickAccess?.top ?? 0) >= (rects.banner?.bottom ?? Number.POSITIVE_INFINITY),
        `@${width}px: quick access overlaps the banner (${JSON.stringify(rects)})`,
      ).toBe(true);
      expect(rects.bodyPaddingBottom).toBeGreaterThanOrEqual(rects.quickAccess?.height ?? 64);
    });
  }
});

/**
 * DSA-026 (ADR 0510 Phase 7) — ≤860px the admin rail is a compact disclosure,
 * never a wrapping link cloud. The row names the current destination; sections
 * expand on demand and close on navigation.
 */
test.describe('mobile admin — compact disclosure, not a link cloud', () => {
  test.describe.configure({ timeout: 90_000 });

  test('/orgs @390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginPersonal(page.request, 'admin-nav@e2e.test');
    await page.goto('/orgs');
    await expect(page.locator('main').first()).toBeVisible({ timeout: 60_000 });

    const toggle = page.locator('.admin-rail-mobile-toggle');
    const nav = page.locator('#admin-rail-nav');
    await expect(toggle).toBeVisible();
    await expect(nav).toBeHidden(); // collapsed by default — no cloud
    await expect(toggle).toContainText(/\S/); // labeled, never an icon-only mystery button

    await toggle.click();
    await expect(nav).toBeVisible();
    // Navigate somewhere else via the disclosed nav — it must close again.
    await nav.locator('a').first().click();
    await expect(nav).toBeHidden();
  });
});
