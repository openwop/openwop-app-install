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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveOne } from '../src/host/featureToggles/service.js';
import { createPage, updateContentLanguageSettings, localizePage, getContentLanguageSettings } from '../src/features/cms/cmsService.js';
import { cmsFeature } from '../src/features/cms/feature.js';

// The toggle default is registered inside `registerRoutes`, not at import time — a bare
// import leaves `getToggleDefault` empty and every toggle leg vacuous (measured: it
// returned undefined, and leg 4 passed against nothing).
const registerToggles = (): void => {
  try { (cmsFeature as unknown as { registerRoutes: (d: unknown) => void }).registerRoutes({ app: { get() {}, post() {}, put() {}, patch() {}, delete() {}, use() {} } }); } catch { /* routes need a real app; the toggle default lands before they do */ }
};

const T = 'tTogDel';
const ORG = 'org-1';

const setToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cms-localization');
  if (d) await saveConfig({ ...d, status }, 'test');
};

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerToggles();
  await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
  await createPage({
    tenantId: T, orgId: ORG, title: 'P', createdBy: 'u1',
    sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { es: { text: 'cuerpo espanol' } } }],
  });
});

describe('ADR 0668 D4 — the toggle gates AUTHORING, not delivery', () => {
  it('leg 1: with the toggle OFF, an authored es overlay is STILL SERVED', async () => {
    await setToggle('off');
    expect((await resolveOne('cms-localization', { tenantId: T }))?.enabled, 'precondition: really off').toBeFalsy();

    const page = await createPage({
      tenantId: T, orgId: ORG, title: 'P2', createdBy: 'u1',
      sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { es: { text: 'cuerpo espanol' } } }],
    });
    const settings = await getContentLanguageSettings(T, ORG);
    const { page: served, locale } = localizePage(page, 'es', settings);
    expect(locale, 'delivery negotiates regardless of the toggle').toBe('es');
    expect(JSON.stringify(served.sections),
      'the overlay is served with the toggle OFF — "delivery byte-identical" was FALSE',
    ).toContain('cuerpo espanol');
  });

  it('leg 2: the ADR 0064 qualifier IS true — no authored locales ⇒ base delivery', async () => {
    await setToggle('off');
    const plain = await createPage({
      tenantId: T, orgId: ORG, title: 'P3', createdBy: 'u1',
      sections: [{ type: 'richText', data: { text: 'english body' } }],
    });
    const settings = await getContentLanguageSettings(T, ORG);
    const { page: served } = localizePage(plain, 'es', settings);
    expect(JSON.stringify(served.sections)).toContain('english body');
    expect(JSON.stringify(served.sections)).not.toContain('cuerpo espanol');
  });

  it('leg 3: turning the toggle ON changes NOTHING about delivery (so leg 1 is about the toggle, not the fixture)', async () => {
    const settings = await getContentLanguageSettings(T, ORG);
    const page = await createPage({
      tenantId: T, orgId: ORG, title: 'P4', createdBy: 'u1',
      sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { es: { text: 'cuerpo espanol' } } }],
    });
    await setToggle('off');
    const off = JSON.stringify(localizePage(page, 'es', settings).page.sections);
    await setToggle('on');
    const on = JSON.stringify(localizePage(page, 'es', settings).page.sections);
    expect(off, 'delivery is byte-identical ACROSS toggle states — which is not the claim that was made').toBe(on);
  });

  it('leg 4: the toggle description no longer advertises delivery', async () => {
    const d = getToggleDefault('cms-localization');
    expect(d?.description, 'the copy an operator reads at the flip must not promise delivery gating').not.toMatch(/Accept-Language delivery/);
    expect(d?.description).toMatch(/not gated|Delivery is NOT gated/i);
  });
});
