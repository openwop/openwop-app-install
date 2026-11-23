import { test, expect, type APIRequestContext, type APIResponse, type Locator } from '@playwright/test';
import { API } from './support/session.js';

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
 *
 * Sabotage-witnessed (wave 53): the ≤640px release of `.page-header__actions`'
 * `flex-shrink: 0` pin reverted (forms detail red); the ≤860px `.app-body`
 * bottom padding removed (all four mobile-chat cases red); the admin rail no
 * longer closing on navigation (/orgs red). List-route witness under re-probe:
 * the ≤720px single-column `.dash-grid` reverted to two fixed-min columns
 * (w53g3-vp-dash-grid-r2); an unbroken lede string was NOT one (the page wraps it).
 */

/** Narrowest widely-supported phone width; the tracker's items say 360/768/1280. */
const NARROW = { width: 360, height: 780 };

/** A deny card / 404 is short. A real page is not. */
const MIN_CONTENT_HEIGHT = 200;

/** Routes that are workspace-tier (no admin gate) so a plain session renders them. */
const ROUTES = ['/dashboard', '/chat', '/runs', '/boards', '/agents', '/inbox'];

async function loginPersonal(ctx: APIRequestContext, email: string): Promise<string> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
  const tenantId = ((await res.json()) as { user?: { tenantId?: string } }).user?.tenantId;
  if (!tenantId) throw new Error(`login ${email} returned no tenant`);
  return tenantId;
}

/**
 * Turn a toggle on for THIS test's own tenant only (README trap 4; the
 * pair-canvas.spec.ts pattern). The forms case used to write the GLOBAL `forms`
 * row and never restore it, and to `test.skip` silently if the write failed.
 * Returns the undo for `finally`.
 */
type ToggleConfig = Record<string, unknown> & { tenantOverrides?: Record<string, unknown> };
async function pinTenantToggle(ctx: APIRequestContext, id: string, tenantId: string): Promise<() => Promise<void>> {
  const url = `${API}/feature-toggles/admin/configs/${encodeURIComponent(id)}`;
  const write = async (status: 'on' | null): Promise<void> => {
    // The config is ONE global row holding every tenant's override, and the PUT is
    // compare-and-swap. Two workers pinning the same toggle for different tenants
    // race, and the loser gets a 409. Read again and re-apply: only this tenant's
    // key changes, so the retry cannot undo the other worker's write.
    const attempt = async (): Promise<APIResponse> => {
      const get = await ctx.get(url);
      expect(get.status(), `read toggle ${id}: ${await get.text()}`).toBe(200);
      const config = (await get.json()) as ToggleConfig;
      const overrides = { ...(config.tenantOverrides ?? {}) };
      if (status) overrides[tenantId] = { status };
      else delete overrides[tenantId];
      return ctx.put(url, { data: { ...config, id, tenantOverrides: overrides } });
    };
    let put = await attempt();
    for (let retry = 0; retry < 5 && put.status() === 409; retry += 1) put = await attempt();
    expect(put.status(), `${status ? 'pin' : 'unpin'} ${id} for ${tenantId}: ${await put.text()}`).toBe(200);
    const saved = (await put.json()) as ToggleConfig;
    if (status) expect(saved.tenantOverrides?.[tenantId]).toMatchObject({ status });
    else expect(saved.tenantOverrides?.[tenantId]).toBeUndefined();
  };
  await write('on');
  return () => write(null);
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
      // overflow that appears only once rows arrive is exactly the interesting
      // case. Waited on SIGNALS (no loading placeholder left IN THE VIEWPORT,
      // then two animation frames), not a fixed 1.5 s sleep. In-viewport only:
      // /dashboard's below-the-fold tiles are `LazyMount`ed and keep their
      // skeleton until scrolled to (ADR 0844) — a whole-page wait never settles
      // there (measured, wave 53), and the old sleep never mounted them either.
      await page.waitForFunction(() => !Array.from(document.querySelectorAll(
        'main .skeleton, main .skeleton-rows, main [aria-busy="true"], main .inline-state--loading',
      )).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
      }), null, { timeout: 30_000 });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

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
          // E2E-ORDER-1 — what ACTUALLY crosses the edge. `widest` skips zero-size
          // boxes, and a gate failure read "widest element reaches x=360" with
          // scrollWidth 401: the culprit was something it cannot see. List every
          // element whose box (zero-size included) ends past the viewport, deepest
          // first, with its geometry and position, so the next red names it.
          offenders: (() => {
            const vw = document.documentElement.clientWidth;
            const out: Array<{ sel: string; right: number; w: number; h: number; pos: string; text: string }> = [];
            for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
              const r = el.getBoundingClientRect();
              if (r.right <= vw + 1) continue;
              if (Array.from(el.children).some((c) => c.getBoundingClientRect().right > vw + 1)) continue;
              const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
              out.push({
                sel: `${el.tagName.toLowerCase()}${cls}`,
                right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height),
                pos: getComputedStyle(el).position,
                text: (el.textContent ?? '').trim().slice(0, 40),
              });
              if (out.length >= 5) break;
            }
            return out;
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
          + `Past the edge: ${m.offenders.map((o) => `${o.sel} [right ${o.right}, ${o.w}x${o.h}, ${o.pos}] "${o.text}"`).join(' | ') || 'none'}. `
          + `Wide content belongs in its own overflow-x container, not the document.`,
      ).toBeLessThanOrEqual(m.clientWidth + 1);
    });
  }
});

