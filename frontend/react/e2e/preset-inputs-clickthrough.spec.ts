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
import { test, expect, type APIRequestContext } from '@playwright/test';

const API = '/api/v1/host/openwop-app';

/** Same opt-in seam `collab-ct.spec.ts` uses for its visual harness. */
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
 * `to` is a plain string (editable); `topic` is an RFC 0124 variable ref
 * (read-only) so both branches of the Inspector render in one page.
 */
async function seedWorkflow(ctx: APIRequestContext, workflowId: string): Promise<void> {
  const res = await ctx.post(`${API}/workflows`, {
    data: {
      workflowId,
      metadata: { name: 'Phase E click-through' },
      nodes: [
        {
          nodeId: 'only',
          typeId: 'core.noop',
          config: {},
          inputs: { to: 'someone@example.com' },
        },
        {
          nodeId: 'refnode',
          typeId: 'core.noop',
          config: {},
          inputs: { topic: { type: 'variable', variableName: 'topic' } },
        },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'only', targetNodeId: 'refnode' }],
      variables: [{ name: 'topic', type: 'string' }],
    },
  });
  expect(res.status(), `seed ${workflowId}: ${await res.text()}`).toBe(201);
}

async function readHead(ctx: APIRequestContext, workflowId: string) {
  const res = await ctx.get(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { nodes?: Array<{ nodeId: string; inputs?: Record<string, unknown> }> };
}

test.describe('ADR 0524 Phase E — preset inputs, through a browser', () => {
  test.slow();

  /**
   * §Correction — this was quarantined as failing, and the failure WAS real.
   * Diagnosed and fixed: see `middleware/cors.ts`. Kept verbatim below because
   * the evidence is the reason the bug was findable at all.
   *
   * MEASURED against a real backend + Chromium (2026-08-06). The client does
   * everything correctly:
   *   - one POST to `/host/openwop-app/workflows` is sent after the clear;
   *   - it carries `x-openwop-field-contract` (so the ADR 0524 guard must treat
   *     the omission as a deletion, not a bundle limitation);
   *   - it targets the RIGHT workflowId and the right node ids
   *     (`["only","refnode"]` — no re-minting);
   *   - node `only` is sent with NO `inputs`.
   * And 8 seconds later the server head still reads
   *   `only.inputs = {to: 'someone@example.com'}`.
   *
   * The server guard is NOT the cause: it fires only on a WHOLE-SET omission,
   * and `refnode` still carries `topic`, so `nodesCarryingInputs(next) === 1`.
   *
   * DIAGNOSED: `net::ERR_FAILED` on the POST while GETs to the same origin
   * returned 200 — the signature of a CORS PREFLIGHT rejection, not an
   * application error. `x-openwop-field-contract` (added in Phase E0) is a
   * custom request header, so it makes the save a preflighted request, and it
   * was missing from `Access-Control-Allow-Headers`. The browser blocked every
   * builder save cross-origin, with no server-side trace because the request
   * never arrived. Fixed in `middleware/cors.ts`; pinned by
   * `test/cors-field-contract-header.test.ts`.
   *
   * Why this is quarantined rather than deleted or softened: it reproduces, it
   * asserts exactly the behaviour the ADR 0523/0524/0525 program exists to
   * deliver, and the store-level tests cannot see it. Deleting it would restore
   * the false confidence that shipped Phase E.
   */
  test('CT-E2: clearing the last preset input SURVIVES a save and reload', async ({ page, context }) => {
    const id = `phase-e-ct-${Date.now()}`;
    await loginPersonal(context.request, 'phase-e@e2e.test');
    await seedWorkflow(context.request, id);

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
    const saves: Array<{ hasContract: boolean; savedAs: string | undefined; nodeIds: string[]; inputs: unknown }> = [];
    page.on('request', (req) => {
      if (req.method() !== 'POST' || !req.url().includes('/host/openwop-app/workflows')) return;
      let body: { nodes?: Array<{ nodeId: string; inputs?: unknown }> } = {};
      try { body = JSON.parse(req.postData() ?? '{}'); } catch { /* non-JSON */ }
      saves.push({
        hasContract: Boolean(req.headers()['x-openwop-field-contract']),
        savedAs: (body as { workflowId?: string }).workflowId,
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
    const value = page.getByLabel(/value for the .*to.* input/i);
    await expect(value, 'the preset-input field never rendered in the builder').toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /clear/i }).first().click();
    await expect(value).toHaveCount(0);

    // WAIT ON THE EVENT, NOT THE CLOCK. This was `waitForTimeout(8000)`, which
    // is both slow and a flake generator: too short on a loaded CI box and the
    // test fails for a reason that has nothing to do with the behaviour. The
    // autosave is a 1.5s debounce, so wait for the SAVE RESPONSE itself.
    await page.waitForResponse(
      (r) => r.request().method() === 'POST'
        && r.url().includes('/host/openwop-app/workflows')
        && r.status() === 201,
      { timeout: 15_000 },
    );
    await page.reload({ waitUntil: 'domcontentloaded' });

    // eslint-disable-next-line no-console
    console.log(`[CT-E2] saves observed: ${JSON.stringify(saves)}`);

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

    const value = page.getByLabel(/value for the .*to.* input/i);
    await expect(value).toBeVisible({ timeout: 10_000 });

    // Focus the field directly, type, then TAB to the next control and confirm
    // it is the Clear button — a control reachable only by mouse is a keyboard
    // trap in the middle of an editing flow.
    await value.focus();
    await value.fill('typed@example.com');
    await page.keyboard.press('Tab');
    const focusedText = await page.evaluate(() => document.activeElement?.textContent ?? '');
    expect(focusedText.toLowerCase(), 'Tab from the value did not reach Clear').toContain('clear');

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

    const value = page.getByLabel(/value for the .*to.* input/i);
    await expect(value).toBeVisible({ timeout: 10_000 });

    const fits = await value.evaluate((el) => {
      const i = el as HTMLInputElement;
      return { scrollWidth: i.scrollWidth, clientWidth: i.clientWidth, value: i.value };
    });
    expect(
      fits.scrollWidth,
      `the value box is too narrow for its own content (${fits.value}): scrollWidth ${fits.scrollWidth} > clientWidth ${fits.clientWidth}`,
    ).toBeLessThanOrEqual(fits.clientWidth);
  });

  // ── Screenshots for the judgements an assertion cannot make ───────────────
  //
  // OPT-IN. These six produce real evidence — they are how the truncated-value
  // defect (`someone@examp`) and the 360px "canvas needs a larger screen"
  // degradation were both found — but they assert NOTHING by design, so they can
  // never go red. Six browser sessions of CI wall-clock on every run, for a
  // result nobody reads unless they went looking.
  //
  // Gated on the SAME `CT_SHOT_DIR` seam `collab-ct.spec.ts` already uses for
  // its visual harness, rather than inventing a second flag: one opt-in
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
        await page.waitForTimeout(600);
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
