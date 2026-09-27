/**
 * ADR 0593 §C2 (CMSA-10 / CMSA-11) — the FOURTH live-edit lane, witnessed at the
 * DELIVERY boundary rather than at the route.
 *
 * `localizePage` derives the set of locales it will serve as
 * `settings.supportedLocales.filter((l) => state[l] !== 'draft')`. The ADR 0593
 * batch gated `state` (the per-page `localePublishState` flip) after the
 * adversarial review falsified its "delivery state, not content" verdict — and
 * left `supportedLocales`, the STRICT SUPERSET control over that same map, read
 * live by the same function at the same `host:members:manage` tier, ungated.
 *
 * Three facts make that reachable rather than theoretical:
 *   (a) `validateLocalizations` validates an overlay key as BCP-47-and-not-base
 *       and NEVER against `supportedLocales` — so overlays for unconfigured
 *       locales are storable, and typically are (the auto-translate sweep and
 *       the editor's translate-from-base both write them);
 *   (b) an ABSENT `localePublishState` entry MEANS published, so a newly added
 *       locale is live by default — there is no withheld-by-default arm;
 *   (c) `resolveSharedRefs` splices a SHARED row's `localizations` into the
 *       delivered page, so the overlay need not even live on the page.
 *
 * So on a gated org ONE settings write puts never-reviewed machine drafts in
 * front of the public with the Approvals inbox empty and `page.version`
 * unmoved. Every assertion below therefore reads the ANONYMOUS public delivery
 * route (`/v1/host/openwop-app/public/:orgId/pages/:slug` +
 * `Accept-Language`), not the settings response — the route returning 409 is
 * not the claim; the public not seeing the content is.
 *
 * The controls are the point as much as the refusal. A gate that refused every
 * locale addition would be the gate-with-no-exit shape this same batch closed,
 * so: NARROWING stays open (removing a locale is the fail-safe direction, the
 * same reasoning as `unpublish`), a `draft` page stays open, a page with no
 * overlay at the added locale stays open, and a WITHHELD locale stays open
 * (still not deliverable).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const t = getToggleDefault('users');
  if (t) await saveConfig({ ...t, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};
const setGate = (status: 'on' | 'off'): Promise<void> => setToggle('cms-approval-gate', status);

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Res<T = any> { status: number; headers: Headers; body: T }
interface Client {
  get: (p: string, headers?: Record<string, string>) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, headers: res.headers, body: out };
  };
  return {
    get: (p, headers) => call('GET', p, undefined, headers),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
  };
}

let n = 0;
async function owner(): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:cmsa10-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `cmsa10-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string, tenantId };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

/** The ANONYMOUS delivery boundary — no cookie, `Accept-Language` only. */
async function publicRead(orgId: string, slug: string, acceptLanguage: string): Promise<Res> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`, {
    headers: { 'accept-language': acceptLanguage },
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => undefined) };
}

const BASE_TEXT = 'Welcome';
const DORMANT_TEXT = 'RASCUNHO NAO REVISADO'; // the never-reviewed machine draft

/** A PUBLISHED page carrying a dormant `pt-BR` overlay while pt-BR is NOT a
 *  configured locale. Built with the gate OFF (the realistic history: the org
 *  turned the editorial gate on with live pages already in place). */
async function publishedPageWithDormantOverlay(
  c: Client,
  orgId: string,
  status: 'published' | 'draft' | 'in_review' = 'published',
): Promise<{ pageId: string; slug: string }> {
  const created = await c.post(u(orgId, '/pages'), {
    title: 'Home',
    sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { 'pt-BR': { heading: DORMANT_TEXT } } }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;
  // The overlay stored even though pt-BR is unconfigured — fact (a). If this
  // ever starts 400ing, the reachability argument changes and this witness must
  // be re-derived rather than deleted.
  expect(created.body.sections[0].localizations['pt-BR'].heading).toBe(DORMANT_TEXT);
  if (status === 'published') {
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
  } else if (status === 'in_review') {
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
  }
  return { pageId, slug: created.body.slug as string };
}

async function pendingContentApprovals(c: Client): Promise<any[]> {
  const list = await c.get('/v1/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return (list.body.items as any[]).filter((a) => a.kind === 'content-publish');
}

beforeAll(async () => { await setToggle('cms-localization', 'on'); });

describe('CMSA-10 — adding an org content locale is a PUBLISH of every dormant overlay', () => {
  it('the widening is refused by the ONE live-edit rule, and the public never sees the unreviewed overlay', async () => {
    const { c, orgId } = await owner();
    await setGate('off');
    const { slug } = await publishedPageWithDormantOverlay(c, orgId);

    // CONTROL — the overlay is DORMANT: pt-BR is not a configured locale, so
    // delivery negotiates to base. Without this the final assertion could not
    // distinguish "the gate held" from "the overlay was never deliverable".
    const before = await publicRead(orgId, slug, 'pt-BR');
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.headers.get('content-language')).toBe('en');
    expect(before.body.sections[0].data.heading).toBe(BASE_TEXT);

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    // The 409 must come from THIS rule, not from the baseLocale-offender 409 or
    // the §A invariant 400 — `gate` is a discriminator only `liveEditRefusal`
    // sets (two mechanisms, one observable: assert the one only the mechanism
    // under test can produce).
    expect(widen.body?.error?.details?.gate ?? widen.body?.details?.gate).toBe('cms-approval-gate');
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect(details.addedLocales).toEqual(['pt-BR']);
    // `pageId` is high-entropy and the error envelope REDACTS it, so identity
    // is asserted on the fields an operator actually gets back (and that the
    // message repeats) — a `pageId` assertion here would be comparing two
    // redaction placeholders.
    expect((details.pages as any[]).map((p) => [p.title, p.status, p.locales]))
      .toEqual([['Home', 'published', ['pt-BR']]]);
    // The refusal NAMES the exit (an admin must unpublish) — a gate whose 409
    // does not say what to do is the gate-with-no-exit shape.
    expect(String(widen.body?.error?.message ?? widen.body?.message)).toMatch(/unpublish/i);

    // The settings write did NOT land.
    const settings = await c.get(u(orgId, '/language-settings'));
    expect(settings.body.supportedLocales).toEqual([]);

    // THE CLAIM — the public still gets base content. Zero approval rows exist,
    // which is the whole point: this lane bypassed the inbox entirely.
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('en');
    expect(after.body.sections[0].data.heading).toBe(BASE_TEXT);
    expect(await pendingContentApprovals(c)).toHaveLength(0);
  });

  it('an `in_review` page blocks the widening too — both arms of the rule, not just `published`', async () => {
    // The SEO gate shipped with only the `published` arm and the adversarial
    // review (F1) caught it. The pin's closed world is `page.version`, which a
    // settings write never moves, so a resubmit can never make the reviewer see
    // this: `in_review` must be in the set for the same reason it is for the
    // shared-section and locale-flip lanes.
    const { c, orgId } = await owner();
    await setGate('off');
    await publishedPageWithDormantOverlay(c, orgId, 'in_review');
    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect((details.pages as any[]).map((p) => [p.title, p.status])).toEqual([['Home', 'in_review']]);
  });

  it('a SHARED-section overlay blocks it too — delivery resolves the ref at read time', async () => {
    // The CMSA-1 lesson applied to this lane: the overlay that goes live need
    // not live on the page. `resolveSharedRefs` splices the shared row's
    // `localizations` into the delivered page, so a scan that only walked the
    // page's own sections would refuse nothing here and the widening would
    // release the shared overlay on every referencing published page.
    const { c, orgId } = await owner();
    await setGate('off');
    const shared = await c.post(u(orgId, '/shared-sections'), {
      name: 'Global CTA',
      type: 'cta',
      data: { label: 'Go', url: '/agents' },
      localizations: { 'pt-BR': { label: 'IR NAO REVISADO' } },
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Shared home',
      sections: [{ type: 'cta', data: {}, ref: { sharedSectionId: shared.body.sharedSectionId } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId as string;
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);

    const before = await publicRead(orgId, slug, 'pt-BR');
    expect(before.headers.get('content-language')).toBe('en');
    expect(before.body.sections[0].data.label).toBe('Go');

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect((details.pages as any[]).map((p) => [p.title, p.status])).toEqual([['Shared home', 'published']]);

    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.body.sections[0].data.label).toBe('Go');
  });
});

describe('CMSA-10 — the language-FAMILY arm (review F1)', () => {
  it('a LANGUAGE-FAMILY overlay blocks it too — delivery resolves exact → family → base', async () => {
    // ADR 0593 §C8 (review F1). An exact-tag scan reproduced CMSA-10 verbatim:
    // `resolveSection` falls back to the language FAMILY (RFC 0103 §C), so a
    // dormant `pt` overlay is served to a visitor negotiated onto `pt-BR`.
    // Adding the region-qualified tag therefore publishes the bare-language
    // overlay, and "remove `pt`, add `pt-BR`" is two clicks in the settings UI.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Family',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(BASE_TEXT);

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect(details.addedLocales).toEqual(['pt-BR']);
    expect((details.pages as any[]).map((p) => [p.title, p.status])).toEqual([['Family', 'published']]);

    // And the family chain really is one-directional: with the gate OFF the
    // same widening serves the `pt` overlay under `Content-Language: pt-BR`.
    // Without this the refusal above could be over-refusal.
    await setGate('off');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(200);
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('pt-BR');
    expect(after.body.sections[0].data.heading).toBe(DORMANT_TEXT);
  });
});

describe('§C9 F2 — the family cure must not refuse a change that releases NOTHING', () => {
  it('family locale ALREADY supported: delivery is byte-identical before and after, so no refusal', async () => {
    // The §C8 fix asked "is the added tag matched by some overlay". That
    // over-refused here: with `pt` supported, a `pt-BR` visitor ALREADY
    // negotiates to `pt` and gets the overlay. Adding `pt-BR` changes the
    // Content-Language label, not a byte of content — and §C7 rejected
    // Prescription 1 for precisely this shape.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Already family',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt'] })).status).toBe(200);

    // Reachable ALREADY — this is the assertion that makes the 200 below mean
    // "nothing new was released" rather than "nothing was ever there".
    const beforeRead = await publicRead(orgId, slug, 'pt-BR');
    expect(beforeRead.body.sections[0].data.heading).toBe(DORMANT_TEXT);

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt', 'pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    const afterRead = await publicRead(orgId, slug, 'pt-BR');
    expect(afterRead.body.sections[0].data.heading).toBe(DORMANT_TEXT); // same content
  });

  it('family locale WITHHELD on the page: `localizePage` strips it, so adding the region tag releases nothing', async () => {
    // `withheld` keys are deleted from `s.localizations` BEFORE resolution, so
    // the family hop cannot reach a withheld overlay. The scan must model that
    // or it refuses a change the reader cannot observe.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Withheld family',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    const pageId = created.body.pageId as string;
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt'] })).status).toBe(200);
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/pt/unpublish`))).status).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(BASE_TEXT);

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt', 'pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    // And the reader still gets base — the 200 did not release it.
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.body.sections[0].data.heading).toBe(BASE_TEXT);
  });

  it('withholding an UNSUPPORTED family locale does NOT protect it — the model must not credit a no-op', async () => {
    // Found by sabotage, not by review: modelling `withheldKeys` from every
    // `localePublishState` key instead of from the scenario's supportedLocales
    // left every assertion green. It is the UNDER-refusal direction, so it is
    // the dangerous one. `localizePage` computes
    //   withheld = settings.supportedLocales.filter(l => state[l] === 'draft')
    // so a `draft` marker on a locale that is NOT supported strips nothing —
    // and since §C8 opened the withhold direction to unconfigured tags, an
    // operator can now easily create exactly this state and believe they are
    // safe. Adding `pt-BR` must still refuse.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'False comfort',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    const pageId = created.body.pageId as string;
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    // Withhold `pt` while it is NOT a configured locale — accepted, but inert.
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/pt/unpublish`))).status).toBe(200);

    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    expect((widen.body?.error?.details ?? widen.body?.details).matchedOverlayLocales).toEqual(['pt']);

    // The proof that the withhold really was inert: gate OFF, same write, and
    // the supposedly-withheld overlay reaches the public.
    await setGate('off');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(DORMANT_TEXT);
  });

  it('the refusal names the MATCHED overlay locale, never one that holds no content (F2b)', async () => {
    // The §C8 message said "the `pt-BR` translation content this change would
    // publish" when the content is keyed `pt` and `pt-BR` holds nothing — the
    // same class as the "withdraw them from review" verb this batch deleted:
    // a refusal describing something that does not exist.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Named right',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    expect((await c.post(u(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(409);
    const details = widen.body?.error?.details ?? widen.body?.details;
    expect(details.matchedOverlayLocales).toEqual(['pt']);   // where the content IS
    expect(details.addedLocales).toEqual(['pt-BR']);          // what to withhold
    const msg = String(widen.body?.error?.message ?? widen.body?.message);
    expect(msg).toMatch(/`pt` translation content/);          // names the content's locale
    expect(msg).toMatch(/Withhold `pt-BR`/);                  // names the actionable one
  });

  it('withholding the ADDED locale is a working remedy for a FAMILY match', async () => {
    // The remedy has to work for the case the refusal actually fires on. A
    // withheld locale leaves `deliverable` entirely, so nothing negotiates to
    // it and the family overlay becomes unreachable — which is why the message
    // names the added tag and not the matched one.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Family remedy',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { pt: { heading: DORMANT_TEXT } } }],
    });
    const pageId = created.body.pageId as string;
    const slug = created.body.slug as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    await setGate('on');
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(409);
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/pt-BR/unpublish`))).status).toBe(200);
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(BASE_TEXT);
  });
});

