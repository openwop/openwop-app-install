/**
 * ADR 0668 D4 (CMSLWF-16) — what the `cms-localization` toggle actually gates.
 *
 * `FEATURES.md`, `ROADMAP.md` and the toggle's own description all said or implied
 * "toggle OFF ⇒ delivery byte-identical". No delivery path reads the toggle, so an org
 * that authored overlays keeps serving them when it is flipped OFF.
 *
 * The nearest existing test is TITLED "is byte-identical when the cms-localization toggle
 * is OFF" (`test/cms-auto-translate.test.ts:158`) and asserts only that the submit-time
 * auto-translate sweep does not fire — a witness-shaped thing beside the claim that does
 * not witness it. This file witnesses the DELIVERY lane, which is what the claim was about.
 *
 * CORRECTED (grade-tests wave 16): legs 1 and 3 used to call `localizePage`, which is pure,
 * synchronous and tenant-less — it cannot read a toggle, so "delivery ignores the toggle"
 * could not fail there (the same witness-beside-the-claim shape this header names). They now
 * drive the PUBLIC delivery lane, `publishingService.publicPageBySlug`, on a really published
 * page. The old leg 2 ("no authored locales ⇒ base") was cut: it exercised the same
 * `resolveSection` base branch as `cms-localization-route.test.ts` "falls back to base data…"
 * (both red under w16g4-tgd-basepath / w16g4-lr-basepath), with no toggle dimension.
 *
 * Sabotage-witnessed (w16g4-*): making `publicPageBySlug` negotiate only while the toggle is
 * ON reds legs 1 and 3; restoring the old "Accept-Language delivery" description reds leg 4.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { saveConfig, resolveOne } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage, transitionPage, updateContentLanguageSettings } from '../src/features/cms/cmsService.js';
import { startCmsPublishSweep } from '../src/features/cms/publishSweep.js';
import { publicPageBySlug } from '../src/features/publishing/publishingService.js';
import { cmsFeature } from '../src/features/cms/feature.js';

// CEILING (recorded): the toggle default is registered inside `registerRoutes`, not at
// import time, and there is no other seam that registers it — so the feature's routes are
// registered against a no-op app. `RouteDeps` needs a real Express app, config, storage and
// host suite, none of which this claim uses, hence the one cast. Without this the toggle
// legs are vacuous (measured: `getToggleDefault` returned undefined and leg 4 passed
// against nothing). `registerRoutes` also starts the scheduled-publish sweep daemon;
// `afterAll` stops it.
const registerToggles = (): void => {
  const noop = (): void => undefined;
  const deps = { app: { get: noop, post: noop, put: noop, patch: noop, delete: noop, use: noop } };
  try { cmsFeature.registerRoutes(deps as unknown as Parameters<typeof cmsFeature.registerRoutes>[0]); } catch { /* a later registration may need a real app; the toggle defaults are registered by then */ }
};
afterAll(() => { startCmsPublishSweep().stop(); });

const T = 'tTogDel';
let orgId = '';
let slug = '';

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cms-localization');
  expect(d, 'the cms-localization toggle default must be registered').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};
const deliver = (lang: string) => publicPageBySlug(orgId, slug, 'https://site.test', lang);

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerToggles();
  orgId = (await createOrg({ tenantId: T, createdBy: 'u1', name: 'Acme' })).orgId;
  await updateContentLanguageSettings(T, orgId, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
  const page = await createPage({
    tenantId: T, orgId, title: 'P', createdBy: 'u1',
    sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { es: { text: 'cuerpo espanol' } } }],
  });
  const live = await transitionPage(T, orgId, page.pageId, 'publish', 'u1');
  expect(live?.status, 'precondition: the page is really published').toBe('published');
  slug = page.slug;
});

describe('ADR 0668 D4 — the toggle gates AUTHORING, not delivery', () => {
  it('leg 1: with the toggle OFF, an authored es overlay is STILL SERVED on the public lane', async () => {
    await setToggle('off');
    expect((await resolveOne('cms-localization', { tenantId: T }))?.enabled, 'precondition: really off').toBeFalsy();
    const { page, locale } = await deliver('es');
    expect(locale, 'delivery negotiates regardless of the toggle').toBe('es');
    expect(JSON.stringify(page.sections),
      'the overlay is served with the toggle OFF — "delivery byte-identical" was FALSE',
    ).toContain('cuerpo espanol');
  });

  it('leg 3: turning the toggle ON changes NOTHING about delivery (so leg 1 is about the toggle, not the fixture)', async () => {
    await setToggle('off');
    const off = await deliver('es');
    await setToggle('on');
    expect((await resolveOne('cms-localization', { tenantId: T }))?.enabled, 'precondition: really on').toBe(true);
    const on = await deliver('es');
    expect(on.locale).toBe('es');
    expect(JSON.stringify(off.page.sections),
      'delivery is byte-identical ACROSS toggle states — which is not the claim that was made',
    ).toBe(JSON.stringify(on.page.sections));
  });

  it('leg 4: the toggle description no longer advertises delivery', async () => {
    const d = getToggleDefault('cms-localization');
    expect(d?.description, 'the copy an operator reads at the flip must not promise delivery gating').not.toMatch(/Accept-Language delivery/);
    expect(d?.description).toMatch(/not gated|Delivery is NOT gated/i);
  });
});
