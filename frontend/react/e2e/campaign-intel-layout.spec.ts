import { test, expect, type APIRequestContext, type Locator, type TestInfo } from '@playwright/test';
import { isDeepStrictEqual } from 'node:util';
import { API } from './support/session.js';
import { serveFontsLocally } from './support/localFonts.js';
import type { AdAngle, CampaignBrief, Hook, TargetingPack, VocEvidence } from '../src/features/campaign-brief/campaignBriefClient.js';

test.use({ screenshot: 'on' });

// LOCAL ONLY. Before running, the owner must admit a fresh memory backend,
// test auth + dev toggle administration, same-origin /api, no external keys,
// real-recipient adapters or pre-existing event/workflow bindings. Real brief
// creation records audit and can emit a host event; a loopback URL alone does
// not prove that backend environment. No provider/run/publication action here.
const LONG_AUDIENCE = 'QA plan teams compare trusted product details before choosing practical tools for shared work across growing groups with clear goals useful guidance steady support and simple daily review habits today';
const SECOND_AUDIENCE = 'QA plan teams compare trusted product details before choosing basic tools for shared work across growing groups with clear goals useful guidance steady support and simple day review habits today';
const PREFIX = '/api/host/openwop-app/campaign-brief';
const NOW = '2026-11-18T00:00:00.000Z';
type AdminConfig = Record<string, unknown> & {
  id: string; revision: string | null; status: 'on' | 'off' | 'beta';
  tenantOverrides?: Record<string, unknown>;
};
type OwnedOverride = { id: string; previous: unknown; installed: Record<string, unknown> };

function localOrigin(info: TestInfo): string {
  const raw = info.project.use.baseURL;
  if (typeof raw !== 'string') throw new Error('Fixture admission: absolute local baseURL required');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Fixture admission: deployed and non-loopback targets are forbidden');
  }
  return url.origin;
}
// CI deliberately uses the owned backend directly for SSE; admit only this
// loopback read endpoint, never a general second HTTP origin or a write.
function localNotificationStream(): string {
  const raw = process.env.VITE_OPENWOP_SSE_BASE_URL;
  if (!raw) throw new Error('Fixture admission: explicit owned loopback SSE base required');
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    || u.username || u.password || !['/', '/api'].includes(u.pathname) || u.search || u.hash) {
    throw new Error('Fixture admission: only an explicit local SSE base is allowed');
  }
  return raw.replace(/\/$/, '') + '/host/openwop-app/notifications/stream';
}
async function readConfig(request: APIRequestContext, id: string): Promise<AdminConfig> {
  const r = await request.get(API + '/feature-toggles/admin/configs/' + id, { maxRedirects: 0 });
  expect(r.status(), 'Fixture admission: real superadmin config read: ' + await r.text()).toBe(200);
  const config: AdminConfig = await r.json();
  expect(config.id).toBe(id);
  expect(Object.prototype.hasOwnProperty.call(config, 'revision'), 'CAS revision must never be omitted').toBe(true);
  expect(config.revision === null || (typeof config.revision === 'string' && config.revision.length > 0)).toBe(true);
  expect(['on', 'off', 'beta']).toContain(config.status);
  return config;
}
async function changeOwnOverride(request: APIRequestContext, tenant: string,
  item: OwnedOverride, restore: boolean): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const config = await readConfig(request, item.id);
    const current = config.tenantOverrides?.[tenant];
    // Both may be absent before a setup PUT. Cleanup may also see the
    // original value when setup was refused; do not create a cleanup write.
    const desired = restore ? item.previous : item.installed;
    if (restore) {
      if (isDeepStrictEqual(current, item.previous)) return;
      expect(current, 'Do not overwrite another writer even in our unique tenant').toEqual(item.installed);
    } else expect(current).toEqual(item.previous);
    const tenantOverrides = { ...config.tenantOverrides };
    if (desired === undefined) delete tenantOverrides[tenant];
    else tenantOverrides[tenant] = desired;
    const put = await request.put(API + '/feature-toggles/admin/configs/' + item.id, {
      maxRedirects: 0, data: { ...config, tenantOverrides, revision: config.revision },
    });
    if (put.status() === 409 && (await readConfig(request, item.id)).revision !== config.revision) continue;
    expect(put.status(), 'Fixture admission/cleanup: CAS write: ' + await put.text()).toBe(200);
    expect((await readConfig(request, item.id)).tenantOverrides?.[tenant]).toEqual(desired);
    return;
  }
  throw new Error('Fixture admission/cleanup: six real CAS conflicts; no LWW fallback');
}
async function centerReaches(control: Locator): Promise<void> {
  // Center using normal document scrolling; nearest scrolling can leave a
  // partly visible control behind the fixed mobile navigation. Hit-testing stays required.
  await control.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await expect(control).toBeVisible();
  expect(await control.evaluate(el => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  }), 'Actual control center must be reachable').toBe(true);
}
async function measure(hub: Locator, info: TestInfo, phase: string) {
  const result = await hub.evaluate(root => {
    const box = root.getBoundingClientRect();
    const main = root.closest('main');
    if (!main) throw new Error('Actual Campaign Studio main absent');
    const m = main.getBoundingClientRect();
    const oversized = [...root.querySelectorAll('*')].flatMap(el => {
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || !r.width || !r.height
        || el.getAttribute('aria-hidden') === 'true'
        || el.classList.contains('sr-only') || el.classList.contains('visually-hidden')) return [];
      return r.left < box.left - 1 || r.right > box.right + 1
        ? [{ tag: el.tagName, className: el.getAttribute('class'), left: r.left, right: r.right }] : [];
    });
    return { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      viewport: innerWidth, scrollX, left: box.left, right: box.right,
      mainLeft: m.left, mainRight: m.right, oversized };
  });
  await info.attach(phase + '.json', { body: JSON.stringify(result), contentType: 'application/json' });
  return result;
}
function contained(m: Awaited<ReturnType<typeof measure>>): void {
  expect(m.documentWidth, 'Document width').toBeLessThanOrEqual(m.viewport + 1);
  expect(m.bodyWidth, 'Body width').toBeLessThanOrEqual(m.viewport + 1);
  expect(m.scrollX, 'Actual focus must not pan the document').toBe(0);
  expect(m.left).toBeGreaterThanOrEqual(m.mainLeft - 1);
  expect(m.right).toBeLessThanOrEqual(Math.min(m.mainRight, m.viewport) + 1);
  expect(m.oversized, 'Visible descendants must fit the available hub').toEqual([]);
}

