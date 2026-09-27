/**
 * CT-COLLAB-1 visual pass (ADR 0359) — NOT part of the CI suites; a screenshot
 * harness for the live click-through checklist run on demand. Two browser
 * contexts co-edit, capturing light + dark evidence of: remote caret + name
 * flag in the document editor, scene peer outline + flag on a drawing, and
 * co-selection flag stacking. Screenshots land in CT_SHOT_DIR — setting that
 * env var is also what opts the harness in; without it every test skips, so
 * the CI e2e sweep never pays for it.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { login, enableToggle, API } from './support/session';

const SHOTS = process.env.CT_SHOT_DIR ?? '';

test.skip(!SHOTS, 'CT visual harness — set CT_SHOT_DIR to run');

async function setupTenant(browser: Browser, scheme: 'light' | 'dark') {
  const tenantId = `org:ct-${scheme}-${Date.now()}`;
  const ctxA = await browser.newContext({ colorScheme: scheme });
  await login(ctxA.request, `ana-${scheme}@ct.test`, tenantId);
  for (const id of ['realtime-collab', 'document-editor', 'drawings']) {
    expect(await enableToggle(ctxA.request, id)).toBe(true);
  }
  const orgId = ((await (await ctxA.request.post(`${API}/orgs`, { data: { name: 'CT Org' } })).json()) as { orgId: string }).orgId;
  const ctxB = await browser.newContext({ colorScheme: scheme });
  const bId = await login(ctxB.request, `bogdan-${scheme}@ct.test`, tenantId);
  await ctxA.request.post(`${API}/orgs/${orgId}/members`, { data: { displayName: 'Bogdan', subject: bId, roles: ['editor'] } });
  return { ctxA, ctxB, orgId };
}

async function openAndLive(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('.cv-presence__live')).toBeVisible({ timeout: 30_000 });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`CT visuals — ${scheme}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const { ctxA, ctxB, orgId } = await setupTenant(browser, scheme);

    // ── Document: remote caret + name flag ─────────────────────────────────
    const doc = await ctxA.request.post(`${API}/document-editor/orgs/${orgId}/canvases`, { data: { name: 'CT doc' } });
    const docId = ((await doc.json()) as { canvasId: string }).canvasId;
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await openAndLive(pageA, `/document-editor/${docId}`);
    await openAndLive(pageB, `/document-editor/${docId}`);
    const edA = pageA.locator('.doc-editor__content');
    const edB = pageB.locator('.doc-editor__content');
    await edA.click();
    await pageA.keyboard.type('Ana is typing here so Bogdan sees a caret.');
    await expect(edB).toContainText('Ana is typing', { timeout: 15_000 });
    await edB.click();
    await pageB.keyboard.press('ControlOrMeta+End');
    await pageB.keyboard.type(' Bogdan replies.');
    await expect(edA).toContainText('Bogdan replies', { timeout: 15_000 });
    // A selects a range so B sees a colored selection too.
    await edA.click();
    await pageA.keyboard.press('Home');
    for (let i = 0; i < 10; i++) await pageA.keyboard.press('Shift+ArrowRight');
    await pageB.waitForTimeout(800); // let awareness/caret decorations settle
    await pageB.screenshot({ path: `${SHOTS}/doc-caret-${scheme}.png`, fullPage: false });

    // ── Drawing: scene outline + flag, then co-selection stacking ──────────
    const draw = await ctxA.request.post(`${API}/drawings/orgs/${orgId}/canvases`, { data: { name: 'CT drawing' } });
    const drawId = ((await draw.json()) as { canvasId: string }).canvasId;
    const dA = await ctxA.newPage();
    const dB = await ctxB.newPage();
    await openAndLive(dA, `/drawings/${drawId}`);
    await openAndLive(dB, `/drawings/${drawId}`);
    // B selects the seeded rect in the scene → A shows B's outline + flag.
    const sceneB = dB.locator('.cv-draw-interactive__svg');
    await expect(sceneB).toBeVisible({ timeout: 15_000 });
    await sceneB.locator('.cv-draw-interactive__hit').first().click({ force: true });
    await expect(dA.locator('.cv-peer-outlines')).toBeVisible({ timeout: 15_000 });
    await dA.screenshot({ path: `${SHOTS}/drawing-outline-${scheme}.png` });
    // A selects the SAME rect → B sees A's outline; A sees B's. Co-selection
    // stacking shows on whichever page renders a peer flag near its own chrome.
    const sceneA = dA.locator('.cv-draw-interactive__svg');
    await sceneA.locator('.cv-draw-interactive__hit').first().click({ force: true });
    await dB.waitForTimeout(800);
    await dB.screenshot({ path: `${SHOTS}/drawing-coselect-${scheme}.png` });

    await ctxA.close();
    await ctxB.close();
  });
}
