import { test, expect, type Page } from '@playwright/test';
import { expect as pwExpect, type APIRequestContext } from '@playwright/test';
import { API, enableToggle } from './support/session.js';

/**
 * Does `density: compact` actually compact the app? (ADR 0510 / DSA-007)
 *
 * WHY THIS EXISTS. The spacing ratchet stalled on a real question: ~180 raw
 * `8px`/`12px`/`16px` literals are NOT safe to tokenize, because
 * `:root[data-density="compact"]` (global.css) redefines `--space-2/3/4`
 * (8→6, 12→9, 16→12). Tokenizing a literal therefore SHRINKS that element for
 * compact-density users — desirable or not is a `DESIGN.md` call, and the call
 * was being made on a guess.
 *
 * Measuring it anonymously got a partial answer (3 stuck elements of 443 on the
 * dashboard shell; 7 of 234 on the primitive gallery), but the literals live in
 * DENSE, AUTHED surfaces — tables, boards, admin lists — which an anonymous
 * session cannot reach. That is what this spec is for.
 *
 * WHAT IT MEASURES, PRECISELY. For every visible element on a route: its
 * computed padding/gap with density default, then again with
 * `data-density="compact"`. An element is STUCK when its box holds a value the
 * compact scale would have changed (8/12/16px) and yet does not move — i.e. a
 * hardcoded literal where a token would have compacted. That is the population
 * the deferred tranche would convert.
 *
 * WHAT IT DOES NOT CLAIM. It measures what these routes render with the e2e
 * seed. A route seeded with three rows is not a dense table, so the spec
 * REPORTS ITS SAMPLE SIZE and SKIPS a route that renders too little rather than
 * folding a sparse measurement into the total — a silent small sample would
 * understate the number and quietly settle the design question the wrong way.
 *
 * WHAT IT FOUND IN CI — the authoritative run, and the third correction.
 *
 * My LOCAL runs were environment-degraded: two of four routes answered with a
 * deny card, and I twice drew conclusions from what was left. In the real e2e
 * harness (toggles enabled, proper session) all four are reachable, and the
 * picture is much larger:
 *
 *   /runs   [data-dense-index]   395 visible ·   51 compact ·  5 stuck
 *   /agents [standard-index]     610 visible ·  134 compact ·  5 stuck
 *   /builder[standard-index]   3,082 visible · 1,370 compact · 58 stuck
 *   /design-system [gallery]     507 visible ·  111 compact ·  9 stuck (3 rows)
 *
 * THE LEAD — stated as a lead, because I checked the obvious explanation and
 * it was wrong. 52 of /builder's 58 stuck elements are `.secondary`, and
 * buttons dominate the stuck set on every route. The natural guess is that
 * button padding is literal — it is NOT: the base rule is
 * `padding: var(--space-2) var(--space-3)` (global.css:1109) and `.btn-sm` is
 * `var(--space-1) var(--space-2)` (:5254), both of which DO move under compact.
 * So something else in the box is holding an 8/12/16px value — a `gap`, a
 * feature-scoped override, or an ancestor rule.
 *
 * Which is why this spec now records the OFFENDING PROPERTY, not just the
 * class: "52 × .secondary" is not actionable, "52 × .secondary (gap)" is.
 *
 * Row counts are still ~0: the seed populates almost nothing, so this remains a
 * measurement of chrome. Both facts now travel together.
 *
 * WHAT I PUBLISHED FIRST, AND WHY IT WAS WRONG.
 *
 * First run reported 852 elements / 101 compacting / 15 stuck / 0 rows across
 * four routes, and I wrote that up as "the SEED renders no rows". That was a
 * confident claim about nothing: this spec QUOTED the tenantId trap from
 * support/session.ts and then committed it, so `/runs` — the only admin-tier
 * route here and the only `data-dense-index` one, i.e. the whole reason the
 * spec exists — answered with a DENY CARD. So did `/design-system`. Both
 * rendered an identical 191/21/3, which is the tell I noticed and explained
 * away. `/grade-code` caught it.
 *
 * What is actually measured today: `/agents` and `/builder` only — 470
 * elements, 59 compacting, 9 stuck, and genuinely 0 data rows. `/runs` has
 * never been measured. So the 8/12/16px tokenization call is NOT blocked on
 * seeding as I claimed; it is blocked on reaching the dense route at all, and
 * then on seeding. Denied routes are now excluded and NAMED rather than folded
 * into a total that reads as coverage.
 *
 * THE ASSERTION IS A RATCHET, not a target. `STUCK_BASELINE` may only fall: new
 * hardcoded spacing on a dense surface fails here. It is deliberately NOT zero,
 * because reaching zero is the very decision this evidence is meant to inform.
 */