/**
 * The public header with a CMS nav CTA (`nav.cta`, PublicShell.tsx). A long CTA
 * label made the header wider than a 360px phone: the actions box was sized to its
 * content, so the CTA's `white-space: normal` never got a narrower box to wrap in.
 * MEASURED on app.openwop.dev with this label injected: scrollWidth 368; a
 * white-label (CasaVoga, longer brand) shipped it at 375.
 *
 * The CTA is injected into the real rendered header rather than seeded as a CMS
 * page: what is under test is the header's CSS at 360px, and the CMS nav path has
 * its own tests. The positive control asserts the CTA is in the header, visible,
 * and wider than the bare menu, so an injection that silently missed cannot pass.
 */
test.describe('narrow viewport — public header with a long CTA', () => {
  test.describe.configure({ timeout: 90_000 });

  // 360px is the narrowest widely-supported phone; 375px is the width the white-label
  // (CasaVoga) measured the overflow at (PHONE-2).
  for (const width of [NARROW.width, 375]) {
    test(`/ public header CTA @${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: NARROW.height });
      await page.goto('/');
      const actions = page.locator('.public-shell:not(.site-shell) .public-shell-actions').first();
      await expect(actions).toBeVisible({ timeout: 60_000 });

      const m = await page.evaluate((label) => {
        const host = document.querySelector('.public-shell:not(.site-shell) .public-shell-actions');
        if (!host) return null;
        const a = document.createElement('a');
        a.className = 'btn public-shell-cta';
        a.href = '#';
        a.textContent = label;
        host.append(a);
        const r = a.getBoundingClientRect();
        const doc = document.documentElement;
        return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, ctaWidth: r.width, ctaRight: r.right, ctaVisible: r.width > 0 && r.height > 0 };
      }, 'Book a free consultation with our team');

      if (!m) throw new Error('no public-shell header actions on / — the page under test did not render');
      expect(m.ctaVisible, 'the injected CTA must render (positive control)').toBe(true);
      expect(m.ctaWidth, 'the CTA must take real width, not collapse').toBeGreaterThan(60);
      expect(m.ctaRight, 'the CTA must end inside the viewport').toBeLessThanOrEqual(m.clientWidth);
      expect(m.scrollWidth, `the page scrolls sideways (scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth})`).toBeLessThanOrEqual(m.clientWidth);
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
    const tenantId = await loginPersonal(page.request, 'viewport-detail@e2e.test');

    const orgs = await page.request.get(`${API}/orgs`);
    expect(orgs.status(), `orgs: ${await orgs.text()}`).toBe(200);
    const orgsBody = (await orgs.json()) as { orgs?: { orgId?: string }[] };
    const orgId = orgsBody.orgs?.[0]?.orgId;
    // A throw rather than `expect(...).toBeTruthy()`: the expect asserts but does
    // NOT narrow the type, and a non-null assertion would trade a compile error
    // for a runtime one. This keeps the same diagnostic and narrows honestly.
    if (!orgId) throw new Error(`no org for this session — cannot reach an org-scoped detail route (got ${JSON.stringify(orgsBody).slice(0, 200)})`);

    // The route 404s behind the toggle. Pin it on for this tenant only when it is
    // not already on. A build where an enabled feature REQUIRES `forms` (an adopter's
    // intake feature, #6093) has it on, and there the host refuses any write that
    // leaves `forms` off (the ADR 0194 disable-lock, 409), so writing would fail a
    // test whose precondition already holds. `forms` ships in this build (backend
    // features/forms), so a failed write is still a FAILURE, not a skip.
    const formsReachable = (await page.request.get(`${API}/forms/orgs/${orgId}/forms`)).status() === 200;
    const undoForms = formsReachable ? async (): Promise<void> => {} : await pinTenantToggle(page.request, 'forms', tenantId);
    try {

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
    } finally {
      await undoForms();
    }
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
 * ADR 0139 mobile drawer — off-canvas positioning alone must not leave the
 * closed rail in sequential keyboard navigation. This needs real CSS/browser
 * focus behavior; jsdom and a style-string assertion cannot prove it.
 */
test.describe('mobile shell — closed drawer keyboard exclusion', () => {
  test('closed More skips the rail; opening traps focus, Escape restores it, and desktop stays usable', async ({ page }) => {
    await loginPersonal(page.request, 'drawer-focus@e2e.test');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/chat');
    const quickAccess = page.getByRole('navigation', { name: 'Workspace quick access' });
    const more = quickAccess.getByRole('button', { name: 'More' });
    const sidebar = page.locator('#app-primary-navigation');
    const brand = sidebar.locator('.app-sidebar-brand');
    await expect(more).toBeVisible({ timeout: 60_000 });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    // Keyboard steps start only once the page has finished loading: something
    // focusable must exist after More, or the first Tab falls off the document
    // (:focus matches nothing). Measured 2026-11-09 at --repeat-each=40
    // --workers=4: 9/40 red at the in-viewport check below without this wait.
    // Until the BYOKWizard StrictMode fix, a late-mounting wizard stole focus
    // instead, which masked this race here and reddened the later focus checks.
    // This wait also lands that mount before the keyboard steps, so this spec
    // alone does NOT witness the wizard fix (40/40 green with it reverted); its
    // StrictMode case in BYOKWizard.flow.test.tsx does.
    await expect(page.locator('#main-content').locator('a[href], button, textarea, input').first()).toBeVisible({ timeout: 60_000 });

    // This exact next Tab reached the translated, invisible brand before the fix.
    await more.focus();
    await page.keyboard.press('Tab');
    expect(await sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await expect(page.locator(':focus')).toBeInViewport();

    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toBeVisible();
    await expect(brand).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    await expect(brand).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toBeFocused();
    // No animation delay: the first Tab after closing must already skip the rail.
    await page.keyboard.press('Tab');
    expect(await sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await expect(page.locator(':focus')).toBeInViewport();

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(quickAccess).not.toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(brand).toBeVisible();
    await brand.focus();
    await expect(brand).toBeFocused();
    await page.keyboard.press('Tab');
    await expect.poll(() => sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(brand).toBeFocused();
  });
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


/** CHAT-POCKET-VIEWPORT-2: viewport containment is insufficient when another
 * production surface wins the composer's hit target. This uses the real App,
 * Sidebar, FunnelArchitectPocket, EmbeddedConversation and ChatInput. The only
 * chat boundary replacement is a GET config response: no stored key/default,
 * provider call or artificial textarea/navigation geometry. */
test('pocket composer and non-modal navigation remain reachable above the mobile bar', async ({ page }) => {
  const tenantId = await loginPersonal(page.request, 'pocket-clearance@e2e.test');
  const restoreToggle = await pinTenantToggle(page.request, 'funnels', tenantId);
  const orgResponse = await page.request.post(`${API}/orgs`, { data: { name: 'Pocket clearance private fixture' } });
  expect(orgResponse.status(), await orgResponse.text()).toBe(201);
  const { orgId } = (await orgResponse.json()) as { orgId: string };
  expect(orgId).toBeTruthy();
  let dispatches = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(?:runs(?:\/|$)|chat\/send(?:$)|chat\/sessions\/[^/]+\/messages(?:$))/.test(new URL(request.url()).pathname)) dispatches += 1;
  });
  await page.route('**/host/openwop-app/byok/active-config', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ json: {
      config: { provider: 'google', model: 'gemini-3.5-flash-lite', credentialRef: 'google:e2e-no-dispatch' },
      valid: true, anonymous: false, stored: true,
    } });
  });
  const panel = page.getByRole('dialog', { name: 'Funnel Architect', exact: true });
  const message = panel.getByRole('combobox', { name: 'Message', exact: true });
  const launcher = page.locator('.chat-pocket-launcher');
  const hit = async (control: Locator): Promise<void> => {
    await expect(control).toBeVisible();
    expect(await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight
        && target !== null && element.contains(target);
    }), 'real center point must hit this control or its descendant').toBe(true);
  };
  const ready = async (): Promise<void> => {
    await expect(panel).toBeVisible();
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
  };
  try {
    // 639 is still full-width; 640 and 860 retain the desktop-shaped pocket
    // while sharing mobile navigation. 861 proves the breakpoint's other side.
    for (const viewport of [
      { width: 390, height: 844 }, { width: 390, height: 568 },
      { width: 639, height: 640 }, { width: 640, height: 640 },
      { width: 860, height: 640 }, { width: 861, height: 720 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/funnels?org=${encodeURIComponent(orgId)}`);
      await ready();
      await expect(panel).toHaveAttribute('aria-modal', 'false');
      await message.fill('QA unsent pocket clearance draft');
      // The production voice control is either a recording button, a live
      // conversation button, or their menu, depending on capability readiness.
      // Require exactly one named control; never skip a missing voice surface.
      const voice = panel.locator('button.chatinput-mic-btn');
      await expect(voice).toHaveCount(1);
      await expect(voice).toHaveAccessibleName(/\S/);
      for (const control of [message,
        panel.getByRole('button', { name: 'More: attach, workflow, agent', exact: true }),
        voice,
        panel.getByRole('button', { name: 'Send', exact: true }),
      ]) await hit(control);
      await panel.getByRole('button', { name: 'More: attach, workflow, agent', exact: true }).click();
      const attach = panel.getByRole('menuitem', { name: 'Attach a file', exact: true });
      await hit(attach);
      // Toggle this menu normally: Escape is intentionally reserved for the
      // later composer-to-pocket close/focus-return control.
      await panel.getByRole('button', { name: 'More: attach, workflow, agent', exact: true }).click();
      await expect(attach).toBeHidden();
      await expect(panel).toBeVisible();
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) throw new Error('visible pocket has no browser bounds');
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
      if (viewport.width <= 860) {
        const nav = page.locator('nav.app-mobile-nav');
        await expect(nav).toBeVisible();
        const bar = await nav.boundingBox();
        if (!bar) throw new Error('visible production mobile bar has no bounds');
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(bar.y);
        // The pocket is non-modal; geometry must not steal the real bar's slot.
        await hit(nav.getByRole('button', { name: 'More', exact: true }));
      } else {
        await expect(page.locator('nav.app-mobile-nav')).toBeHidden();
      }
      if (viewport.width <= 639) expect(bounds.width).toBe(viewport.width);
      else expect(bounds.width).toBe(420);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await hit(message);
      await hit(panel.getByRole('button', { name: 'Send', exact: true }));
      await panel.getByRole('button', { name: 'Close Funnel Architect', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(launcher).toBeFocused();
      await hit(launcher);
      await launcher.click();
      await ready();
      await expect(message).toHaveValue('QA unsent pocket clearance draft');
      await hit(message);
      await message.press('Escape');
      await expect(launcher).toBeFocused();
      await hit(launcher);
    }
    expect(dispatches, 'no Send, starter-prompt, recording or workflow dispatch').toBe(0);
  } finally {
    await restoreToggle();
  }
});