describe('CMSA-10 — the refusal has a CHEAP exit, not just "unpublish the site"', () => {
  it('withhold-then-add: an unconfigured locale can be WITHHELD first, and the widening then lands', async () => {
    // ADR 0593 §C8 (review F3). `setLocalePublishState` used to require the
    // locale to be already configured in BOTH directions, which made the safe
    // sequence circular — you could not withhold `pt-BR` before adding it, and
    // you could not add it because it was not withheld. The only remaining exit
    // was unpublishing every live page holding an overlay. The withhold
    // direction removes content from delivery, so it is now open for any valid
    // non-base tag; the RELEASE direction is still configured-locales-only.
    const { c, orgId } = await owner();
    await setGate('off');
    const { pageId, slug } = await publishedPageWithDormantOverlay(c, orgId);
    await setGate('on');

    // Refused first — the exit is being tested, not assumed.
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(409);

    // The exit: withhold on the blocking page (ungated, fail-safe direction)…
    const withhold = await c.post(u(orgId, `/pages/${pageId}/locales/pt-BR/unpublish`));
    expect(withhold.status, JSON.stringify(withhold.body)).toBe(200);
    // …then the same widening lands, with the page still serving base.
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('en');
    expect(after.body.sections[0].data.heading).toBe(BASE_TEXT);

    // And the RELEASE direction stays configured-only + gated: releasing it now
    // goes through the ADR 0593 §C1 gate, which is the review this lane exists
    // to force. (409, not 400 — the locale IS configured now.)
    const release = await c.post(u(orgId, `/pages/${pageId}/locales/pt-BR/publish`));
    expect(release.status, JSON.stringify(release.body)).toBe(409);
  });

  it('the withhold direction still refuses a nonsense or base-locale tag', async () => {
    // Opening a direction is not opening the field: the 400 that used to come
    // from the configured-locale check must not simply vanish.
    const { c, orgId } = await owner();
    await setGate('off');
    const { pageId } = await publishedPageWithDormantOverlay(c, orgId);
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/not-a-locale/unpublish`))).status).toBe(400);
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/en/unpublish`))).status).toBe(400);
  });
});

