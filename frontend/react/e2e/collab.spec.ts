/**
 * ADR 0359 Phase 7 — the two-client live-collaboration e2e gate (the ADR 0335
 * enable-gate the unit suites cannot cover: a REAL WebsocketProvider against
 * the REAL backend room). Two browser contexts (two users, one tenant, one
 * org) co-edit a `canvas.document`:
 *   - live sync both directions;
 *   - the presence cluster (Live chip; a peer avatar on each side);
 *   - per-user undo (A's Ctrl+Z removes A's text, never B's).
 *
 * Backend boot (same seams as the sibling specs):
 *   OPENWOP_TEST_AUTH_ENABLED=true OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
 *   OPENWOP_STORAGE_DSN=memory:// OPENWOP_CORS_ORIGINS=http://localhost:5173 \
 *   OPENWOP_SESSION_SECRET=dev-session-secret-at-least-32-characters-long \
 *   node backend/typescript/lib/index.js
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { login, enableToggle, API } from './support/session';

/**
 * QUARANTINED TO THE SERIAL PASS, not skipped (ADR 0509 Phase 2).
 *
 * This spec passes ALONE in ~3.3s and fails under `--workers=2`: it drives two
 * live browser clients through a real WebSocket, and under concurrent machine
 * load their sync assertions miss. That is a parallelism artifact, not a product
 * defect — #2746 fixed the actual breakage (a canvas deep link stopped resolving
 * when #2718 made `?org=` required).
 *
 * `@serial` moves it out of `npm run test:e2e` (which is `--grep-invert @serial`)
 * and into `npm run test:e2e:serial` (`--workers=1`). It therefore STILL RUNS on
 * every full lane pass.
 *
 * Deliberately NOT a fifth `test.skip`: 4 of 13 specs already skip behind opt-in
 * env vars, and this lane's coverage is measurably overstated by its file count
 * (`docs/steward/CODEBASE-ASSESSMENT.md`, `E2E-2`). Quarantine that stops a test
 * executing is indistinguishable from deletion after a few months.
 *
 * The tag is declared via Playwright's TAG OPTION, not by embedding "@serial" in
 * the describe title. `--grep` matches both, but a title-embedded tag disappears
 * the moment someone renames the describe — and the failure mode is this spec
 * silently rejoining the PARALLEL pass and flaking again, with nothing pointing
 * at the rename as the cause.
 */