/** Independent71 control: keep the real guidance offered, rather than dismissing
 * it to make a pocket hit target pass. Source70's mobile-bar case is separate. */
test('tutorial offer and pocket composer retain their own real hit targets at 861px', async ({ page }) => {
  const tenantId = await loginPersonal(page.request, 'tutorial-pocket-clearance@e2e.test');
  const restoreToggle = await pinTenantToggle(page.request, 'funnels', tenantId);
  const org = await page.request.post(`${API}/orgs`, { data: { name: 'Tutorial pocket private fixture' } });
  expect(org.status(), await org.text()).toBe(201);
  const { orgId } = (await org.json()) as { orgId: string };
  expect(orgId).toBeTruthy();
  await page.route('**/host/openwop-app/byok/active-config', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ json: {
      config: { provider: 'google', model: 'gemini-3.5-flash-lite', credentialRef: 'google:e2e-no-dispatch' },
      valid: true, anonymous: false, stored: true,
    } });
  });
  let dispatches = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/(?:runs(?:\/|$)|chat\/send(?:$)|chat\/sessions\/[^/]+\/messages(?:$))/.test(new URL(request.url()).pathname)) dispatches += 1;
  });
  const panel = page.getByRole('dialog', { name: 'Funnel Architect', exact: true });
  const hint = page.getByRole('complementary', { name: 'Tutorial suggestion', exact: true });
  const message = panel.getByRole('combobox', { name: 'Message', exact: true });
  const launcher = page.locator('.chat-pocket-launcher');
  const hit = async (control: Locator): Promise<void> => {
    await expect(control).toBeVisible();
    expect(await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth && rect.bottom <= innerHeight
        && target !== null && element.contains(target);
    }), 'guidance and pocket must retain independent real hit targets').toBe(true);
  };
  const ready = async (): Promise<void> => {
    await expect(panel).toBeVisible();
    await panel.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
  };
  const hintControls = async (): Promise<void> => {
    await expect(hint).toContainText('Build Your First Sales Funnel');
    const learn = hint.getByRole('link', { name: 'Teach me this', exact: true });
    await expect(learn).toHaveAttribute('href', '/tutorials/build-your-first-funnel');
    await hit(learn);
    await hit(hint.getByRole('button', { name: 'Dismiss', exact: true }));
  };
  try {
    // First861 viewport is the independent causal witness; later iterations
    // retain desktop and short-height controls. No tutorial action is activated.
    for (const viewport of [
      { width: 861, height: 720 }, { width: 1280, height: 720 }, { width: 861, height: 568 },
      // Combined70+71 boundaries: both the live hint and mobile bar remain usable.
      { width: 720, height: 720 }, { width: 860, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      const progress = page.waitForResponse((response) => response.request().method() === 'GET'
        && new URL(response.url()).pathname.endsWith('/tutorials/progress'));
      await page.goto(`/funnels?org=${encodeURIComponent(orgId)}`);
      expect((await progress).status()).toBe(200);
      await ready();
      await expect(hint).toBeVisible();
      await message.fill('QA unsent tutorial and pocket coexistence');
      await hit(message);
      const voice = panel.locator('button.chatinput-mic-btn');
      await expect(voice).toHaveCount(1);
      await expect(voice).toHaveAccessibleName(/\S/);
      await hit(voice);
      await hit(panel.getByRole('button', { name: 'Send', exact: true }));
      const more = panel.getByRole('button', { name: 'More: attach, workflow, agent', exact: true });
      await hit(more);
      await more.click();
      await hit(panel.getByRole('menuitem', { name: 'Attach a file', exact: true }));
      await more.click();
      await hintControls();
      const pocketBounds = await panel.boundingBox();
      const hintBounds = await hint.boundingBox();
      if (!pocketBounds || !hintBounds) throw new Error('offered surfaces have no real browser bounds');
      expect(pocketBounds.y).toBeGreaterThanOrEqual(0);
      expect(pocketBounds.y + pocketBounds.height).toBeLessThanOrEqual(hintBounds.y);
      if (viewport.width <= 860) {
        const nav = page.locator('nav.app-mobile-nav');
        await expect(nav).toBeVisible();
        const bar = await nav.boundingBox();
        if (!bar) throw new Error('visible production mobile bar has no bounds');
        expect(hintBounds.y + hintBounds.height).toBeLessThanOrEqual(bar.y);
        await hit(nav.getByRole('button', { name: 'More', exact: true }));
      } else {
        await expect(page.locator('nav.app-mobile-nav')).toBeHidden();
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await hit(message); await hintControls();
      await panel.getByRole('button', { name: 'Close Funnel Architect', exact: true }).click();
      await expect(launcher).toBeFocused();
      await hit(launcher); await hintControls();
      await launcher.click(); await ready();
      await expect(message).toHaveValue('QA unsent tutorial and pocket coexistence');
      await hit(message); await hintControls();
      await message.press('Escape');
      await expect(launcher).toBeFocused();
      await hit(launcher); await hintControls();
    }
    expect(dispatches).toBe(0);
  } finally { await restoreToggle(); }
});