describe('CMSA-10 — the controls: what the rule must NOT refuse', () => {
  it('UNGATED positive control — with the gate OFF the same widening lands, and the overlay goes LIVE', async () => {
    // Without this the refusal above could be a broken route rather than a
    // gate, AND the Blocker itself would be unwitnessed: this is the assertion
    // that proves adding a locale really does publish unreviewed content.
    const { c, orgId } = await owner();
    await setGate('off');
    const { slug } = await publishedPageWithDormantOverlay(c, orgId);
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);

    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('pt-BR');
    expect(after.body.sections[0].data.heading).toBe(DORMANT_TEXT); // never reviewed, now public
    expect(await pendingContentApprovals(c)).toHaveLength(0);
  });

  it('NARROWING stays open — removing a locale is the fail-safe direction, like `unpublish`', async () => {
    const { c, orgId } = await owner();
    await setGate('off');
    const { slug } = await publishedPageWithDormantOverlay(c, orgId);
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(DORMANT_TEXT);

    await setGate('on');
    const narrow = await c.put(u(orgId, '/language-settings'), { supportedLocales: [] });
    expect(narrow.status, JSON.stringify(narrow.body)).toBe(200);
    // Content came OFF the public page — never gate that direction.
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.headers.get('content-language')).toBe('en');
    expect(after.body.sections[0].data.heading).toBe(BASE_TEXT);
  });

  it('a DRAFT page never blocks — nothing it holds is delivered', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    await publishedPageWithDormantOverlay(c, orgId, 'draft');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
  });

  it('a published page with NO overlay at the added locale never blocks — the gate has an exit', async () => {
    // A rule that refused every locale addition on any live org would make
    // localization unconfigurable the moment the editorial gate went on.
    const { c, orgId } = await owner();
    await setGate('off');
    await publishedPageWithDormantOverlay(c, orgId);
    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
  });

  it('an EMPTY overlay never blocks — it resolves to base, so it changes nothing for a reader', async () => {
    // ADR 0593 §C8 (review F9). `hasLoc` is a KEY COUNT, so `localizations.es
    // = {}` is storable; `resolveSection` then serves `{...base, ...{}}`. A
    // presence-only scan would refuse a widening that releases nothing, and the
    // refusal would name a page whose overlay is invisible in the editor.
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Empty overlay',
      sections: [{ type: 'hero', data: { heading: BASE_TEXT }, localizations: { es: {} } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.sections[0].localizations?.es, 'the empty overlay must really be stored').toEqual({});
    expect((await c.post(u(orgId, `/pages/${created.body.pageId}/publish`))).status).toBe(200);
    await setGate('on');
    const widen = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['es'] });
    expect(widen.status, JSON.stringify(widen.body)).toBe(200);
  });

  it('a WITHHELD locale never blocks — `localePublishState` still says draft, so nothing goes live', async () => {
    // The scan must consult the SAME map `localizePage` does, not merely the
    // presence of an overlay: a locale explicitly held in `draft` is not
    // deliverable however the settings move.
    const { c, orgId } = await owner();
    await setGate('off');
    const { pageId, slug } = await publishedPageWithDormantOverlay(c, orgId);
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] })).status).toBe(200);
    // Withhold it (ungated, fail-safe direction).
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/pt-BR/unpublish`))).status).toBe(200);
    expect((await publicRead(orgId, slug, 'pt-BR')).body.sections[0].data.heading).toBe(BASE_TEXT);

    await setGate('on');
    // Narrow then re-widen: the re-add is a widening in the settings sense, but
    // the page's own state keeps it withheld, so there is nothing to refuse.
    expect((await c.put(u(orgId, '/language-settings'), { supportedLocales: [] })).status).toBe(200);
    const rewiden = await c.put(u(orgId, '/language-settings'), { supportedLocales: ['pt-BR'] });
    expect(rewiden.status, JSON.stringify(rewiden.body)).toBe(200);
    const after = await publicRead(orgId, slug, 'pt-BR');
    expect(after.body.sections[0].data.heading).toBe(BASE_TEXT);
  });
});
