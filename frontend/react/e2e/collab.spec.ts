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
 * QUARANTINED TO THE SERIAL PASS, not skipped (ADR 0509 Phase 2) — and that pass is
 * ADVISORY: `scripts/ci.sh` runs it and ledgers the result but IGNORES its exit, so
 * a red here never blocks a merge. Measured (grade-tests wave 53): green in the
 * round-1 baseline run alone, then red in all 3 runs alone after this wave's edit
 * AND in a run of the unedited spec — always at "B's work survives A's undo" (the
 * `beta replied` check AFTER A's Ctrl+Z), never at the B→A sync before it, which
 * passes. So B's text reaches A and then leaves A's document on A's undo. Open as
 * E2E-ORDER-1 (owner: the openwop-app-8f session). Ceiling: a browser claim (two live WebSocket clients against the
 * real backend room) in an advisory lane — making it blocking is an ADR 0509
 * decision, not a test edit.
 *
 * What only this spec covers (sabotage-witnessed, wave 53): the Mod-z keymap in
 * `collabExtension.ts` (`'Mod-z': () => false` → red; `collabExtension.test.ts` has
 * no keyboard case), the shared WebSocket room (a per-client room name in
 * `useCollab.ts` → red), and awareness reaching the other client (hiding
 * `.cv-presence__peer` → red; the render alone is also `CollabPresence.test.tsx`'s).
 *
 * Correction 2026-10-27: the old "parallelism artifact, not a product defect"
 * claim was too strong (already retracted in ADR 0509 on 2026-08-02). The exact
 * `bet replieda` undo corruption reproduces in two synchronous production-schema
 * editors without a browser/network. See docs/steward/COLLAB-UNDO-INVESTIGATION.md.
 * #2746 fixed a separate deep-link defect; it did not establish undo correctness.
 *
 * `@serial` moves it out of `npm run test:e2e` (which is `--grep-invert @serial`)
 * and into `npm run test:e2e:serial` (`--workers=1`). It therefore STILL RUNS on
 * every full lane pass — as an advisory result (above).
 *
 * Deliberately NOT another `test.skip`: several specs already skip behind opt-in
 * env vars (see `e2e/README.md` § "What's quarantined"), and this lane's coverage is
 * measurably overstated by its file count (`docs/steward/CODEBASE-ASSESSMENT.md`,
 * `E2E-2`). Quarantine that stops a test executing is indistinguishable from
 * deletion after a few months.
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
    // Correction 2026-10-27: this check only establishes the end of one DOM node,
    // not the end of the editor. Prepending also exposes a real repeated-character
    // attribution bug: complete text syncs, then another author's undo mangles it.
    // Preserve the assertions below; moving the caret alone would not repair that
    // product defect. See docs/steward/COLLAB-UNDO-INVESTIGATION.md.
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
    // Each Ctrl+Z is followed by a wait on its EFFECT (the document text changed),
    // not a fixed sleep: y-prosemirror groups typing into undo steps, so the number
    // of presses is bounded (6) but not known, and a press is only "done" once the
    // doc moved. A dead keymap (the Phase 7 finding) fails that wait on the first press.
    await edA.click();
    for (let i = 0; i < 6; i++) {
      const before = await docText(edA);
      if (!before.includes('alpha wrote this')) break;
      await pageA.keyboard.press('ControlOrMeta+z');
      await expect
        .poll(() => docText(edA), { message: `Ctrl+Z #${i + 1} did not change A's document`, timeout: 5_000 })
        .not.toBe(before);
    }
    await expectDocText(edA, 'alpha wrote this', false);
    await expectDocText(edA, 'beta replied', true); // B's work survives A's undo
    await expectDocText(edB, 'alpha wrote this', false);

    await ctxA.close();
    await ctxB.close();
  });
});
