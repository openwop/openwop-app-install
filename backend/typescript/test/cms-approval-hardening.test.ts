/**
 * ADR 0593 — the CMS editorial approval gate's remaining unwitnessed mechanism.
 *
 * The gate's decide core was the best-tested handler in the store and still had
 * five branches nothing exercised. Each `it` below is one of them, and each was
 * a real gap in the feature-24 grade pass:
 *
 *   - `CMSA-3` / `CMSAWF-3` — the version pin was CHECK-THEN-ACT. An admin PATCH
 *     landing between the compare and `transitionPage`'s own blind read-modify-
 *     write published content the reviewer never saw, under their name. The
 *     window is real but not reachable by racing real HTTP requests against
 *     `memory://` storage (handlers never interleave mid-request), so it is
 *     forced DETERMINISTICALLY: the handler's page read is made to return the
 *     pre-PATCH snapshot — exactly "the read landed before the edit did" — while
 *     the store, the route and `transitionPage` itself stay real.
 *   - `CMSA-2c` / `CMSAWF-2` — the gate-OFF experiment-promote arm published
 *     without the route's approval cleanup, stranding a pre-existing row.
 *   - `CMSA-4` — the gated promote arm queued CONDITIONALLY on a toggle it had
 *     already read, so a flip in the window left `in_review` with no row.
 *   - `CMSA-7` ⇄ `CMSLWF-5` — an unpinned (pre-pin) row skipped the staleness
 *     check entirely: a guard that could not identify its subject fell through.
 *   - `CMSA-6` — nothing pinned that the SLA expire rung must not raw-reject
 *     this kind, the one behavior protecting `in_review` from `system:sla-expiry`.
 *   - `CMSAU-4` — machine-draft provenance is DERIVED from durable stamps, so it
 *     must survive a resubmit rather than being rebuilt empty.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContentApproval, getApproval, getContentApprovalHandler, repinContentApproval } from '../src/host/approvalService.js';
import { kindHasRejectSideEffects } from '../src/host/approvalDecision.js';
import * as cmsService from '../src/features/cms/cmsService.js';

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
interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  put: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b) };
}

let n = 0;
async function owner(): Promise<{ c: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:cmsah-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `cmsah-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string, tenantId, userId: login.body.user.userId as string };
}
const u = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function pendingFor(c: Client, pageId: string): Promise<any> {
  const list = await c.get('/v1/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return (list.body.items as any[]).find((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

describe('CMSA-3 — the approve-what-you-saw pin is a PRECONDITION, not a check-then-act read', () => {
  it('refuses the publish when the page moved between the pin check and the transition', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Launch', sections: [{ type: 'hero', data: { heading: 'Reviewed' } }] });
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const appr = await pendingFor(c, pageId);
    expect(appr).toBeTruthy();

    // The stale snapshot the handler's own read returns — i.e. the read that
    // happened BEFORE the admin's edit landed. Everything else is real: the
    // store, the route, the CAS, and `transitionPage`'s own fresh read.
    const preEdit = await cmsService.getPage(appr.tenantId ?? '', orgId, pageId)
      ?? (await c.get(u(orgId, `/pages/${pageId}`))).body;

    // The admin edit lands (legal — an in_review page is editable at admin tier).
    const patched = await c.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'Rewritten after review' } }] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.version).toBeGreaterThan(preEdit.version);

    const spy = vi.spyOn(cmsService, 'getPage').mockImplementation(async (_t, _o, p) => {
      if (p === pageId) return preEdit as any; // the pre-edit read
      return null;
    });
    try {
      const claim = await c.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
      expect(claim.status, JSON.stringify(claim.body)).toBe(409);
      // WITHOUT these two the test is VACUOUS. If the spy never intercepted the
      // handler's read, the pre-CAS staleness check would fire instead and
      // produce the SAME 409 with the SAME pending row — so the test would pass
      // whether or not the transition-level precondition exists at all.
      expect(spy, 'the spy must actually intercept the handler read').toHaveBeenCalled();
      expect(claim.body?.details?.phase, 'the 409 must come from the TRANSITION, not the pre-CAS read').toBe('transition');
    } finally {
      spy.mockRestore();
    }

    // The page did NOT publish, and the approval was COMPENSATED back to pending
    // — a failed decide never consumes the row.
    const after = await c.get(u(orgId, `/pages/${pageId}`));
    expect(after.body.status).toBe('in_review');
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');
  });

  it('publishes normally when nothing moved (the positive control)', async () => {
    // Without this the assertion above would be satisfied by a `transitionPage`
    // that 409s unconditionally.
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Steady', sections: [{ type: 'hero', data: { heading: 'Reviewed' } }] });
    const pageId = created.body.pageId as string;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(c, pageId);
    const claim = await c.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });
});

describe('CMSA-7 — an UNPINNED review refuses once and pins itself, instead of falling through', () => {
  it('409s `unpinned_review` and repins to the live version, so the retry is a real decision', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Legacy', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    // Reproduce a pre-pin row: same shape the deploy left behind, no pageVersion.
    const legacy = await createContentApproval({ tenantId, orgId, pageId, pageTitle: 'Legacy', proposal: 'Publish' });
    expect(legacy.pageVersion).toBeUndefined();

    const first = await c.post(`/v1/host/openwop-app/approvals/${legacy.approvalId}/claim`);
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body?.details?.reason).toBe('unpinned_review');
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('in_review'); // did NOT fall through

    // The refusal has an exit — the row is now pinned, so the retry is version-checked.
    const pinned = await getApproval(legacy.approvalId);
    expect(typeof pinned?.pageVersion).toBe('number');
    expect(pinned?.status).toBe('pending');
    const second = await c.post(`/v1/host/openwop-app/approvals/${legacy.approvalId}/claim`);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });

  it('a REJECT of an unpinned row is never version-blocked', async () => {
    // Refusing content you did not see is never the unsafe direction, and
    // blocking it would trap the page in review — the reason the pin is
    // approve-only. A fix that gated both verbs would fail here.
    const { c, orgId, tenantId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Legacy reject', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    const legacy = await createContentApproval({ tenantId, orgId, pageId, pageTitle: 'Legacy reject', proposal: 'Publish' });
    const rej = await c.post(`/v1/host/openwop-app/approvals/${legacy.approvalId}/reject`, { note: 'Not yet' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('draft');
  });
});

describe('CMSA-6 — the SLA expire rung must never raw-reject a content-publish row', () => {
  it('classifies content-publish as having reject side effects', () => {
    // `approvalSla`'s expire rung notifies instead of rejecting for kinds whose
    // REJECT runs feature state changes. For this kind a raw reject would flip
    // the row while the page stayed wedged in `in_review`. Nothing pinned it for
    // ANY kind, so a refactor collapsing the dispatch would regress silently.
    expect(kindHasRejectSideEffects('content-publish')).toBe(true);
    // The negative control — a plain run-proposal has no feature side effect, so
    // the assertion above cannot be satisfied by a function returning `true`.
    expect(kindHasRejectSideEffects('run-proposal')).toBe(false);
    expect(kindHasRejectSideEffects(undefined)).toBe(false);
  });
});

describe('CMSAU-4 — machine-draft provenance is derived from durable stamps, so it survives a resubmit', () => {
  it('carries `aiDraftedLocales` on the row and re-derives it on repin', async () => {
    const { c, orgId, tenantId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Localized',
      sections: [{ type: 'hero', data: { heading: 'Hello' }, localizations: { es: { heading: 'Hola' } }, aiDrafted: { es: new Date().toISOString() } }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);

    const appr = await pendingFor(c, pageId);
    expect(appr.aiDraftedLocales, 'the reviewer must be told the page carries machine drafts').toEqual(['es']);

    // RESUBMIT — the defect this closes: the one-shot English note was rebuilt
    // from THIS submit's sweep (missing-only, so it produced nothing) and the
    // repin OVERWROTE the disclosure, presenting the same unreviewed machine
    // drafts as provenance-clean.
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const after = await pendingFor(c, pageId);
    expect(after.approvalId, 'a resubmit repins the ONE open row').toBe(appr.approvalId);
    expect(after.aiDraftedLocales).toEqual(['es']);

    // …and it CLEARS honestly once a human replaces the drafts (the mirror
    // defect: stale disclosure outliving the content).
    const live = await c.get(u(orgId, `/pages/${pageId}`));
    const human = (live.body.sections as any[]).map((s) => ({ ...s, aiDrafted: undefined }));
    expect((await c.patch(u(orgId, `/pages/${pageId}`), { sections: human })).status).toBe(200);
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect((await pendingFor(c, pageId)).aiDraftedLocales).toBeUndefined();
    expect((await getApproval((await pendingFor(c, pageId)).approvalId))?.tenantId).toBe(tenantId);
  });
});

describe('CMSAU-5 / CMSA-9 — a rejection reaches the submitter with a reason', () => {
  it('persists the note from the CMS header lane and reads it back on the page', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Needs work', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    await c.post(u(orgId, `/pages/${pageId}/submit`));

    // The CMS header lane used to build its decide ctx without reading the body,
    // so a reason typed here vanished while the inbox lane persisted one.
    const rej = await c.post(u(orgId, `/pages/${pageId}/reject`), { note: 'Pricing table is out of date.' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.status).toBe('draft');

    const review = await c.get(u(orgId, `/pages/${pageId}/review`));
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.review.status).toBe('rejected');
    expect(review.body.review.note).toBe('Pricing table is out of date.');
    expect(review.body.review.decidedBy, 'a human rejection names its author').toBeTruthy();
    expect(review.body.review.resolvedAt).toBeTruthy();
  });

  it('reports a page that was never submitted as having no review', async () => {
    const { c, orgId } = await owner();
    const created = await c.post(u(orgId, '/pages'), { title: 'Fresh', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const review = await c.get(u(orgId, `/pages/${created.body.pageId}/review`));
    expect(review.status).toBe(200);
    expect(review.body.review).toBeNull();
  });
});

describe('CMSA-2c / CMSA-4 — the experiment-promote lane', () => {
  /** A page with a published snapshot, a running experiment, and a pending review. */
  async function experimentSetup(c: Client, orgId: string): Promise<{ pageId: string; experimentId: string; versionId: string }> {
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), { title: 'Exp', sections: [{ type: 'hero', data: { heading: 'v1' } }] });
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    const versions = await c.get(u(orgId, `/pages/${pageId}/versions`));
    const versionId = (versions.body.versions as any[])[0].versionId as string;
    const exp = await c.post(u(orgId, `/pages/${pageId}/experiments`), {
      name: 'Headline', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'B', versionId, weight: 50 }],
    });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    const experimentId = exp.body.experimentId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/experiments/${experimentId}/start`))).status).toBe(200);
    return { pageId, experimentId, versionId };
  }

  it('the gate-OFF promote arm closes the page pending review instead of stranding it (CMSA-2c)', async () => {
    const { c, orgId } = await owner();
    const { pageId, experimentId } = await experimentSetup(c, orgId);
    // A pending row exists from an earlier submit (post-C1, submit ALWAYS queues
    // regardless of the toggle — so this is the ordinary shape, not a contrivance).
    expect((await c.post(u(orgId, `/pages/${pageId}/unpublish`))).status).toBe(200);
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect(await pendingFor(c, pageId)).toBeTruthy();

    const appr = await pendingFor(c, pageId);
    const promote = await c.post(u(orgId, `/pages/${pageId}/experiments/${experimentId}/promote`), { variantKey: 'B' });
    expect(promote.status, JSON.stringify(promote.body)).toBe(200);
    expect(promote.body.pendingApproval).toBe(false);
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('published');
    expect(await pendingFor(c, pageId), 'the row must not survive against a published page').toBeUndefined();

    // ADR 0593 CORRECTION (review F5) — assert the recorded CAUSE, not merely the
    // row's absence. Absence was satisfied by `restoreVersion`'s own cascade, so
    // the promote arm's cleanup could be (and was) DEAD CODE while this test
    // stayed green: deleting the line entirely changed nothing. A closure that
    // records the wrong reason is a governance record that lies quietly.
    const closed = await getApproval(appr.approvalId);
    expect(closed?.status).toBe('rejected');
    expect(closed?.note, 'the governance record must name the promote, not a generic restore').toContain('experiment winner "B"');
    expect(closed?.decidedBy, 'a system closure names no human').toBeUndefined();
  });

  it('the gate-ON promote arm queues UNCONDITIONALLY (CMSA-4)', async () => {
    const { c, orgId } = await owner();
    const { pageId, experimentId } = await experimentSetup(c, orgId);
    await setGate('on');
    const promote = await c.post(u(orgId, `/pages/${pageId}/experiments/${experimentId}/promote`), { variantKey: 'B' });
    expect(promote.status, JSON.stringify(promote.body)).toBe(200);
    expect(promote.body.pendingApproval).toBe(true);
    const row = await pendingFor(c, pageId);
    expect(row, 'a submit always queues — never conditionally on a re-read toggle').toBeTruthy();
    expect(typeof row.pageVersion, 'and it is pinned, so the decision is version-checked').toBe('number');
  });
});

describe('repin cannot forge provenance on a decided row', () => {
  it('refuses `aiDraftedLocales` on a non-pending row', async () => {
    // The new field rides the same narrow repin the version pin does, so the
    // laundering guard must cover it too — otherwise a resolved row's
    // disclosure could be rewritten after the fact.
    const row = await createContentApproval({
      tenantId: 'org:repin-ai', orgId: 'org-1', pageId: 'page:z', pageTitle: 'T', pageVersion: 1, proposal: 'p', aiDraftedLocales: ['es'],
    });
    const { resolveApproval } = await import('../src/host/approvalService.js');
    await resolveApproval(row.approvalId, { status: 'approved', decidedBy: 'u1' });
    expect(await repinContentApproval(row.approvalId, { aiDraftedLocales: ['fr'] })).toBeNull();
    expect((await getApproval(row.approvalId))?.aiDraftedLocales).toEqual(['es']);
  });
});

describe('ADR 0593 class enumeration — SEO metadata was the SECOND read-time indirection', () => {
  // `CMSA-1` was found as an instance ("shared sections"); the class is "state
  // resolved at DELIVERY time that the approval's `page.version` pin cannot
  // see". Enumerating it turned up per-page SEO metadata in the PUBLISHING
  // feature: read at delivery (`publicPageBySlug` → `projectPublic`), never
  // pinned, and `workspace:write` — so a gated org's live `<title>`,
  // description, og image and canonical URL were rewritable with the inbox
  // empty. Not in any tracker; found by grepping the class, not the instance.
  const seo = (orgId: string, pageId: string): string =>
    `/v1/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;

  it('refuses an SEO write against a PUBLISHED page while the gate is ON', async () => {
    const { c, orgId } = await owner();
    await setGate('off');
    const created = await c.post(u(orgId, '/pages'), { title: 'Pricing', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    // The ungated write lands — proving the lane REACHES the store, so the
    // refusal below is a refusal and not a broken route.
    expect((await c.put(seo(orgId, pageId), { metaTitle: 'Reviewed title' })).status).toBe(200);

    await setGate('on');
    const blocked = await c.put(seo(orgId, pageId), { metaTitle: 'Rewritten live, unreviewed' });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('cms-approval-gate');
    const after = await c.get(seo(orgId, pageId));
    expect(after.body.seo.metaTitle).toBe('Reviewed title');
  });

  it('allows the SEO write on a DRAFT page while the gate is ON (the negative control)', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Draft', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const ok = await c.put(seo(orgId, created.body.pageId), { metaTitle: 'Fine' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('the losing concurrent decide is told the truth', () => {
  it('returns `changed:false` (⇒ "already approved") instead of the system-closure refusal', async () => {
    // HONESTY NOTE. The first version of this test drove the SECOND decide over
    // HTTP and passed a sabotage probe with the guard REMOVED — i.e. it was
    // VACUOUS. `loadPending` 409s a non-pending row before the dispatch ever
    // reaches the handler, so the route can never exercise this branch: the
    // window it guards opens only if the row flips BETWEEN `loadPending` and the
    // handler's own `getApproval`, which a single process never interleaves.
    //
    // So it is driven through the REGISTERED handler (`getContentApprovalHandler`
    // — the real function the dispatch table calls, not a mock) against real
    // orgs, real membership and the real store. Without the guard the handler
    // reads the page as `published`, treats it as a stranded subject, and throws
    // `review_closed` — telling the loser the SYSTEM closed their review when
    // another reviewer approved it.
    const { c, orgId, tenantId, userId } = await owner();
    await setGate('on');

    const created = await c.post(u(orgId, '/pages'), { title: 'Raced', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    const appr = await pendingFor(c, pageId);

    // The winner's decide lands through the ordinary route.
    expect((await c.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`)).status).toBe(200);
    expect((await c.get(u(orgId, `/pages/${pageId}`))).body.status).toBe('published');

    const handler = getContentApprovalHandler();
    expect(handler, 'the CMS feature registers its handler at boot').toBeTruthy();
    const loser = await handler!(tenantId, appr.approvalId, 'approved', { decidedByUserId: userId });
    expect(loser, 'the row exists and the decider is authorized — never a null').toBeTruthy();
    expect(loser!.changed, 'the dispatcher maps this to "Approval already approved."').toBe(false);
    expect(loser!.approval.status).toBe('approved');
    // …and the closure note was NOT written over the winner's decision.
    expect((await getApproval(appr.approvalId))?.note).toBeUndefined();
  });
});

// ── Adversarial-review fold-in (PR #3426) ───────────────────────────────────
// Two HIGH findings, both re-creating the CMSA-1 shape INSIDE the fix that was
// supposed to close the class. Enumerating a class is not the same as covering
// each member's arms: the shared-section gate refuses on `published` OR
// `in_review`, and its two siblings each shipped with only HALF of that.

describe('F1 — the SEO gate must cover `in_review`, not only `published`', () => {
  const seo = (orgId: string, pageId: string): string =>
    `/v1/host/openwop-app/publishing/orgs/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(pageId)}/seo`;

  it('refuses an SEO write against an IN-REVIEW page (the pin cannot see it)', async () => {
    // `putSeo` writes `publishing:seo`, which never moves `page.version`, and
    // delivery reads it live in `projectPublic`. So with the gate ON a
    // `workspace:write` editor could rewrite the canonical URL, title, og image
    // and `noindex` of a page ALREADY UNDER REVIEW, and the approve would ship
    // them: the reviewer signed off a body, and the head shipped rewritten.
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Launch', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = created.body.pageId as string;
    expect((await c.put(seo(orgId, pageId), { metaTitle: 'Reviewed head', canonicalUrl: 'https://acme.test/launch' })).status).toBe(200);
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);

    const blocked = await c.put(seo(orgId, pageId), { canonicalUrl: 'https://attacker.example/landing' });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('cms-approval-gate');

    // …and the approve does NOT ship a canonical the reviewer never saw.
    const appr = await pendingFor(c, pageId);
    expect((await c.post(`/v1/host/openwop-app/approvals/${appr.approvalId}/claim`)).status).toBe(200);
    expect((await c.get(seo(orgId, pageId))).body.seo.canonicalUrl).toBe('https://acme.test/launch');
  });

  it('still allows the SEO write on a DRAFT page (the arm that must stay open)', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    const created = await c.post(u(orgId, '/pages'), { title: 'Draft head', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    expect((await c.put(seo(orgId, created.body.pageId), { metaTitle: 'Fine' })).status).toBe(200);
  });
});

describe('F2 — releasing a withheld locale on a PUBLISHED page is a publish', () => {
  /** A published page with an `es` machine-draft overlay held back from delivery. */
  async function withheldLocalePage(c: Client, orgId: string): Promise<{ pageId: string; slug: string }> {
    await setToggle('cms-localization', 'on');
    await setGate('off');
    const settings = await c.put(u(orgId, '/language-settings'), { baseLocale: 'en', supportedLocales: ['es'] });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Pricing',
      sections: [{
        type: 'hero',
        data: { heading: 'Reviewed English' },
        localizations: { es: { heading: 'MACHINE DRAFT, never reviewed' } },
        aiDrafted: { es: new Date().toISOString() },
      }],
    });
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/es/unpublish`))).status).toBe(200);
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    return { pageId, slug: created.body.slug as string };
  }

  /** What an `Accept-Language: es` visitor is actually served. */
  async function servedEs(orgId: string, slug: string): Promise<unknown> {
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`, {
      headers: { 'accept-language': 'es' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    return (body.sections as any[])?.find((s) => s.type === 'hero')?.data?.heading;
  }

  it('refuses the release while the gate is ON — the withheld overlay stays withheld', async () => {
    const { c, orgId } = await owner();
    const { pageId, slug } = await withheldLocalePage(c, orgId);
    expect(await servedEs(orgId, slug), 'withheld ⇒ falls through to base').toBe('Reviewed English');

    await setGate('on');
    const release = await c.post(u(orgId, `/pages/${pageId}/locales/es/publish`));
    expect(release.status, JSON.stringify(release.body)).toBe(409);
    expect(JSON.stringify(release.body)).toContain('cms-approval-gate');
    expect(await servedEs(orgId, slug)).toBe('Reviewed English');
    expect(await pendingFor(c, pageId), 'and no review was ever raised for it').toBeUndefined();
  });

  it('WITHHOLDING stays open under the gate — removing content is the fail-safe direction', async () => {
    // The mirror of the `unpublish`/`schedule-unpublish` rule: the gate protects
    // the publish direction only. A fix that refused both would trap an operator
    // who needs to pull a bad translation down.
    const { c, orgId } = await owner();
    await setToggle('cms-localization', 'on');
    await setGate('off');
    await c.put(u(orgId, '/language-settings'), { baseLocale: 'en', supportedLocales: ['es'] });
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Live', sections: [{ type: 'hero', data: { heading: 'en' }, localizations: { es: { heading: 'es' } } }],
    });
    const pageId = created.body.pageId as string;
    expect((await c.post(u(orgId, `/pages/${pageId}/publish`))).status).toBe(200);
    await setGate('on');
    expect((await c.post(u(orgId, `/pages/${pageId}/locales/es/unpublish`))).status).toBe(200);
  });

  it('allows the release on a DRAFT page while the gate is ON (the negative control)', async () => {
    const { c, orgId } = await owner();
    await setToggle('cms-localization', 'on');
    await setGate('off');
    await c.put(u(orgId, '/language-settings'), { baseLocale: 'en', supportedLocales: ['es'] });
    const created = await c.post(u(orgId, '/pages'), {
      title: 'Draft loc', sections: [{ type: 'hero', data: { heading: 'en' }, localizations: { es: { heading: 'es' } } }],
    });
    await c.post(u(orgId, `/pages/${created.body.pageId}/locales/es/unpublish`));
    await setGate('on');
    expect((await c.post(u(orgId, `/pages/${created.body.pageId}/locales/es/publish`))).status).toBe(200);
  });
});

describe('F3 / F9 — the shared-section refusal names a verb that exists, and refuses only what it governs', () => {
  it('names `unpublish` for a live page and `approve or reject` for one under review', async () => {
    // The first version told the editor to "withdraw them from review". `grep -rn
    // withdraw` over the CMS backend and frontend returned exactly ONE hit — that
    // message. `unpublish` is `{from:['published','archived']}`, so it 409s for an
    // `in_review` page: the refusal prescribed an exit that does not exist, which
    // is the gate-with-no-exit shape this same batch closes on the page lane.
    const { c, orgId } = await owner();
    await setGate('off');
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'Nav', type: 'hero', data: { heading: 'a' } });
    const sharedSectionId = shared.body.sharedSectionId as string;
    const live = await c.post(u(orgId, '/pages'), { title: 'Live page', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }] });
    expect((await c.post(u(orgId, `/pages/${live.body.pageId}/publish`))).status).toBe(200);
    const reviewing = await c.post(u(orgId, '/pages'), { title: 'Reviewed page', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }] });
    await setGate('on');
    expect((await c.post(u(orgId, `/pages/${reviewing.body.pageId}/submit`))).status).toBe(200);

    const blocked = await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { heading: 'b' } });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    const msg = String(blocked.body.message);
    expect(msg, 'the live page names unpublish').toMatch(/"Live page".*unpublish/s);
    expect(msg, 'the in-review page names the decision, not a nonexistent withdraw').toMatch(/"Reviewed page".*approve or reject/s);
    expect(msg, 'never a verb the product does not ship').not.toMatch(/withdraw/i);
  });

  it('allows a NAME-only rename — delivery never reads it (F9)', async () => {
    // `resolveSharedRefs` delivers `type`/`data`/`localizations`. Refusing a
    // rename gated a write the gate does not govern, which trains people to
    // route around it.
    const { c, orgId } = await owner();
    await setGate('off');
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'Old name', type: 'hero', data: { heading: 'a' } });
    const sharedSectionId = shared.body.sharedSectionId as string;
    const page = await c.post(u(orgId, '/pages'), { title: 'Live', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }] });
    expect((await c.post(u(orgId, `/pages/${page.body.pageId}/publish`))).status).toBe(200);
    await setGate('on');

    expect((await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { name: 'New name' })).status).toBe(200);
    // …but the CONTENT write is still refused (the control that keeps the
    // allowance from becoming a hole).
    expect((await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { heading: 'b' } })).status).toBe(409);
  });
});