/**
 * Sign in to the caller's OWN workspace. The shared `login()` requires a
 * tenantId, and Trap 1 in support/session.ts is that an explicit one makes the
 * seam treat the workspace as somebody else's — AdminLayout then renders
 * "Administrator access required" instead of the page. `hub-suspense.spec.ts`
 * keeps a local copy for the same reason rather than widening a helper eight
 * specs depend on; same call made here.
 */
async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  pwExpect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

/** Routes to measure. `archetype` is the manifest's own classification (ADR 0510). */
/**
 * SEED YOUR OWN FIXTURES. The spec's first runs reported ~0 data rows and I
 * wrote that up as "the e2e seed populates nothing" — wrong framing. Specs in
 * this lane seed their OWN data (`collab-ct`, `announcement-delivery`,
 * `a11y` all do); mine simply never did, so it measured the chrome around empty
 * tables and the density question stayed unanswered. A dense surface is the
 * whole point, so make one.
 */
async function seedDenseBoard(ctx: APIRequestContext, cards: number): Promise<{ seeded: number; boardId: string | null }> {
  // IDEMPOTENT: this spec runs with `retries`, and minting a board per attempt
  // would leave duplicates behind (generator class 2). Reuse the fixture if a
  // previous attempt already made it.
  const existing = await ctx.get(`${API}/kanban/boards`);
  if (existing.ok()) {
    const { boards } = (await existing.json()) as { boards?: Array<{ id?: string; name?: string }> };
    const found = (boards ?? []).find((b) => b.name === 'density-fixture');
    if (found?.id) return { seeded: -1, boardId: found.id };
  }
  const made = await ctx.post(`${API}/kanban/boards`, { data: { name: 'density-fixture' } });
  if (!made.ok()) return { seeded: 0, boardId: null };
  // `id`, NOT `boardId` — the route returns the bare board (routes/kanban.ts).
  // The `{ boardId }` shape was carried over from POST /orgs, so this bailed
  // before a single card and I recorded the cause as "the POST fails". It does
  // not fail; I read the wrong field (grade-code WRITE-5).
  const board = (await made.json()) as { id?: string; boardId?: string };
  const boardId = board.id ?? board.boardId;
  if (!boardId) return { seeded: 0, boardId: null };
  let seeded = 0;
  for (let i = 0; i < cards; i += 1) {
    const r = await ctx.post(`${API}/kanban/boards/${boardId}/cards`, {
      data: { title: `density row ${i + 1}`, columnId: 'todo' },
    });
    if (r.ok()) seeded += 1;
  }
  return { seeded, boardId };
}

const ROUTES: Array<{ path: string; archetype: string; toggles?: string[] }> = [
  { path: '/boards', archetype: 'seeded-dense' },
  { path: '/runs', archetype: 'data-dense-index' },
  { path: '/agents', archetype: 'standard-index' },
  { path: '/builder', archetype: 'standard-index' },
  { path: '/design-system', archetype: 'gallery' },
];

/** Below this, the route did not render enough to be evidence — skip, don't dilute. */
const MIN_ELEMENTS = 40;

/**
 * OBSERVED, not guessed: **0**. The history is worth keeping, because the
 * number only ever fell by finding one more literal: 77 → 58 (two literal
 * paddings) → 61 (the gallery grew `.status-badge` instances; `main` sat red)
 * → 55 (`.status-badge` tokenized) → 0 (`.workflow-card-menu-btn` tokenized,
 * one per workflow card, which is why a single declaration accounted for the
 * entire remaining budget).
 *
 * ZERO IS NOT A VICTORY LAP — it is what makes this gate finally mean something.
 * At 55 the assertion could not fail for any regression smaller than the debt it
 * was already carrying; at 0, ONE new literal on a measured route fails CI. If
 * that turns out to be too tight in practice, raise it DELIBERATELY with the
 * measurement that justified it — never to make a red run go away.
 *
 * The whole class is a literal that EQUALS its token (`2px 8px` vs
 * `2px var(--space-2)`): identical in review, in a screenshot and in the built
 * CSS, divergent only when the density mode flips. This spec is the only thing
 * that can see it. The console.log below exists because that
 * number was previously invisible — annotations do not reach a `list`-reporter
 * log, so the gate showed a green tick and no value, which is how a baseline
 * comes to sit loose for weeks without anyone able to see it.
 *
 * Shrink-only, and SCOPED TO THE ROUTES THAT ARE ACTUALLY REACHABLE. The first
 * cut sat at 400 against a measured 9 — a 26× no-op that let the file claim
 * "new hardcoded spacing fails CI" while failing nothing. If a denied route
 * later becomes reachable the count will RISE and this must be re-baselined
 * deliberately, which is exactly the moment someone should look at it.
 */
