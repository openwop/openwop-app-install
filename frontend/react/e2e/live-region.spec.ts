import { test, expect } from '@playwright/test';

/**
 * Live-region announcement PRECONDITION, in a real browser.
 *
 * WHAT THIS CAN AND CANNOT PROVE — read before trusting a green run.
 *
 * A screen reader announces a live region only if it was ALREADY WATCHING that
 * region when the text arrived. A region inserted together with its text has
 * never "changed", so it is silent — that is the defect behind #2616, #2620 and
 * #2632, and the reason `role="alert"` was left alone (the ARIA spec says a UA
 * SHOULD fire an alert event when an alert is CREATED; `role="status"` gets no
 * such handling).
 *
 * That precondition — does the region pre-exist the message, and does the text
 * land in THAT node rather than a new one — is objectively testable, and this
 * spec tests it against a real Chromium accessibility tree. The jsdom unit tests
 * could not: jsdom builds no accessibility tree at all.
 *
 * What NO automated test can do is hear what VoiceOver or NVDA actually SAYS.
 * Announcement happens inside the AT process; axe-core explicitly does not audit
 * it. So a green run here means "the mechanism is correctly shaped", never "a
 * blind user heard it". `VERIFY-6` remains open for exactly that reason, and
 * this spec narrows it rather than closing it.
 */

// Target the SHELL regions by name. `[aria-live="polite"]` matches ~50 nodes
// app-wide, so `.first()` silently tested an arbitrary one — the reason an
// earlier version of this spec passed with <GlobalLiveRegion/> deleted.
const POLITE = '[data-owp-live="polite"]';
const ASSERTIVE = '[data-owp-live="assertive"]';

test.describe('live regions pre-exist their messages', () => {
  test('the shell mounts BOTH regions, empty, before any message', async ({ page }) => {
    // Keep this precondition test isolated from the independently tested demo-
    // durability disclosure. Under a loaded gate its capability read can fail
    // quickly and correctly announce before Playwright samples the region.
    await page.addInitScript(() => localStorage.setItem('openwop:demo-banner:dismissed', 'true'));
    await page.goto('/runs');
    // Present…
    await expect(page.locator(POLITE).first()).toBeAttached();
    await expect(page.locator(ASSERTIVE).first()).toBeAttached();
    // …and EMPTY. A region that boots with text is the defect in miniature.
    expect((await page.locator(POLITE).first().textContent())?.trim()).toBe('');
  });

  test('the polite region is in the ACCESSIBILITY TREE, not merely the DOM', async ({ page }) => {
    // The distinction matters: `display:none` keeps a node in the DOM and removes
    // it from the a11y tree, and a screen reader watches only the latter. jsdom
    // cannot make this distinction at all — it builds no a11y tree.
    await page.goto('/runs');
    const tree = await page.locator('body').ariaSnapshot();
    // `role="status"` is how the polite region surfaces to assistive tech.
    expect(tree).toContain('status');
  });

  test('the region SURVIVES in-app navigation — it is not remounted per route', async ({ page }) => {
    // The property that decides announcement: the region must already be under
    // observation when text arrives. If the shell remounted it on every route
    // change, each new page would get a fresh, unwatched region — silent again.
    //
    // Marked, then navigated CLIENT-SIDE (a full page load would trivially
    // destroy the marker and prove nothing — an earlier version of this test
    // asserted `>= 0`, which is true of every number and tested exactly nothing).
    await page.goto('/runs');
    await expect(page.locator(POLITE).first()).toBeAttached();
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) (el as HTMLElement).dataset.owpProbe = 'pre-existing';
    }, POLITE);

    const navLink = page.getByRole('link', { name: /^Chat$/ }).first();
    await navLink.click();
    await page.waitForURL(/\/chat/, { timeout: 15_000 });

    // Same node, after a route change: the shell owns it, not the page.
    await expect(page.locator(`${POLITE}[data-owp-probe="pre-existing"]`)).toHaveCount(1);
  });
});

/**
 * DELIVERY — the half the precondition tests cannot reach.
 *
 * The three tests above prove the regions are correctly SHAPED: they pre-exist
 * their messages, they are in the accessibility tree, they survive navigation.
 * None of them proves any real call site actually PUTS TEXT THERE. A perfectly
 * shaped region that nothing writes to is silent in exactly the same way as a
 * broken one, and the app has shipped that defect repeatedly (#2615, #2616,
 * #2620) — so "the mechanism is right" and "this action announces" are two
 * claims, and only the second protects a user.
 *
 * The case chosen is deliberate: a Copy button on `/cli`, whose entire purpose
 * is handing out shell commands, with `navigator.clipboard` forced UNAVAILABLE.
 * That is the real non-secure-context path (plain HTTP, some embedded webviews)
 * where optional chaining used to short-circuit the whole promise chain, so
 * NEITHER handler ran: no toast, no error, no throw. The user pressed Copy,
 * nothing happened, and they pasted something stale believing otherwise.
 *
 * It needs no authentication, which matters — `app.openwop.dev` serves an
 * anonymous demo session, so the authed announcement surfaces (payout console,
 * canvas org picker) cannot be covered here at all. Those stay open.
 *
 * Still NOT proven, and no automated test can: what a screen reader SAYS. This
 * asserts the message lands in a node carrying `role="alert"`, which the ARIA
 * spec says a UA SHOULD announce on creation. `VERIFY-6` stays open.
 */

/**
 * THE GAP THIS SPEC DOES NOT CLOSE — delivery.
 *
 * Everything above proves the regions are correctly SHAPED: they pre-exist their
 * messages, they are in the accessibility tree, they survive navigation. NOTHING
 * here proves a real call site ever PUTS TEXT IN ONE. A perfectly shaped region
 * that nothing writes to is silent exactly like a broken one, and this app has
 * shipped that defect repeatedly (#2615, #2616, #2620).
 *
 * I wrote the delivery tests and then removed them rather than ship what I could
 * not watch pass. The natural target is the `/cli` Copy button with
 * `navigator.clipboard` forced undefined — the real non-secure-context path,
 * verified BY HAND against app.openwop.dev on 2026-08-03: the failure message
 * renders inside a node carrying `role="alert"`. But `/cli` is ADMIN-TIER, so
 * the default lane renders "Administrator access required", and the routes lane
 * needs both the seam backend and an explicit `login()` the way
 * `feature-routes.spec.ts` does it.
 *
 * To finish it: put the delivery tests in the ROUTES lane, reuse that spec's
 * `login(ctx.request, 'admin@e2e.test', TENANT)` + `OPENWOP_E2E_ROUTES=1`
 * harness, and assert BOTH polarities — a forced-unavailable clipboard reaches
 * `getByRole('alert')` with the failure copy, and a working one does not. The
 * second half is not optional: without it the first passes against a build that
 * announces "couldn't copy" unconditionally.
 *
 * Blocked separately: the authed announcement surfaces (payout console, canvas
 * org picker) cannot be reached from the anonymous session app.openwop.dev
 * serves by default.
 */
// CORRECTED 2026-09-25: the delivery tests landed in `announcement-delivery.spec.ts`
// (routes lane). Since PROF-UX-20 a failed toast has NO `role="alert"` of its own —
// it is announced ONLY through the `[data-owp-live="assertive"]` region above — so
// "reaches `getByRole('alert')`" in the paragraph above describes the retired
// mechanism. That spec asserts the current one.
