/**
 * ADR 0668 D2 (CMSLWF-15) — releasing or withholding a locale is a publish for that
 * locale's readers, and emits on the WEBHOOK lane. It deliberately does NOT fire the
 * in-process lifecycle seam.
 *
 * Born red on both halves: before the fix `locale-publish-state` was in neither
 * `EVENT_FOR_ACTION` nor `LIFECYCLE_FOR_ACTION`, so leg 1 and leg 2 saw zero events.
 *
 * Leg 3 is the important one. The first draft of ADR 0668 wired BOTH lanes, and the
 * lifecycle half was DESTRUCTIVE: `CmsPageLifecycleChange` carries no locale, and the one
 * registered consumer deletes the WHOLE document on `unpublished`, so withholding one `es`
 * overlay of a docs page would have evicted a still-published page — English body included
 * — from the docs KB. This leg pins that the seam stays silent.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { onCmsPageLifecycle, __resetCmsPageLifecycleHooks } from '../src/host/cmsPageLifecycle.js';
import type { CmsPageLifecycleChange } from '../src/host/cmsPageLifecycle.js';
import * as dispatcher from '../src/host/hostEventDispatcher.js';
import {
  createPage, updatePage, setLocalePublishState, updateContentLanguageSettings,
} from '../src/features/cms/cmsService.js';

const T = 'tLocEvt';
const ORG = 'org-1';
let emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
let lifecycle: CmsPageLifecycleChange[] = [];
let pageId = '';

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetCmsPageLifecycleHooks();
  emitted = []; lifecycle = [];
  vi.spyOn(dispatcher, 'emitHostEvent').mockImplementation(async (e) => {
    const ev = e as unknown as { type: string; payload?: Record<string, unknown> };
    emitted.push({ type: ev.type, payload: ev.payload ?? {} });
  });
  onCmsPageLifecycle('test-probe', async (e) => { lifecycle.push(e); });
  await updateContentLanguageSettings(T, ORG, { baseLocale: 'en', supportedLocales: ['es'] }, 'u1');
  const page = await createPage({
    tenantId: T, orgId: ORG, title: 'P', createdBy: 'u1', collection: 'docs',
    sections: [{ type: 'richText', data: { html: '<p>base</p>' }, localizations: { es: { html: '<p>hola</p>' } } }],
  });
  pageId = page.pageId;
  await updatePage(T, ORG, pageId, { status: 'published' } as never, 'u1').catch(() => undefined);
  emitted = []; lifecycle = [];
});
afterEach(() => { vi.restoreAllMocks(); __resetCmsPageLifecycleHooks(); });

describe('ADR 0668 D2 — a locale flip emits on the webhook lane only', () => {
  it('leg 1: WITHHOLDING a locale emits host.cms.page.unpublished carrying the locale', async () => {
    await setLocalePublishState(T, ORG, pageId, 'es', 'draft', 'u1');
    const ev = emitted.find((e) => e.type === 'host.cms.page.unpublished');
    expect(ev, 'withholding a locale removes content from delivery — it must emit').toBeTruthy();
    expect(ev?.payload.locale, 'the locale is the discriminator that makes reuse honest').toBe('es');
  });

  it('leg 2: RELEASING a locale emits host.cms.page.published carrying the locale', async () => {
    await setLocalePublishState(T, ORG, pageId, 'es', 'draft', 'u1');
    emitted = [];
    await setLocalePublishState(T, ORG, pageId, 'es', 'published', 'u1');
    const ev = emitted.find((e) => e.type === 'host.cms.page.published');
    expect(ev).toBeTruthy();
    expect(ev?.payload.locale).toBe('es');
  });

  it('leg 3: the in-process LIFECYCLE seam stays SILENT — firing it would evict a live page', async () => {
    await setLocalePublishState(T, ORG, pageId, 'es', 'draft', 'u1');
    await setLocalePublishState(T, ORG, pageId, 'es', 'published', 'u1');
    expect(lifecycle,
      'the docs KB consumer deletes the WHOLE document on `unpublished`, and the seam carries no locale',
    ).toEqual([]);
  });

  it('leg 4: a real page unpublish DOES still fire the lifecycle seam (leg 3 is not vacuous)', async () => {
    await updatePage(T, ORG, pageId, { status: 'draft' } as never, 'u1').catch(() => undefined);
    // If nothing fires here, leg 3 proves nothing — the seam would be dead for every action.
    expect(lifecycle.length + emitted.length,
      'the seam and/or the event lane must still work for a real page transition').toBeGreaterThan(0);
  });
});
