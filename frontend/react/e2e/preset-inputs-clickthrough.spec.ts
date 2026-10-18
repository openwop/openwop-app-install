/**
 * ADR 0524 Phase E — the click-through, automated.
 *
 * Phase E shipped with five items in `UX-ASSESSMENT.md` marked "human must
 * verify", the load-bearing one being `CT-E2`: **clear the last preset input,
 * reload, is it still cleared?** That is the payoff of the entire ADR
 * 0523/0524/0525 program, and it was asserted only against the builder store —
 * never through a browser, never across a real save and reload.
 *
 * A one-off human click-through would have answered it once. This answers it on
 * every CI run, which is the difference between a check and an anecdote.
 *
 * WHAT THIS DOES NOT REPLACE: aesthetic judgement. `CT-E1` (does the row wrap
 * sanely at 360px), `CT-E3` (does the read-only treatment READ as deliberate)
 * and `CT-E5` (dark-mode legibility) are captured as screenshots for a human to
 * look at — an assertion cannot tell you something looks wrong, only that it
 * moved.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { serveFontsLocally } from './support/localFonts.js';

const API = '/api/host/openwop-app';

/** The opt-in seam for capture-for-a-human harnesses (collab-ct.spec.ts used it until its deletion, 2026-10-17). */
const SHOT_DIR = process.env.CT_SHOT_DIR ?? '';

/** No explicit tenantId — see `support/session.ts` Trap 1: passing one makes the
 *  seam treat the workspace as somebody else's and renders a deny card. */