test.describe('Owned local Campaign Intel containment', () => {
  test.describe.configure({ mode: 'serial' });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    for (const theme of ['light', 'dark'] as const) {
      test('Intel containment ' + viewport.width + 'x' + viewport.height + ' ' + theme, async ({ page }, info) => {
        const origin = localOrigin(info); // BEFORE login or any write.
        const notificationStream = localNotificationStream();
        const unique = viewport.width + '-' + theme + '-' + info.workerIndex + '-' + info.retry + '-' + Date.now();
        const login = await page.request.post(API + '/test/login', {
          maxRedirects: 0, data: { email: 'intel-' + unique + '@e2e.test' },
        });
        expect(login.status(), 'Fixture admission: real personal test cookie: ' + await login.text()).toBe(201);
        const identity: { user: { userId: string; tenantId: string } } = await login.json();
        const tenant = identity.user?.tenantId, userId = identity.user?.userId;
        if (typeof tenant !== 'string' || !tenant.startsWith('user:') || typeof userId !== 'string' || !userId) {
          throw new Error('Fixture admission: actual personal owner identity missing');
        }
        const changes: OwnedOverride[] = [];
        let orgId: string | undefined, briefId: string | undefined, before: unknown;
        let voc: VocEvidence[] = [], angles: AdAngle[] = [], hooks: Hook[] = [], packs: TargetingPack[] = [];
        const calls: string[] = [], unexpected: string[] = [], forbidden: string[] = [];
        // Reads other than these FOUR projections use the real local backend.
        // Block UI writes/foreign origins; the explicit owned loopback SSE GET is real.
        await page.route('**/*', async route => {
          const request = route.request(), u = new URL(request.url());
          if (request.method() === 'GET' && u.href === notificationStream) { await route.continue(); return; }
          if (u.origin !== origin || !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
            forbidden.push(request.method() + ' ' + u.origin + u.pathname);
            await route.abort('blockedbyclient'); return;
          }
          const own = briefId ? [
            PREFIX + '/briefs/' + briefId + '/voc', PREFIX + '/briefs/' + briefId + '/angles',
            PREFIX + '/briefs/' + briefId + '/targeting', PREFIX + '/hooks',
          ] : [];
          if (!own.includes(u.pathname)) { await route.continue(); return; }
          const keys = [...u.searchParams.keys()];
          let response: object | undefined;
          if (request.method() === 'GET') {
            if (u.pathname.endsWith('/voc') && keys.every(k => k === 'sentiment') && keys.length <= 1
              && ['', 'pain', 'desire', 'objection', 'praise'].includes(u.searchParams.get('sentiment') ?? '')) {
              response = { evidence: voc.filter(v => !u.searchParams.get('sentiment') || v.sentiment === u.searchParams.get('sentiment')) };
            } else if (u.pathname.endsWith('/angles') && keys.length === 0) response = { angles };
            else if (u.pathname.endsWith('/targeting') && keys.length === 0) response = { packs };
            else if (u.pathname.endsWith('/hooks') && keys.every(k => k === 'orgId' || k === 'status')
              && u.searchParams.getAll('orgId').length === 1 && u.searchParams.get('orgId') === orgId
              && u.searchParams.getAll('status').length <= 1
              && ['', 'candidate', 'tested', 'retired'].includes(u.searchParams.get('status') ?? '')) {
              response = { hooks: hooks.filter(h => !u.searchParams.get('status') || h.status === u.searchParams.get('status')) };
            }
          }
          if (!response) {
            unexpected.push(request.method() + ' ' + u.pathname + u.search);
            await route.fulfill({ status: 500, json: { error: 'Unexpected local Intel projection' } }); return;
          }
          calls.push(u.pathname + u.search);
          await route.fulfill({ status: 200, json: response });
        });
        await serveFontsLocally(page); // Vendored faces never reach the external network.
        // The shared font helper fulfills any method; retain the browser write fence.
        await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async route => {
          const request = route.request();
          if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { await route.fallback(); return; }
          const u = new URL(request.url());
          forbidden.push(request.method() + ' ' + u.origin + u.pathname);
          await route.abort('blockedbyclient');
        });
        try {
          await test.step('Admit real local owner, revision CAS, org/brief and current UI', async () => {
            for (const id of ['campaigns', 'campaign-brief']) {
              const previous = (await readConfig(page.request, id)).tenantOverrides?.[tenant];
              if (previous !== undefined && (previous === null || typeof previous !== 'object' || Array.isArray(previous))) {
                throw new Error('Fixture admission: malformed existing override');
              }
              const item = { id, previous, installed: { ...(previous as Record<string, unknown> | undefined), status: 'on' } };
              changes.push(item);
              await changeOwnOverride(page.request, tenant, item, false);
            }
            const assignmentsResponse = await page.request.get(API + '/feature-toggles/assignments', { maxRedirects: 0 });
            expect(assignmentsResponse.status()).toBe(200);
            const assignments: { caller: { tenantId: string }; assignments: Array<{ id: string; enabled: boolean }> } = await assignmentsResponse.json();
            expect(assignments.caller.tenantId).toBe(tenant);
            for (const id of ['campaigns', 'campaign-brief']) expect(assignments.assignments.find(a => a.id === id)?.enabled).toBe(true);
            const org = await page.request.post(API + '/orgs', { maxRedirects: 0, data: { name: 'QA local Intel ' + unique } });
            expect(org.status(), 'Fixture admission: real owner org create: ' + await org.text()).toBe(201);
            const orgBody: { orgId: string } = await org.json(); orgId = orgBody.orgId;
            if (typeof orgId !== 'string' || !orgId) throw new Error('Fixture admission: real org id missing');
            const created = await page.request.post(API + '/campaign-brief/briefs', {
              maxRedirects: 0, data: { orgId, name: 'QA Intel ' + unique,
                objective: 'Local layout fixture; no generation.', productName: 'QA planning tool',
                productDescription: 'Synthetic local fixture, not live campaign content.', groundingPolicy: 'strict' },
            });
            expect(created.status(), 'Fixture admission: real scoped brief create: ' + await created.text()).toBe(201);
            const body: { brief: CampaignBrief } = await created.json(); briefId = body.brief.id;
            expect(body.brief).toMatchObject({ tenantId: tenant, orgId, status: 'draft', version: 1, createdBy: userId });
            if (!briefId) throw new Error('Fixture admission: real brief id missing');
            const original = await page.request.get(API + '/campaign-brief/briefs/' + briefId, { maxRedirects: 0 });
            expect(original.status()).toBe(200); before = await original.json();
            voc = [{ id: 'qa-voc', briefId, orgId, quote: 'QA teams want clear planning guidance.',
              sourceRef: { documentId: 'qa-document', sourceKind: 'manual', locator: 'Synthetic paragraph one', contentHash: 'qa-synthetic' },
              theme: 'QA planning', sentiment: 'pain', createdBy: userId, createdAt: NOW }];
            angles = [{ id: 'qa-angle', briefId, orgId, claim: 'QA planning stays clear.', positioningLens: 'QA clarity',
              proofRefs: ['qa-voc'], hookVariants: [{ text: 'QA clear planning', format: 'text' }], createdBy: userId, createdAt: NOW }];
            hooks = [{ id: 'qa-hook', orgId, text: 'QA candidate hook', format: 'text', angleId: 'qa-angle',
              status: 'candidate', createdBy: userId, createdAt: NOW, updatedAt: NOW }];
            packs = [{ id: 'qa-pack', briefId, orgId, platform: 'meta', audiences: [LONG_AUDIENCE, SECOND_AUDIENCE, 'QA small teams'],
              interests: ['QA planning'], keywords: ['QA clarity'], rationale: 'Synthetic evidence only.', evidenceRefs: ['qa-voc'],
              createdBy: userId, createdAt: NOW, updatedAt: NOW }];
            expect(LONG_AUDIENCE.length).toBe(200); expect(SECOND_AUDIENCE.length).toBe(194);
            expect(LONG_AUDIENCE.split(' ')).toHaveLength(30); expect(SECOND_AUDIENCE.split(' ')).toHaveLength(30);
            await page.setViewportSize({ width: 1280, height: 720 });
            await page.goto('/campaign-studio?tab=campaign-brief&view=intel&brief=' + briefId);
            const hub = page.locator('[data-walkthrough="campaign-studio.page"]');
            await expect(hub.getByText(LONG_AUDIENCE, { exact: true })).toBeVisible();
            // Dismiss the actual first-visit offer before testing unobstructed controls.
            const hint = page.locator('.tutorial-hint');
            await expect(hint).toBeVisible();
            await hint.getByRole('button', { name: 'Dismiss', exact: true }).click();
            await expect(hint).toHaveCount(0);
            // Use the actual preference control, not injected classes/storage.
            const themeButtons = page.locator('.theme-toggle:visible').first().getByRole('button');
            await expect(themeButtons).toHaveCount(3);
            await themeButtons.nth(theme === 'light' ? 1 : 2).click();
            await expect(page.locator('html')).toHaveClass(new RegExp('(^|\\s)theme-' + theme + '(\\s|$)'));
            await page.setViewportSize(viewport);
            await page.reload();
            await expect(hub.getByText(LONG_AUDIENCE, { exact: true })).toBeVisible();
            await expect(page.locator('html')).toHaveClass(new RegExp('(^|\\s)theme-' + theme + '(\\s|$)'));
            await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
            expect(forbidden, 'Fixture admission: no foreign origin or UI writes').toEqual([]);
            expect(unexpected).toEqual([]);
          });
          await test.step('Measure actual focus, filtering, prose, reload and persistence', async () => {
            if (!orgId || !briefId) throw new Error('Fixture admission: owned identity lost');
            const ownedOrgId = orgId, ownedBriefId = briefId;
            const hub = page.locator('[data-walkthrough="campaign-studio.page"]');
            const intel = hub.locator('#brief-detail-panel[aria-labelledby="brief-detail-tab-intel"]');
            await expect(intel).toBeVisible();
            await expect(intel.getByText(SECOND_AUDIENCE, { exact: true })).toBeVisible();
            await expect(intel.getByText('QA teams want clear planning guidance.', { exact: false })).toBeVisible();
            await expect(intel.getByText('QA candidate hook', { exact: true })).toBeVisible();
            for (const suffix of ['voc', 'angles', 'targeting']) expect(calls.some(p => p === PREFIX + '/briefs/' + ownedBriefId + '/' + suffix)).toBe(true);
            expect(calls.some(p => p === PREFIX + '/hooks?orgId=' + encodeURIComponent(ownedOrgId))).toBe(true);
            const selects = intel.locator('select'); await expect(selects).toHaveCount(2);
            const beforeFocus = await measure(hub, info, 'before-focus');
            await selects.nth(0).focus(); await expect(selects.nth(0)).toBeFocused();
            const afterFocus = await measure(hub, info, 'after-real-sentiment-focus');
            // Capture both phases before asserting the baseline containment.
            contained(beforeFocus); contained(afterFocus);
            const audience = intel.getByText(LONG_AUDIENCE, { exact: true });
            const prose = await audience.evaluate(el => {
              const style = getComputedStyle(el), range = document.createRange();
              range.selectNodeContents(el);
              return { text: el.textContent, lines: range.getClientRects().length,
                fits: el.scrollWidth <= el.clientWidth + 1,
                clipped: style.overflowX === 'hidden' || style.overflowX === 'clip' || style.textOverflow === 'ellipsis' };
            });
            expect(prose).toMatchObject({ text: LONG_AUDIENCE, fits: true, clipped: false });
            expect(prose.lines).toBeGreaterThan(1);
            for (const index of [0, 1]) {
              const control = selects.nth(index); await centerReaches(control); await control.focus();
              await expect(control).toBeFocused(); contained(await measure(hub, info, 'focus-' + index));
              const pathname = index === 0 ? PREFIX + '/briefs/' + ownedBriefId + '/voc' : PREFIX + '/hooks';
              const key = index === 0 ? 'sentiment' : 'status', value = index === 0 ? 'desire' : 'tested';
              const changed = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === pathname && new URL(r.url()).searchParams.get(key) === value);
              await control.selectOption(value); expect((await changed).status()).toBe(200);
              await expect(intel.getByText(index === 0 ? 'QA teams want clear planning guidance.' : 'QA candidate hook', { exact: index === 1 })).toHaveCount(0);
              contained(await measure(hub, info, 'filtered-' + index));
              const reset = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === pathname && !new URL(r.url()).searchParams.has(key));
              await control.selectOption(''); expect((await reset).status()).toBe(200);
              await expect(intel.getByText(index === 0 ? 'QA teams want clear planning guidance.' : 'QA candidate hook', { exact: index === 1 })).toBeVisible();
              contained(await measure(hub, info, 'restored-filter-' + index));
            }
            const controls = hub.locator('button:visible, select:visible, a[href]:visible');
            for (let i = 0; i < await controls.count(); i++) await centerReaches(controls.nth(i));
            contained(await measure(hub, info, 'after-control-hit-testing'));
            const reloadedPaths = ['voc', 'angles', 'targeting'].map(x => PREFIX + '/briefs/' + ownedBriefId + '/' + x)
              .concat(PREFIX + '/hooks?orgId=' + encodeURIComponent(ownedOrgId));
            const counts = reloadedPaths.map(path => calls.filter(call => call === path).length);
            await page.reload();
            await expect(intel.getByText(LONG_AUDIENCE, { exact: true })).toBeVisible();
            await expect(intel.getByText('QA candidate hook', { exact: true })).toBeVisible();
            await expect(intel.getByText(SECOND_AUDIENCE, { exact: true })).toBeVisible();
            await expect(page.locator('html')).toHaveClass(new RegExp('(^|\\s)theme-' + theme + '(\\s|$)'));
            await expect(intel.getByText('QA planning stays clear.', { exact: true })).toBeVisible();
            await expect(intel.getByText('QA teams want clear planning guidance.', { exact: false })).toBeVisible();
            for (const [i, path] of reloadedPaths.entries()) expect(calls.filter(call => call === path).length).toBeGreaterThan(counts[i]!);
            await page.evaluate(async () => { await document.fonts.ready; });
            contained(await measure(hub, info, 'after-reload'));
            const persisted = await page.request.get(API + '/campaign-brief/briefs/' + ownedBriefId, { maxRedirects: 0 });
            expect(persisted.status()).toBe(200); expect(await persisted.json()).toEqual(before);
            expect(unexpected).toEqual([]); expect(forbidden).toEqual([]);
          });
        } finally {
          await test.step('Cleanup only this owned local brief/org and tenant overrides', async () => {
            const errors: unknown[] = [];
            if (briefId) {
              try {
                const r = await page.request.delete(API + '/campaign-brief/briefs/' + briefId, { maxRedirects: 0 });
                expect(r.status(), await r.text()).toBe(200);
              } catch (error) { errors.push(error); }
            }
            if (orgId) {
              try {
                const r = await page.request.delete(API + '/orgs/' + orgId, { maxRedirects: 0 });
                expect(r.status(), 'Real refuse-while-populated guard is never bypassed: ' + await r.text()).toBe(200);
              } catch (error) { errors.push(error); }
            }
            for (const item of changes.reverse()) {
              try { await changeOwnOverride(page.request, tenant, item, true); }
              catch (error) { errors.push(error); }
            }
            if (errors.length) throw new AggregateError(errors, 'Owned local cleanup incomplete; retain diagnostics');
          });
        }
      });
    }
  }
});
