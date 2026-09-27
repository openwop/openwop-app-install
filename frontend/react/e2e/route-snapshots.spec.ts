import { test, expect, type Page } from '@playwright/test';
import { API, enableToggle } from './support/session.js';
import { serveFontsLocally } from './support/localFonts.js';

/**
 * Critical-route visual snapshots (ADR 0510 Phase 2, DSA-031 — route half).
 *
 * PROMOTED to the merge gate 2026-08-16 (DSYS-4): the ADR 0509 bar — proven
 * deterministic across consecutive runs — was met with TWO consecutive green
 * runs in the MERGE-GATE lane's own environment (ci.sh's backend boot,
 * OPENWOP_DEMO_MODE=true — the first promotion attempt collected evidence in
 * the e2e-routes lane, whose demo-OFF boot renders DIFFERENT chat pixels:
 * one baseline set cannot serve two environments, so the spec was REMOVED
 * from the ci:full lane list and the default lane owns it alone). Before
 * that, three real nondeterminism sources were fixed rather than masked
 * (none was a maskable timestamp):
 *   1. the live font CDN (the promoted visual spec's six-flake lesson) —
 *      now served locally;
 *   2. a 5s screenshot timeout too tight for the ~3 MB builder capture —
 *      now 30s;
 *   3. the BYOK operator fineprint forking on `developer-tools`' boot-
 *      environment-dependent default and a two-fetch state join — the toggle
 *      is now pinned via the harness helper and the DOM state awaited.
 * Masks remain reserved for truly nondeterministic content (relative
 * timestamps); layout and controls are never masked — a mask cannot fix a
 * layout shift, which is what all three sources actually produced.
 */

const ROUTES: Array<{ route: string; name: string; anonymous?: boolean }> = [
  { route: '/', name: 'public-home', anonymous: true },
  { route: '/dashboard', name: 'dashboard' },
  { route: '/chat', name: 'chat' },
  { route: '/builder', name: 'builder' },
  { route: '/access?tab=appearance', name: 'appearance' },
];

async function login(page: Page): Promise<void> {
  const res = await page.request.post(`${API}/test/login`, { data: { email: 'route-snap@e2e.test' } });
  expect(res.status(), await res.text()).toBe(201);
}