const STUCK_BASELINE = Number(process.env.OPENWOP_DENSITY_STUCK_BASELINE ?? '0');

interface Measurement {
  elements: number;
  compacted: number;
  stuck: number;
  /** Data rows actually rendered. The whole point of a DENSE surface. */
  rows: number;
  stuckKinds: Array<[string, number]>;
}

async function measure(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const els = [...document.body.querySelectorAll('*')].filter((e) => e.getClientRects().length > 0);
    const snap = (): string[] => els.map((e) => {
      const s = getComputedStyle(e);
      return `${s.padding}|${s.gap}|${s.rowGap}|${s.columnGap}`;
    });
    const before = snap();
    const priorDensity = root.dataset.density;
    root.dataset.density = 'compact';
    const after = snap();
    if (priorDensity === undefined) delete root.dataset.density;
    else root.dataset.density = priorDensity;

    let compacted = 0;
    const kinds = new Map<string, number>();
    let stuck = 0;
    els.forEach((e, i) => {
      if (before[i] !== after[i]) { compacted += 1; return; }
      // A value the compact scale WOULD have moved, that did not move.
      if (/\b(8|12|16)px\b/.test(before[i]!)) {
        stuck += 1;
        const cls = String((e as HTMLElement).className || e.tagName).trim().split(/\s+/)[0] ?? e.tagName;
        // WHICH property is stuck — "52 × .secondary" is not actionable,
        // "52 × .secondary(gap)" points straight at the declaration.
        const [pad, gap] = before[i]!.split('|');
        const props: string[] = [];
        if (/\b(8|12|16)px\b/.test(pad ?? '')) props.push('padding');
        if (/\b(8|12|16)px\b/.test(gap ?? '')) props.push('gap');
        const key = `${cls}(${props.join('+') || 'other'})`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
    });
    // ROW COUNT IS THE HONESTY METRIC. Element count alone cannot tell a dense
    // table from an empty one wearing the same chrome — the app shell is ~190
    // elements before a single row exists, which is well over any sane floor.
    const rows = document.querySelectorAll(
      'table tbody tr, [role="row"], .kb-card, .list-row, [data-testid$="-row"]',
    ).length;
    return {
      rows,
      elements: els.length,
      compacted,
      stuck,
      stuckKinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    };
  });
}

