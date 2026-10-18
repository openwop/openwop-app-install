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
    // Present, and EXACTLY ONE of each — `.first()` used to hide a duplicate.
    await expect(page.locator(POLITE)).toHaveCount(1);
    await expect(page.locator(ASSERTIVE)).toHaveCount(1);
    // …and BOTH empty. A region that boots with text is the defect in miniature.
    // (This used to read only the polite region, so an assertive region booting
    // with text passed — wave 53 probe w53g3-lr-assertive-boots-text.)
    const boot = await page.evaluate(([p, a]) => ({
      polite: document.querySelector(p)?.textContent?.trim() ?? null,
      assertive: document.querySelector(a)?.textContent?.trim() ?? null,
    }), [POLITE, ASSERTIVE] as const);
    expect(boot).toEqual({ polite: '', assertive: '' });
  });

  test('the polite region is in the ACCESSIBILITY TREE, not merely the DOM', async ({ page }) => {
    // The distinction matters: `display:none` keeps a node in the DOM and removes
    // it from the a11y tree, and a screen reader watches only the latter. jsdom
    // cannot make this distinction at all — it builds no a11y tree.
    //
    // `getByRole` resolves roles through Playwright's accessibility computation
    // and skips nodes hidden from it, so this requires THE SHELL REGION ITSELF
    // to surface as `status`. It used to assert `ariaSnapshot()` contained the
    // word "status", which the demo-host banner (`InMemoryHostBanner`, also
    // role="status") satisfied with the shell region's role deleted
    // (wave 53 probe w53g3-lr-polite-role: vacuous).
    await page.goto('/runs');
    await expect(page.getByRole('status').and(page.locator(POLITE))).toHaveCount(1);
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
    await expect(page.locator(POLITE)).toHaveCount(1);
    // The start route must NOT already be the target, or the click is a no-op
    // navigation and "survived" is trivially true.
    await expect(page).toHaveURL(/\/runs$/);
    // Hold the node itself (a handle, not a window global): if the region is
    // remounted, this handle keeps pointing at the detached old node.
    const region = await page.locator(POLITE).elementHandle({ timeout: 5_000 });
    expect(region, 'the polite region is not mounted at the start route').not.toBeNull();
    await region!.evaluate((el) => { el.dataset.owpProbe = 'pre-existing'; });

    const navLink = page.getByRole('link', { name: /^Chat$/ }).first();
    await navLink.click();
    await expect(page).toHaveURL(/\/chat(\?|$)/, { timeout: 15_000 });
    // The URL is NOT the commit. react-router 7 navigates inside
    // `startTransition`, so `pushState` lands while React still shows the OLD
    // tree until the new route's lazy chunk resolves — and this case used to
    // check the region in exactly that window, where any remount had not yet
    // happened (wave 53: a region keyed on the pathname passed twice,
    // w53g3-lr-remount-per-route r1/r2). Wait for the shell's OWN render of
    // the new route: `app-shell--ai` is set by App.tsx from the same
    // `location` in the same render that would remount a per-route region.
    await expect(page.locator('.app-shell.app-shell--ai')).toHaveCount(1, { timeout: 15_000 });

    // Same NODE, after a route change: the shell owns it, not the page. Identity
    // is checked directly (not only through the marker attribute).
    await expect(page.locator(`${POLITE}[data-owp-probe="pre-existing"]`)).toHaveCount(1);
    const same = await page.evaluate(([sel, el]) => document.querySelector(sel) === el, [POLITE, region!] as const);
    expect(same, 'the polite region was replaced by a new node on navigation').toBe(true);
  });
});

/**
 * DELIVERY — what this file does NOT prove. The three tests above prove the
 * regions are correctly SHAPED (they pre-exist their messages, are in the
 * accessibility tree, survive navigation). Whether a real call site PUTS TEXT
 * in them is a separate claim, covered by `announcement-delivery.spec.ts`
 * (routes lane). Since PROF-UX-20 a failed toast has no `role="alert"` of its
 * own and is announced ONLY through the `[data-owp-live="assertive"]` region.
 * What a screen reader actually SAYS stays out of reach of any automated test
 * (`VERIFY-6`).
 */