async function loginPersonal(ctx: APIRequestContext, email: string): Promise<void> {
  const res = await ctx.post(`${API}/test/login`, { data: { email } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
}

/**
 * Seed a workflow whose node carries preset inputs — SEED YOUR OWN FIXTURES
 * (the density spec learned this the hard way: a spec that assumes the shared
 * seed populated something measures whatever happens to be there).
 *
 * `to` is a plain string (editable). With `withRef` (the default), a second node
 * carries an RFC 0124 variable ref `topic` (read-only) so both branches of the
 * Inspector render in one page.
 *
 * `withRef: false` makes `only` the SOLE input-carrying node. That is the case
 * ADR 0524 Phase E0's `x-openwop-field-contract` header exists for: without the
 * declaration, the server's whole-set heuristic (`preserveDroppedFields`) reads
 * "no node carries inputs" as an old bundle and RESURRECTS the cleared input.
 * With a second input-carrying node the heuristic never fires, so the header is
 * not load-bearing — which is how CT-E2 used to pass with the header deleted
 * (wave 53 probe w53g3-preset-no-field-contract: vacuous).
 */
async function seedWorkflow(ctx: APIRequestContext, workflowId: string, { withRef = true }: { withRef?: boolean } = {}): Promise<void> {
  const only = { nodeId: 'only', typeId: 'core.noop', config: {}, inputs: { to: 'someone@example.com' } };
  const res = await ctx.post(`${API}/workflows`, {
    data: withRef
      ? {
        workflowId,
        metadata: { name: 'Phase E click-through' },
        nodes: [
          only,
          { nodeId: 'refnode', typeId: 'core.noop', config: {}, inputs: { topic: { type: 'variable', variableName: 'topic' } } },
        ],
        edges: [{ edgeId: 'e1', sourceNodeId: 'only', targetNodeId: 'refnode' }],
        variables: [{ name: 'topic', type: 'string' }],
      }
      : {
        workflowId,
        metadata: { name: 'Phase E click-through (sole input)' },
        nodes: [only, { nodeId: 'plain', typeId: 'core.noop', config: {} }],
        edges: [{ edgeId: 'e1', sourceNodeId: 'only', targetNodeId: 'plain' }],
      },
  });
  expect(res.status(), `seed ${workflowId}: ${await res.text()}`).toBe(201);
}

/** The editable preset row for `to`, and ITS Clear button — never a page-wide
 *  `/clear/i` match, which could hit any other "Clear…" control on the builder. */
function presetRow(page: Page) {
  const value = page.getByLabel(/value for the .*to.* input/i);
  const row = page.locator('.binspector-pinned-input-row', { has: value });
  return { value, clear: row.getByRole('button', { name: 'Clear', exact: true }) };
}

async function readHead(ctx: APIRequestContext, workflowId: string) {
  // ADR 0812 P3c — the /v1 path space is gone; the v2 route returns the same stored definition.
  const res = await ctx.get(`/api/workflows/${encodeURIComponent(workflowId)}`, { headers: { 'OpenWOP-Version': '2' } });
  expect(res.status()).toBe(200);
  return (await res.json()) as { nodes?: Array<{ nodeId: string; inputs?: Record<string, unknown> }> };
}

test.describe('ADR 0524 Phase E — preset inputs, through a browser', () => {
  test.slow();
  // CT-E1 measures text WIDTH, so it needs the real Geist faces. The config
  // fails the Google Fonts hosts fast (E2E-ORDER-1); serve the vendored copies.
  test.beforeEach(async ({ page }) => { await serveFontsLocally(page); });

  /**
   * History (2026-08-06): this case once failed for real. The client saved
   * correctly, but `x-openwop-field-contract` made the save a PREFLIGHTED
   * cross-origin request and the header was missing from
   * `Access-Control-Allow-Headers`, so the browser blocked every builder save.
   * Fixed in `middleware/cors.ts`.
   *
   * In the merge gate the SPA calls same-origin `/api` (scripts/ci.sh), so NO
   * preflight happens here and this case cannot see that CORS defect; it is
   * pinned by `backend/typescript/test/cors-field-contract-header.test.ts`. What
   * this case guards is the client save plus the server's deletion contract:
   * the save DECLARES the field contract and omits the cleared input, and the
   * head stays cleared after a reload.
   *
   * Sabotage-witnessed (wave 53): Clear not removing the input (CT-E2, CT-E4);
   * the field-contract header dropped from the builder save (CT-E2, sole-input
   * fixture); the value's accessible name broken (all three).
   */
  test('CT-E2: clearing the last preset input SURVIVES a save and reload', async ({ page, context }) => {
    const id = `phase-e-ct-${Date.now()}`;
    await loginPersonal(context.request, 'phase-e@e2e.test');
    // SOLE input-carrying node: the case the field-contract header exists for.
    await seedWorkflow(context.request, id, { withRef: false });

    // PRECONDITION, asserted rather than assumed: the seed really did persist an
    // input. Without this the "it stayed cleared" assertion below could pass
    // against a workflow that never had one.
    const before = await readHead(context.request, id);
    expect(before.nodes?.find((n) => n.nodeId === 'only')?.inputs, 'the seed did not persist inputs').toEqual({
      to: 'someone@example.com',
    });

    // Watch the SAVE traffic. "Did it stay cleared?" has two very different
    // causes when it fails — the client never saved, or the server restored it —
    // and only the request stream distinguishes them.
    type SavedBody = { workflowId?: string; nodes?: Array<{ nodeId: string; inputs?: Record<string, unknown> }> };
    const parseSave = (raw: string | null): SavedBody => {
      try { return JSON.parse(raw ?? '{}') as SavedBody; } catch { return {}; }
    };
    const isCleared = (inputs: Record<string, unknown> | undefined): boolean => inputs === undefined || Object.keys(inputs).length === 0;
    const saves: Array<{ hasContract: boolean; savedAs: string | undefined; nodeIds: string[]; inputs: Record<string, unknown> | undefined }> = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST' || new URL(req.url()).pathname !== '/api/host/openwop-app/workflows') return;
      const body = parseSave(req.postData());
      saves.push({
        hasContract: Boolean(req.headers()['x-openwop-field-contract']),
        savedAs: body.workflowId,
        nodeIds: (body.nodes ?? []).map((n) => n.nodeId),
        inputs: body.nodes?.find((n) => n.nodeId === 'only')?.inputs,
      });
    });

    await page.goto(`/builder/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    // Wait for the canvas to have rendered a node rather than for a fixed
    // duration — the thing every assertion below depends on.
    await page.locator('.builder-node').first().waitFor({ state: 'visible', timeout: 20_000 });

    // Select the node that carries the editable input.
    // `.builder-node` is the canvas node element (BaseNode.tsx). Selecting the
    // FIRST one is deliberate: the seed's edge makes the ordering deterministic,
    // and a text-based selector would match the Inspector too.
    await page.locator('.builder-node').first().click();

    // Select by ACCESSIBLE LABEL, not by value. `getByDisplayValue` is a
    // Testing Library API and does not exist on a Playwright page — and using
    // the label here doubles as proof that the visually-hidden label added in
    // Phase E actually names the control in a real browser, which jsdom cannot
    // establish.
    const { value, clear } = presetRow(page);
    await expect(value, 'the preset-input field never rendered in the builder').toBeVisible({ timeout: 10_000 });

    await clear.click();
    await expect(value).toHaveCount(0);

    // WAIT ON THE EVENT, NOT THE CLOCK. This was `waitForTimeout(8000)`, which
    // is both slow and a flake generator: too short on a loaded CI box and the
    // test fails for a reason that has nothing to do with the behaviour. The
    // autosave is a 1.5s debounce, so wait for the SAVE RESPONSE itself — and
    // for THIS workflow's save that no longer carries the input, not any POST.
    await page.waitForResponse(
      (r) => {
        if (r.request().method() !== 'POST' || new URL(r.url()).pathname !== '/api/host/openwop-app/workflows' || r.status() !== 201) return false;
        const body = parseSave(r.request().postData());
        const node = body.nodes?.find((n) => n.nodeId === 'only');
        return body.workflowId === id && !!node && isCleared(node.inputs);
      },
      { timeout: 15_000 },
    );

    // The client side of the contract, asserted rather than logged: the clearing
    // save targeted THIS workflow, kept the node ids, sent no input for `only`,
    // and DECLARED the field contract (without it the server restores the input).
    const clearing = saves.filter((s) => s.savedAs === id && s.nodeIds.includes('only') && isCleared(s.inputs));
    expect(clearing.length, `no clearing save observed: ${JSON.stringify(saves)}`).toBeGreaterThanOrEqual(1);
    expect(clearing.every((s) => s.hasContract), `a clearing save omitted x-openwop-field-contract: ${JSON.stringify(clearing)}`).toBe(true);
    expect([...clearing[0]!.nodeIds].sort()).toEqual(['only', 'plain']);

    await page.reload({ waitUntil: 'domcontentloaded' });

    const after = await readHead(context.request, id);
    // eslint-disable-next-line no-console
    console.log(`[CT-E2] head nodes now: ${JSON.stringify(after.nodes?.map((n) => ({ id: n.nodeId, inputs: n.inputs })))}`);
    const inputs = after.nodes?.find((n) => n.nodeId === 'only')?.inputs;
    expect(
      inputs === undefined || Object.keys(inputs).length === 0,
      `the cleared preset input came back from the server as ${JSON.stringify(inputs)}`,
    ).toBe(true);
  });

  test('CT-E4: the value and Clear are reachable and operable by KEYBOARD alone', async ({ page, context }) => {
    const id = `phase-e-kb-${Date.now()}`;
    await loginPersonal(context.request, 'phase-e-kb@e2e.test');
    await seedWorkflow(context.request, id);

    await page.goto(`/builder/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.builder-node').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('.builder-node').first().click();

    const { value, clear } = presetRow(page);
    await expect(value).toBeVisible({ timeout: 10_000 });

    // Focus the field directly, type, then TAB to the next control and confirm
    // it is THIS row's Clear button — a control reachable only by mouse is a
    // keyboard trap in the middle of an editing flow. (This used to check that
    // the focused element's text contained "clear", which any control did.)
    await value.focus();
    await value.fill('typed@example.com');
    await page.keyboard.press('Tab');
    await expect(clear, 'Tab from the value did not reach its Clear button').toBeFocused();

    await page.keyboard.press('Enter');
    await expect(value).toHaveCount(0);
  });

  test('CT-E1: the value is not TRUNCATED by its own column at 1280px', async ({ page, context }) => {
    // The failure this pins was found by LOOKING at a screenshot:
    // `someone@example.com` rendered as `someone@examp`. jsdom has no layout, so
    // no unit test can see it — but "someone must look at the picture" is not a
    // check, so the geometry is asserted directly.
    //
    // scrollWidth > clientWidth is the browser's own statement that the content
    // does not fit the box. Comparing rendered TEXT would not work: the value is
    // intact in the DOM, it is the visible box that is too small.
    const id = `phase-e-w-${Date.now()}`;
    await loginPersonal(context.request, 'phase-e-w@e2e.test');
    await seedWorkflow(context.request, id);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/builder/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.builder-node').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('.builder-node').first().click();

    const { value } = presetRow(page);
    await expect(value).toHaveValue('someone@example.com', { timeout: 10_000 });

    // Two independent measurements, both required: the browser's own overflow
    // statement (scrollWidth > clientWidth) AND the rendered text's width in the
    // input's computed font against the content box. Wave 53 found the original
    // regression (the 1fr/2fr row grid) no longer truncates at 1280px — layout
    // around it changed — so the case must not rely on one signal whose
    // semantics for <input> it never proved.
    const fits = await value.evaluate((el) => {
      const i = el as HTMLInputElement;
      const cs = getComputedStyle(i);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.font = cs.font;
      const content = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { scrollWidth: i.scrollWidth, clientWidth: i.clientWidth, text: Math.ceil(ctx.measureText(i.value).width), content: Math.floor(content), value: i.value };
    });
    expect(
      fits.scrollWidth,
      `the value box is too narrow for its own content (${fits.value}): scrollWidth ${fits.scrollWidth} > clientWidth ${fits.clientWidth}`,
    ).toBeLessThanOrEqual(fits.clientWidth);
    expect(
      fits.text,
      `the value's text (${fits.text}px) is wider than the box's content area (${fits.content}px): ${fits.value} is clipped`,
    ).toBeLessThanOrEqual(fits.content);
  });

  // ── Screenshots for the judgements an assertion cannot make ───────────────
  //
  // OPT-IN. These six produce real evidence — they are how the truncated-value
  // defect (`someone@examp`) and the 360px "canvas needs a larger screen"
  // degradation were both found — but they assert NOTHING by design, so they can
  // never go red. Six browser sessions of CI wall-clock on every run, for a
  // result nobody reads unless they went looking.
  //
  // Gated on the `CT_SHOT_DIR` seam (collab-ct.spec.ts used it too until it
  // was deleted 2026-10-17), rather than inventing a second flag: one opt-in
  // mechanism for "capture surfaces for a human", and the shot directory is the
  // caller's rather than a hardcoded path.
  //
  //   CT_SHOT_DIR=/tmp/phase-e npx playwright test preset-inputs-clickthrough
  //
  // The three ASSERTING tests above (CT-E2 save/reload, CT-E4 keyboard, CT-E1
  // geometry) stay in the default lane — they can fail, so they earn their run.
  test.describe('visual capture (opt-in)', () => {
    test.skip(!SHOT_DIR, 'visual capture — set CT_SHOT_DIR to run');
    for (const [label, width, height] of [['360', 360, 780], ['768', 768, 900], ['1280', 1280, 900]] as const) {
      for (const theme of ['light', 'dark'] as const) {
        test(`CT-E1/E3/E5 capture: ${width}px ${theme}`, async ({ page, context }) => {
        const id = `phase-e-shot-${width}-${theme}-${Date.now()}`;
        await loginPersonal(context.request, `phase-e-shot-${width}-${theme}@e2e.test`);
        await seedWorkflow(context.request, id);
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(`/builder/${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' });
        // A capture must never FAIL on a wait — it records what it could reach.
        await page.locator('.builder-node').first()
          .waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
        // At 360px the canvas may place the node outside the viewport, and a
        // strict click would HANG rather than tell you that. A capture test must
        // never be the thing that fails the run — it exists to produce evidence,
        // so it records what it could reach and screenshots regardless.
        const node = page.locator('.builder-node').first();
        const reachable = await node.isVisible().catch(() => false);
        if (reachable) await node.click({ timeout: 5_000 }).catch(() => {});
        // Settle on signals, not a sleep: fonts loaded, then two animation frames.
        await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
        await page.screenshot({ path: `${SHOT_DIR}/phase-e-${label}-${theme}.png`, fullPage: false });
        // eslint-disable-next-line no-console
        console.log(`[capture ${label}/${theme}] canvas node reachable: ${reachable}`);
        // No assertion: this test exists to PRODUCE evidence, and saying so is
        // more honest than a `toBeTruthy()` that implies it verified something.
        });
      }
    }
  });
});