test.describe('compact density actually compacts (ADR 0510 / DSA-007)', () => {
  // Two full computed-style passes over every visible element on several routes
  // is genuinely slow; this is a measurement, not a smoke check.
  test.slow();

  test('measures the dense surfaces and holds the hardcoded-spacing ratchet', async ({ page, context }) => {
    // Trap 1 in support/session.ts, which I quoted and then COMMITTED in the
    // first cut: passing an explicit tenantId makes the seam treat that
    // workspace as somebody else's, so `basis` never resolves tenant-owner and
    // AdminLayout renders "Administrator access required" INSTEAD of the page.
    // `/runs` is the only admin-tier route here AND the only data-dense-index
    // one — i.e. exactly the route this spec exists to measure. Measuring a
    // deny card is the textbook way to get a confident number about nothing.
    // Omit the tenantId so the caller lands in their own workspace.
    await loginPersonal(context.request, 'density@e2e.test');
    // Seed BEFORE measuring, and report what actually landed — a seed that
    // silently fails would put us straight back to measuring empty chrome.
    const { seeded, boardId } = await seedDenseBoard(context.request, 24);
    // DEEP-LINK the fixture. `/boards` redirects to boards[0] by createdAt, so
    // the measured board was never guaranteed to be the seeded one — which is
    // how `seeded 24 · 0 rows` could pass green (grade-data DENS-D-1).
    if (boardId) ROUTES[0] = { path: `/boards/${boardId}`, archetype: 'seeded-dense' };
    test.info().annotations.push({ type: 'density-seeded', description: `${seeded} card(s) seeded` });
    // A zero seed used to pass green: the ~190-element shell clears the element
    // floor even on an empty board, so nothing noticed. Assert it landed.
    expect(seeded, 'the dense fixture seeded nothing — the measurement would be of chrome again').not.toBe(0);

    const totals: Measurement = { elements: 0, compacted: 0, stuck: 0, rows: 0, stuckKinds: [] };
    const skipped: string[] = [];
    const denied: string[] = [];
    const perRoute: string[] = [];

    for (const route of ROUTES) {
      for (const id of route.toggles ?? []) await enableToggle(context.request, id);
      await page.goto(route.path, { waitUntil: 'domcontentloaded' });
      // NOT `networkidle`: this app holds SSE streams open, so the network never
      // goes idle and the wait burns the whole test budget before measuring
      // anything. Settle on the paint instead.
      await page.waitForTimeout(1200);

      // A DENY CARD RENDERS FINE AND MEASURES NOTHING. The first cut of this
      // spec quoted that trap and then walked into it: /runs answered with
      // "Administrator access required" and the run still produced a tidy
      // 191/21/3, which I published as evidence about a dense surface. Route
      // access is environmental, so a denied route is EXCLUDED and NAMED —
      // never silently folded into a total that then reads as coverage.
      if (await page.getByText(/Administrator access required/i).count()) {
        denied.push(`${route.path} [${route.archetype}] — DENIED (admin tier; not measured)`);
        continue;
      }

      const m = await measure(page);
      if (m.elements < MIN_ELEMENTS) {
        skipped.push(`${route.path} (${m.elements} elements — below the ${MIN_ELEMENTS} evidence floor)`);
        continue;
      }
      totals.elements += m.elements;
      totals.compacted += m.compacted;
      totals.stuck += m.stuck;
      totals.rows += m.rows;
      perRoute.push(
        `${route.path} [${route.archetype}]: ${m.rows} rows · ${m.elements} visible · ${m.compacted} compact · ${m.stuck} stuck`
        + (m.stuckKinds.length ? ` · top: ${m.stuckKinds.map(([k, n]) => `${k}×${n}`).join(', ')}` : ''),
      );
    }

    // Print it too. Annotations only survive the JSON reporter, so a `list`-
    // reporter CI log shows a green tick and NO NUMBER — which is how this
    // baseline came to sit at a value nobody could see was loose.
    // eslint-disable-next-line no-console -- the measurement IS the output
    console.log(`[density] seeded ${seeded} · ${totals.rows} rows · ${totals.elements} visible · ${totals.compacted} compact · ${totals.stuck} stuck${denied.length ? ` · DENIED: ${denied.length}` : ''}`);

    // SAMPLE SIZE IS PART OF THE RESULT. A number without it can be a sparse
    // seed masquerading as a dense surface.
    test.info().annotations.push(
      { type: 'density-sample', description: perRoute.join(' | ') },
      { type: 'density-total', description: `${totals.rows} rows · ${totals.elements} visible · ${totals.compacted} compact · ${totals.stuck} stuck` },
      { type: 'density-caveat', description: denied.length
        ? `NOT COVERAGE: ${denied.length} route(s) denied access and were not measured — ${denied.join('; ')}. Any conclusion about dense surfaces is unsupported until these are reachable.`
        : totals.rows < 20
        ? `THIN SAMPLE: only ${totals.rows} data rows rendered, so this measures shared CHROME, not dense data. Do not settle the tokenization question on it.`
        : `${totals.rows} data rows measured.` },
      ...(skipped.length ? [{ type: 'density-skipped', description: skipped.join(' | ') }] : []),
      ...(denied.length ? [{ type: 'density-denied', description: denied.join(' | ') }] : []),
    );

    // Vacuity guard: if every route fell under the floor we measured nothing, and
    // a green run would be a lie. Fail loudly instead.
    expect(totals.elements, `no route rendered enough to measure (skipped: ${skipped.join(', ')})`)
      .toBeGreaterThan(MIN_ELEMENTS);

    expect(
      totals.stuck,
      `hardcoded 8/12/16px spacing on dense surfaces grew (was ≤${STUCK_BASELINE}). `
      + `Use --space-* tokens so compact density reaches them. Per route: ${perRoute.join(' | ')}`,
    ).toBeLessThanOrEqual(STUCK_BASELINE);
  });
});