test.describe('critical-route visual snapshots (ci:full)', () => {
  test.describe.configure({ timeout: 120_000 });
  // Baselines are platform-suffixed and only -darwin is committed (this
  // repo's merge gate is a macOS box). On any other platform fail with the
  // remedy named, BEFORE a pixel compare that could only mislead — and never
  // silently skip (the ci.sh browser-lane rule).
  test.beforeAll(() => {
    if (process.platform !== 'darwin') {
      throw new Error(
        'route-snapshot baselines exist only for darwin. Generate a committed baseline set for this platform ' +
        'from a PINNED environment (e.g. the mcr.microsoft.com/playwright image) — do NOT run --update-snapshots ad hoc; ' +
        'an unreviewed baseline makes the visual gate certify whatever this machine happens to render.',
      );
    }
  });
  test.use({ viewport: { width: 1280, height: 900 } });

  for (const { route, name, anonymous } of ROUTES) {
    for (const theme of ['light', 'dark'] as const) {
      // H100 — `/builder` is ADVISORY, and the reason is that the assertion is
      // currently FALSE, not that the page is broken.
      //
      // MEASURED 2026-08-18, four contexts, four heights:
      //
      //     committed baseline        15959
      //     single-spec run           15873
      //     full-suite harness        16164
      //     ci.sh, unrelated branch   16318
      //
      // CORRECTION, same day, after row-diffing the PNGs and checking the
      // ancestry — the original text here said "none of them the committed
      // baseline … there is no such value", and that OVERSTATED the problem.
      // THREE of the four are COMMIT DIFFERENCES, not nondeterminism:
      //
      //   15959  pre-#3333 — the `agent-knowledge` card did not exist yet
      //   16164  pre-#3348
      //   16318  post-#3348 — `a78c543e6` rewrote the knowledge chain-pack
      //          descriptions (`git log -S "CARRYING THE ANSWER TEXT"`;
      //          ancestry `9c9ca714b < a78c543e6 < 7ff4c6354`)
      //
      // Only `15873` vs `16164` is genuine: the SAME TREE rendered twice, with
      // different `csm-ops` pack text. We had been comparing renders across four
      // commits and calling the variance nondeterminism.
      //
      // The conclusion survives the correction and is if anything better
      // founded: a baseline is only meaningful against a STATED COMMIT, and
      // these were not. Re-recording now would produce a number only the
      // recording context reproduces — green for its author, red for everyone
      // else — which is exactly how we got four numbers and no shared one.
      //
      // This is the `@serial`/collab shape and takes the same remedy: it still
      // RUNS and is still REPORTED, it just does not fail the gate. Deleting or
      // skipping it would be worse — ci.sh's own words, "a quarantine that stops
      // a test executing is indistinguishable from deleting it a few months
      // later." Merging through a red gate would be worse still: the next person
      // inherits a red they are expected to know is fine, which is
      // indistinguishable from a red nobody has looked at (#3050 is the standing
      // record — five commits went through last time).
      //
      // THE OPEN QUESTION ABOVE IS ANSWERED (ADR 0626, 2026-09-02). It asked
      // whether the height tracked what had finished LOADING (H86) or the
      // ENVIRONMENT (H87). Neither survived:
      //
      //   - H86 was already fixed by #3365 — the `[data-chains-state="ready"]`
      //     wait below. (The sentence this replaces still described the pre-#3365
      //     `waitForTimeout(1500)` as the pack-list wait; the remaining 1500ms is
      //     a generic settle. A comment outliving the code it describes is how
      //     that hypothesis stayed "open" for two weeks after it was closed.)
      //   - H87 was addressed by DSYS-4's dedicated pack dir in ci.sh.
      //   - The residual variance was neither: it was REPOSITORY CONTENT. Two
      //     independent gate-condition runs on one commit were pixel-identical
      //     (A ≡ B ⇒ deterministic), while every difference ACROSS commits
      //     tracked `examples/workflow-chain-packs` — three added packs
      //     (15959→17598px), then a reworded `people-hr` description one day
      //     later (→17946px).
      //
      // So the fix was not a better wait but a smaller input: ci.sh now boots
      // this lane against the pinned fixture in `e2e/fixtures/chain-packs` with
      // the in-tree examples root dropped, so the gallery is a function of THIS
      // SPEC. Re-recording is legitimate again — but only as the last step of a
      // change that intends the pixels to move, never to clear a red.
      //
      // Still `@advisory` only because promoting it is a separate decision
      // (ADR 0626 §P2): the objection to promoting — "the baseline can be
      // invalidated by a commit that never touches /builder" — is now gone, so
      // promotion is unblocked and wants a few stability runs behind it.
      const advisory = name === 'builder' ? { tag: '@advisory' } : {};
      test(`${name} @${theme}`, advisory, async ({ page, context }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        // DSYS-4 — the promoted visual spec's own lesson (six webfont
        // NetworkError flakes): never depend on the live font CDN in a
        // pixel-compared run.
        await serveFontsLocally(page);
        if (anonymous) await context.clearCookies();
        else await login(page);
        // DSYS-4 stability evidence, runs 1-3 finding: the BYOK gate's
        // operator fineprint renders on `useFeatureAccess('developer-tools')`
        // — whose DEFAULT is `demoMode() ? 'on' : 'off'`, i.e. decided by the
        // booted backend's environment, and whose client state applies only
        // after TWO fetches join. Pixel determinism therefore needs the
        // toggle PINNED (the feature-gated spec's own harness helper) and the
        // DOM state awaited — a mask cannot fix a layout shift, and a settle
        // timeout cannot fix a boot-environment fork.
        if (route === '/chat') await enableToggle(page.request, 'developer-tools');
        await page.goto(route);
        if (route === '/chat') {
          await page.waitForSelector('.byok-section-fineprint--operator', { state: 'attached', timeout: 30_000 });
        }
        await page.waitForSelector('main#main-content, main#public-main');
        // H86 — `/builder` populates its template gallery from an unchained
        // `listChainTemplates()` promise, so the settle timeout below samples
        // whatever had rendered rather than a determinate DOM. Wait for the
        // gallery to REPORT itself loaded instead.
        //
        // WHAT THE EVIDENCE ACTUALLY IS, stated at the strength we have: ONE
        // pair. `15873` and `16164` are the same tree rendered twice, differing
        // in `csm-ops` pack text. Only `data-chains-state` is waited on because
        // it is the only population shown to vary; `data-list-state` and
        // `data-fleet-state` exist on the same element as instrumentation, and
        // the fleet one CANNOT be waited on regardless — `fleetFigures` is empty
        // both before the fetch lands and on a host with no runs, so a visual
        // proxy cannot tell "not yet" from "never".
        if (route === '/builder') {
          await page.waitForSelector('[data-chains-state="ready"]', { timeout: 30_000 });
        }
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: '* { caret-color: transparent !important; }' });
        // Settle data fetches; not networkidle (SSE/polling never idles).
        await page.waitForTimeout(1500);
        await page.evaluate((t) => {
          document.documentElement.classList.remove('theme-light', 'theme-dark');
          document.documentElement.classList.add(`theme-${t}`);
        }, theme);
        // The appearance route lives inside the shared admin shell. Its rail is
        // covered by admin-governance.spec.ts and legitimately changes when a
        // parallel feature test toggles an admin destination (for example
        // kicktodo-core adds the System operations group). Keep this route's
        // pixel contract on the page it owns instead of shared mutable chrome.
        const main = route === '/access?tab=appearance'
          ? page.locator('.admin-content').first()
          : page.locator('main#main-content, main#public-main').first();
        // No masks yet — add per PROVEN flake (relative timestamps are the
        // expected class), never preemptively broad.
        await expect(main).toHaveScreenshot(`route-${name}-${theme}.png`, {
          animations: 'disabled', timeout: 30_000,
          maxDiffPixelRatio: 0.001,
        });
      });
    }
  }
});