test.describe('realtime canvas collaboration (ADR 0359)', { tag: '@serial' }, () => {
  test('two clients co-edit a document: sync, presence, per-user undo', async ({ browser }) => {
    test.setTimeout(120_000);
    const tenantId = `org:collab-e2e-${Date.now()}`;

    // ── User A: login, enable both toggles, create the org + document ───────
    const ctxA = await browser.newContext();
    await login(ctxA.request, 'alpha@e2e.test', tenantId);
    expect(await enableToggle(ctxA.request, 'realtime-collab')).toBe(true);
    expect(await enableToggle(ctxA.request, 'document-editor')).toBe(true);
    const orgRes = await ctxA.request.post(`${API}/orgs`, { data: { name: 'Collab E2E' } });
    expect(orgRes.ok()).toBe(true);
    const orgId = ((await orgRes.json()) as { orgId: string }).orgId;
    const created = await ctxA.request.post(`${API}/document-editor/orgs/${orgId}/canvases`, { data: { name: 'Live doc' } });
    expect(created.status(), await created.text()).toBe(201);
    const canvasId = ((await created.json()) as { canvasId: string }).canvasId;

    // ── User B: same tenant, org member with write ───────────────────────────
    const ctxB = await browser.newContext();
    const bUserId = await login(ctxB.request, 'beta@e2e.test', tenantId);
    const addB = await ctxA.request.post(`${API}/orgs/${orgId}/members`, {
      data: { displayName: 'Beta', subject: bUserId, roles: ['editor'] },
    });
    expect(addB.ok(), await addB.text()).toBe(true);

    // ── Both open the editor; the chassis provisions the collab session ─────
    const open = async (page: Page): Promise<void> => {
      // `?org=` is REQUIRED since #2718 (GC-AB-1). A canvas link that does not
      // name its org used to silently open `orgs[0]`; it now renders
      // `CanvasOrgGate`'s "pick the workspace" notice when the caller belongs to
      // more than one — and both users here are in their own workspace AND the
      // org this spec creates. Guessing was the bug, so the LINK carries the org,
      // exactly as the app's own generated links do (`resolveCanvasOrg(orgs,
      // search.get('org'))`, `canvas/CanvasEditorPage.tsx:296`).
      await page.goto(`/document-editor/${canvasId}?org=${orgId}`);
      await expect(page.locator('.doc-editor__content')).toBeVisible({ timeout: 30_000 });
      // The Live chip = the session is provisioned + connected.
      await expect(page.locator('.cv-presence__live')).toBeVisible({ timeout: 30_000 });
    };
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await open(pageA);
    await open(pageB);

    const edA = pageA.locator('.doc-editor__content');
    const edB = pageB.locator('.doc-editor__content');

    // The DOCUMENT text, with remote-caret widgets stripped. y-prosemirror
    // injects each peer's flag (`.ProseMirror-yjs-cursor` > "Guest NNNN") as a
    // DOM node WHEREVER that peer's caret sits — including mid-word — so a raw
    // toContainText can read "bet⁠[Guest 5667]⁠a replied" and fail on text the
    // document actually contains (observed 2026-08-14 under suite load).
    const docText = (ed: Locator): Promise<string> => ed.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.ProseMirror-yjs-cursor').forEach((n) => n.remove());
      return clone.textContent ?? '';
    });
    const expectDocText = (ed: Locator, needle: string, present: boolean): Promise<void> =>
      expect.poll(async () => (await docText(ed)).includes(needle), {
        message: `document text should ${present ? 'contain' : 'not contain'} ${JSON.stringify(needle)}`,
        timeout: 15_000,
      }).toBe(present);

    // ── A types; B receives ──────────────────────────────────────────────────
    await edA.click();
    await pageA.keyboard.type('alpha wrote this');
    await expectDocText(edB, 'alpha wrote this', true);

    // ── Presence: each side sees ONE peer avatar ────────────────────────────
    await expect(pageA.locator('.cv-presence__peer')).toHaveCount(1, { timeout: 15_000 });
    await expect(pageB.locator('.cv-presence__peer')).toHaveCount(1, { timeout: 15_000 });

    // ── B replies on its own paragraph; A receives ──────────────────────────
    //
    // The caret precondition is ASSERTED, not assumed. Under CPU starvation a
    // keypress can land before the preceding `click`'s selection has reached
    // ProseMirror, so `ControlOrMeta+End` acts on a stale selection and the
    // caret stays at offset 0. `Enter` then splits an empty paragraph off the
    // TOP and B types IN FRONT of A's text, giving
    // `<p></p><p>beta replied…alpha wrote this</p>` — and the later per-user-undo
    // assertion fails with a mangled `bet replieda`.
    //
    // MEASURED 2026-08-09: 0 failures / 8 runs at rest, 1 / 4 under artificial
    // load — and inserting two `page.evaluate()` probes between the click and the
    // keypress made it pass 4/4, i.e. the delay itself was the fix. That
    // Heisenbug is why this is a WAIT, not a retry.
    //
    // This does NOT make the spec load-proof (see ADR 0509 Phase 2 — it drives
    // two live WebSocket clients and is advisory for that reason). It removes ONE
    // specific race, and it stops the failure PRESENTING as a CRDT/undo defect:
    // chasing that reading cost a full investigation, including reading
    // y-prosemirror internals, before the data said the corruption predates the
    // undo entirely.
    await edB.click();
    await pageB.keyboard.press('ControlOrMeta+End');
    await expect
      .poll(async () => pageB.evaluate(() => {
        const sel = window.getSelection();
        const node = sel?.anchorNode;
        return node?.textContent != null && sel != null
          ? sel.anchorOffset === node.textContent.length
          : false;
      }), {
        message: 'B\'s caret never reached the end of its line — ControlOrMeta+End '
          + 'landed before the click\'s selection was applied (see the note above)',
        timeout: 5_000,
      })
      .toBe(true);
    await pageB.keyboard.press('Enter');
    await pageB.keyboard.type('beta replied');
    await expectDocText(edA, 'beta replied', true);

    // ── Per-user undo: A's undo removes only A's text ───────────────────────
    await edA.click();
    for (let i = 0; i < 6; i++) {
      if (!(await docText(edA)).includes('alpha wrote this')) break;
      await pageA.keyboard.press('ControlOrMeta+z');
      await pageA.waitForTimeout(200);
    }
    await expectDocText(edA, 'alpha wrote this', false);
    await expectDocText(edA, 'beta replied', true); // B's work survives A's undo
    await expectDocText(edB, 'alpha wrote this', false);

    await ctxA.close();
    await ctxB.close();
  });
});
