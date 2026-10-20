/**
 * UX_UPGRADE-content ROUND 2 — the two ways live content reached readers without
 * the review the `cms-approval-gate` toggle promises.
 *
 *  - CMS2-B1: there are THREE paths to live content. `publish` and `schedule`
 *    both 409 when the gate is ON; `PATCH /pages/:pageId` did not, and it edits
 *    a PUBLISHED page's body IN PLACE — no approval row, no version snapshot,
 *    so the diff has no "before" either.
 *  - CMS2-M1: the approval row froze the page's TITLE and nothing else, while
 *    `transitionPage('approve')` re-checked only `from:['in_review']` and then
 *    stamped whatever the page contained AT DECIDE TIME. A submitter could keep
 *    editing an in-review page (PATCH allows it at admin tier), so the reviewer
 *    published content they had never read, under their own name.
 *
 * Route-level, because both defects are in the wiring: a service-level test
 * drives `transitionPage` / `updatePage` directly and never sees either gate.
 *
 * Sabotage-witnessed (/grade-tests w16): removing the published-page PATCH gate,
 * the system-site exemption, the resubmit re-pin, the repin pending guard, the
 * pending-only filter in `findPendingContentApprovalForPage`, the shared-section
 * gate, either live-edit state arm, or `liveEditGateActive`'s toggle read reds the
 * named case. HONEST DOUBLE GUARD: `stale_review` is enforced twice (the pre-CAS
 * read in `decideContentPublish` and the `expectedVersion` precondition in
 * `transitionPage`, whose refusal re-opens the row); disabling either alone leaves
 * "refuses to publish a page that changed…" green by design.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { SYSTEM_SITE_ORG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';
import { createContentApproval, findPendingContentApprovalForPage, getApproval, getContentApprovalHandler, repinContentApproval, resolveApproval } from '../src/host/approvalService.js';
import { assertFlatErrorEnvelope } from './helpers/errorEnvelope.js';

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

const setGate = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cms-approval-gate');
  expect(d, 'cms-approval-gate toggle must be declared').toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};

interface ApprovalRow { approvalId: string; kind?: string; pageId?: string; pageVersion?: number }
interface SectionBody { type: string; data: { heading?: string } }
interface PageRow { pageId: string; title: string; status: string }
/** The success-body fields this file reads (error bodies go through `assertFlatErrorEnvelope`). */
interface Body {
  orgId: string; pageId: string; slug: string; status: string; title: string;
  sections: SectionBody[]; items: ApprovalRow[]; pages: PageRow[];
  personal: string; sharedSectionId: string;
}
interface Res { status: number; body: Body }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
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
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function owner(): Promise<{ c: Client; orgId: string }> {
  const tenantId = `org:gatebypass-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `gb-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId };
}
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function publishedPage(c: Client, orgId: string): Promise<string> {
  await setGate('off'); // publish directly, then turn the gate on for the test
  const r = await c.post(u(orgId, '/pages'), { title: 'Pricing 2026', sections: [{ type: 'hero', data: { heading: 'Old copy' } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const pageId = r.body.pageId;
  const pub = await c.post(u(orgId, `/pages/${pageId}/publish`));
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  expect(pub.body.status).toBe('published');
  return pageId;
}

const heroOf = (page: Pick<Body, 'sections'>): unknown => page.sections.find((s) => s.type === 'hero')?.data.heading;

/** One typed reader for the open content-publish row of a page (was two untyped copies). */
async function pendingFor(c: Client, pageId: string): Promise<ApprovalRow | undefined> {
  const list = await c.get('/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return list.body.items.find((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

describe('CMS2-B1 — PATCH was the third, ungated path to live content', () => {
  it('refuses to edit a PUBLISHED page in place while the gate is ON', async () => {
    const { c, orgId } = await owner();
    const pageId = await publishedPage(c, orgId);
    await setGate('on');

    const patch = await c.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ type: 'hero', data: { heading: 'Rewritten live, unreviewed' } }],
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(assertFlatErrorEnvelope(patch.body, 'PATCH refusal').details?.gate).toBe('cms-approval-gate');

    // …and the live page is untouched — the defect was a 200 that changed it.
    const live = await c.get(u(orgId, `/pages/${pageId}`));
    expect(heroOf(live.body)).toBe('Old copy');
  });

  it('still allows the edit when the gate is OFF (the negative control)', async () => {
    const { c, orgId } = await owner();
    const pageId = await publishedPage(c, orgId);
    await setGate('off');

    const patch = await c.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ type: 'hero', data: { heading: 'Ungated edit' } }],
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(heroOf(patch.body)).toBe('Ungated edit');
  });

  it('DRAFT editing is unaffected by the gate — that is the whole authoring flow', async () => {
    const { c, orgId } = await owner();
    await setGate('on');
    const r = await c.post(u(orgId, '/pages'), { title: 'Draft', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pageId = r.body.pageId;
    const patch = await c.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'b' } }] });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(heroOf(patch.body)).toBe('b');
  });
});

describe('CMS2-M1 — approve what you saw', () => {

  it('refuses to publish a page that changed after it was submitted', async () => {
    await setGate('on');
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Pricing 2026', sections: [{ type: 'hero', data: { heading: 'Reviewed copy' } }] });
    const pageId = r.body.pageId;
    const sub = await c.post(u(orgId, `/pages/${pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);

    const appr = await pendingFor(c, pageId);
    expect(appr, 'submit should queue a content-publish approval').toBeTruthy();
    // The row now carries WHAT is being approved, not just its name.
    expect(typeof appr!.pageVersion).toBe('number');

    // The submitter edits the in-review page — allowed at admin tier, and the
    // reason the reviewer's card can no longer be trusted on its own.
    const edit = await c.patch(u(orgId, `/pages/${pageId}`), {
      sections: [{ type: 'hero', data: { heading: 'Swapped in after review' } }],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    const approve = await c.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status, JSON.stringify(approve.body)).toBe(409);
    expect(assertFlatErrorEnvelope(approve.body, 'approve refusal').details?.reason).toBe('stale_review');

    // The page did NOT go live, and the approval was not consumed — the
    // submitter can resubmit, and the reviewer can decide the real content.
    const after = await c.get(u(orgId, `/pages/${pageId}`));
    expect(after.body.status).toBe('in_review');
    expect(await pendingFor(c, pageId)).toBeTruthy();
  });

  it('publishes normally when the page is unchanged since submit (the negative control)', async () => {
    await setGate('on');
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Clean', sections: [{ type: 'hero', data: { heading: 'Reviewed copy' } }] });
    const pageId = r.body.pageId;
    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);

    const approve = await c.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.status).toBe('published');
    expect(heroOf(approve.body)).toBe('Reviewed copy');
  });

  it('a REJECT is never blocked by staleness — refusing content you did not see is always safe', async () => {
    await setGate('on');
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Rejectable', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = r.body.pageId;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    await c.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'b' } }] });

    const reject = await c.post(u(orgId, `/pages/${pageId}/reject`));
    expect(reject.status, JSON.stringify(reject.body)).toBe(200);
    expect(reject.body.status).toBe('draft');
  });
});

describe('CMS2-M1 fold-in — the remedy the 409 prescribes must actually work', () => {

  it('a RESUBMIT re-pins the open approval, so an edited in-review page can still be published', async () => {
    // THE DEAD END THIS PINS. The first cut of M1 pinned the version at submit
    // and nothing ever re-pinned it: `submit` was draft-only, so the 409's own
    // instruction ("submit it again") was itself a 409, and an admin who edited
    // an in-review page — which the PATCH route deliberately allows, so a
    // reviewer's requested change can be made — left the page permanently
    // unapprovable. The ONLY escape was `reject`, which fires a rejection event
    // and audit row against content the reviewer actually wanted.
    await setGate('on');
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Iterating', sections: [{ type: 'hero', data: { heading: 'v1' } }] });
    const pageId = r.body.pageId;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    const first = (await pendingFor(c, pageId))!;
    expect(typeof first.pageVersion).toBe('number');

    await c.patch(u(orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'v2, as the reviewer asked' } }] });
    expect((await c.post(u(orgId, `/pages/${pageId}/approve`))).status).toBe(409);

    // The remedy, verbatim from the 409 message.
    const resubmit = await c.post(u(orgId, `/pages/${pageId}/submit`));
    expect(resubmit.status, JSON.stringify(resubmit.body)).toBe(200);
    expect(resubmit.body.status).toBe('in_review');

    // Still exactly ONE open row — re-pinned, not duplicated.
    const list = await c.get('/host/openwop-app/approvals?status=pending');
    const rows = list.body.items.filter((a) => a.kind === 'content-publish' && a.pageId === pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approvalId).toBe(first.approvalId);
    expect(rows[0]!.pageVersion).toBeGreaterThan(first.pageVersion!);

    const approve = await c.post(u(orgId, `/pages/${pageId}/approve`));
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    expect(approve.body.status).toBe('published');
    expect(heroOf(approve.body)).toBe('v2, as the reviewer asked');
  });

  it('a rejected page resubmits into a NEW row — the rejected one is not reopened', async () => {
    await setGate('on');
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Rejected then resubmitted', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    const pageId = r.body.pageId;
    await c.post(u(orgId, `/pages/${pageId}/submit`));
    const before = (await pendingFor(c, pageId))!;
    expect((await c.post(u(orgId, `/pages/${pageId}/reject`))).status).toBe(200);

    expect((await c.post(u(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const after = await pendingFor(c, pageId);
    expect(after, 'the resubmit must open a pending row').toBeTruthy();
    expect(after!.approvalId).not.toBe(before.approvalId);
    // …and the rejected row stays rejected (not reopened).
    expect((await getApproval(before.approvalId))?.status).toBe('rejected');
  });

  it('repinContentApproval REFUSES a row that is no longer pending', async () => {
    // The route-level test above does NOT reach this guard — after a reject the
    // page is `draft`, so the resubmit takes the create-a-new-row branch and
    // `repinContentApproval` is never called. A sabotage probe proved exactly
    // that (removing the `status !== 'pending'` check left it green), so the
    // guard is asserted HERE, directly, where it is reachable. Without it a
    // resubmit would be a way to launder a decided row back into the inbox.
    const decided = await createContentApproval({
      tenantId: 'org:repin-guard', orgId: 'org-1', pageId: 'page:x', pageTitle: 'Before', pageVersion: 1, proposal: 'p',
    });
    await resolveApproval(decided.approvalId, { status: 'rejected', decidedBy: 'u1' });

    expect(await repinContentApproval(decided.approvalId, { pageTitle: 'After', pageVersion: 2 })).toBeNull();
    const after = await getApproval(decided.approvalId);
    expect(after?.status).toBe('rejected');
    expect(after?.pageTitle).toBe('Before');   // untouched
    expect(after?.pageVersion).toBe(1);

    // The positive control — the same call on a PENDING row does re-pin, so the
    // assertions above cannot be satisfied by a helper that never writes.
    const open = await createContentApproval({
      tenantId: 'org:repin-guard', orgId: 'org-1', pageId: 'page:y', pageTitle: 'Before', pageVersion: 1, proposal: 'p',
    });
    expect(await repinContentApproval(open.approvalId, { pageTitle: 'After', pageVersion: 2 })).toBeTruthy();
    expect((await getApproval(open.approvalId))?.pageVersion).toBe(2);
  });
});

describe('CMS2-B1 fold-in — the reserved system-site org is not gated', () => {
  it('lets a superadmin edit the live marketing site while the gate is ON', async () => {
    // Gating it made the public site UNRECOVERABLE: the prescribed remedy takes
    // `/` and every docs page offline, and the resubmit then dead-ends because
    // `decideContentPublish` demands `host:members:manage` IN THE PAGE'S ORG —
    // authority a superadmin does not hold in a reserved org nobody is a member
    // of. An org-review gate is structurally inapplicable with no org to review
    // within.
    //
    // The first version of this test logged in normally, found the reserved org
    // 404s for a non-superadmin (`cmsScope.ts` hides it), and RETURNED EARLY —
    // asserting nothing while reading green. Real superadmin is established here.
    await setGate('on');
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `sa-${Date.now()}-${n++}@acme.test`, tenantId: `org:sysgate-${Date.now()}-${n++}` });
    const who = await c.get('/host/openwop-app/me/workspaces');
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    process.env.OPENWOP_SUPERADMIN_TENANTS = who.body.personal;
    try {
      const pages = await c.get(u(SYSTEM_SITE_ORG, '/pages'));
      expect(pages.status, JSON.stringify(pages.body)).toBe(200);
      const home = pages.body.pages.find((p) => p.status === 'published');
      expect(home, 'the seeded system site should have a published page').toBeTruthy();

      // A REAL edit (the old body re-sent the unchanged title, so a 200 no-op passed).
      const edited = `${home!.title} (edited)`;
      const patch = await c.patch(u(SYSTEM_SITE_ORG, `/pages/${home!.pageId}`), { title: edited });
      expect(patch.status, JSON.stringify(patch.body)).toBe(200);
      expect(patch.body.title).toBe(edited);
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });

  it('a NON-system published page in a real org is still gated (the negative control)', async () => {
    // Without this, the exemption above would be satisfied by removing the gate
    // entirely — which is the defect CMS2-B1 exists to close.
    const { c, orgId } = await owner();
    const pageId = await publishedPage(c, orgId);
    await setGate('on');
    expect((await c.patch(u(orgId, `/pages/${pageId}`), { title: 'x' })).status).toBe(409);
  });
});

describe('MyndHyve B2 — a superadmin decides system-site reviews', () => {
  // `decideContentPublish` required `host:members:manage` IN THE PAGE'S ORG, and the
  // reserved system-site org has no members, so a superadmin who can edit, submit and
  // publish there got 403 on approve and reject. The authority that edits the system
  // site (ADR 0027, `requireCmsScope` → superadmin) now decides its reviews too.
  async function asSuperadmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `sa-b2-${Date.now()}-${n++}@acme.test`, tenantId: `org:sysb2-${Date.now()}-${n++}` });
    const who = await c.get('/host/openwop-app/me/workspaces');
    expect(who.status, JSON.stringify(who.body)).toBe(200);
    process.env.OPENWOP_SUPERADMIN_TENANTS = who.body.personal;
    try { return await fn(c); } finally { delete process.env.OPENWOP_SUPERADMIN_TENANTS; }
  }
  async function submittedSystemPage(c: Client, title: string): Promise<string> {
    const r = await c.post(u(SYSTEM_SITE_ORG, '/pages'), { title, sections: [{ type: 'hero', data: { heading: title } }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const sub = await c.post(u(SYSTEM_SITE_ORG, `/pages/${r.body.pageId}/submit`));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('in_review');
    return r.body.pageId;
  }

  it('approve publishes the page', async () => {
    await asSuperadmin(async (c) => {
      const pageId = await submittedSystemPage(c, `B2 approve ${n++}`);
      const approve = await c.post(u(SYSTEM_SITE_ORG, `/pages/${pageId}/approve`));
      expect(approve.status, JSON.stringify(approve.body)).toBe(200);
      expect(approve.body.status).toBe('published');
    });
  });

  it('reject returns the page to draft', async () => {
    await asSuperadmin(async (c) => {
      const pageId = await submittedSystemPage(c, `B2 reject ${n++}`);
      const reject = await c.post(u(SYSTEM_SITE_ORG, `/pages/${pageId}/reject`), { note: 'not yet' });
      expect(reject.status, JSON.stringify(reject.body)).toBe(200);
      expect(reject.body.status).toBe('draft');
    });
  });

  it('a non-superadmin still cannot see the system site, so cannot decide there', async () => {
    const pageId = await asSuperadmin((c) => submittedSystemPage(c, `B2 hidden ${n++}`));
    const { c } = await owner();
    expect((await c.post(u(SYSTEM_SITE_ORG, `/pages/${pageId}/approve`))).status).toBe(404);
  });

  it('the superadmin allowance is the system site only: in a real org the handler still demands the org scope', async () => {
    // HTTP alone cannot witness this: `requireCmsScope` hides a real org from a
    // non-member superadmin before the handler runs. So call the handler with the
    // flag set, as a future route that threads `decidedBySuperadmin` would.
    const { c, orgId } = await owner();
    const r = await c.post(u(orgId, '/pages'), { title: 'Real org', sections: [{ type: 'hero', data: { heading: 'a' } }] });
    expect((await c.post(u(orgId, `/pages/${r.body.pageId}/submit`))).status).toBe(200);
    const row = await pendingFor(c, r.body.pageId);
    const approval = await getApproval(row!.approvalId);
    await expect(getContentApprovalHandler()!(approval!.tenantId, approval!.approvalId, 'approved', {
      decidedByUserId: 'user:not-a-member', isSuperadmin: true,
    })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect((await getApproval(row!.approvalId))?.status).toBe('pending');
  });

  it('on the system site the handler still refuses a decider who is not a superadmin', async () => {
    const pageId = await asSuperadmin((c) => submittedSystemPage(c, `B2 flag ${n++}`));
    const open = await findPendingContentApprovalForPage(SYSTEM_SITE_TENANT, pageId);
    await expect(getContentApprovalHandler()!(SYSTEM_SITE_TENANT, open!.approvalId, 'approved', {
      decidedByUserId: 'user:anyone',
    })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
});

// ── ADR 0593 D1 (CMSA-1) — the FOURTH path to live content ──────────────────
// CMS2-B1 gated the published-page PATCH and called it "the THIRD path to live
// content, and the only one that was not gated". It missed reference
// indirection: `updateSharedSection` needs only `workspace:write`, has no gate
// check, and delivery resolves `section.ref` to the shared row's CURRENT data at
// READ time (`resolveSharedRefs`). So on a gated org an editor rewrites LIVE
// published content instantly with the inbox empty — and, because `page.version`
// never moves, the approve-what-you-saw pin is blind to it too.

/** A published page whose only section is a REFERENCE to a shared section. */
async function sharedRefPage(c: Client, orgId: string): Promise<{ pageId: string; slug: string; sharedSectionId: string }> {
  await setGate('off');
  const shared = await c.post(u(orgId, '/shared-sections'), {
    name: 'Site footer', type: 'hero', data: { heading: 'Reviewed copy' },
  });
  expect(shared.status, JSON.stringify(shared.body)).toBe(201);
  const sharedSectionId = shared.body.sharedSectionId;
  const page = await c.post(u(orgId, '/pages'), {
    title: 'Home', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }],
  });
  expect(page.status, JSON.stringify(page.body)).toBe(201);
  const pub = await c.post(u(orgId, `/pages/${page.body.pageId}/publish`));
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { pageId: page.body.pageId, slug: page.body.slug, sharedSectionId };
}

/** What a real visitor is served — the delivery lane that resolves the ref. */
async function liveHeading(orgId: string, slug: string): Promise<unknown> {
  const res = await fetch(`${BASE}/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}`);
  expect(res.status, 'the public delivery lane must actually serve this page').toBe(200);
  const body = (await res.json()) as { sections?: SectionBody[] };
  return body.sections?.find((s) => s.type === 'hero')?.data?.heading;
}

describe('CMSA-1 — shared sections were an ungated fourth lane to live content', () => {
  it('refuses a shared-section edit that would rewrite a PUBLISHED page while the gate is ON', async () => {
    const { c, orgId } = await owner();
    const { slug, sharedSectionId } = await sharedRefPage(c, orgId);
    expect(await liveHeading(orgId, slug), 'the ref must actually resolve into delivery').toBe('Reviewed copy');

    await setGate('on');
    const patch = await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), {
      data: { heading: 'Rewritten live, unreviewed' },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    const env = assertFlatErrorEnvelope(patch.body, 'shared-section refusal');
    expect(env.details?.gate).toBe('cms-approval-gate');
    // A refusal with no exit is the shape this batch is closing elsewhere — the
    // 409 must NAME the pages that block it.
    expect(env.details?.pages, JSON.stringify(patch.body)).toBeTruthy();
    expect((env.details?.pages as PageRow[]).map((p) => p.status)).toContain('published');

    // …and the live page is untouched. The defect was a 200 that changed it.
    expect(await liveHeading(orgId, slug)).toBe('Reviewed copy');
  });

  it('refuses while a referencing page is IN REVIEW — the pin cannot see a shared edit', async () => {
    // The second half of the Blocker: `page.version` never moves when a shared
    // row changes, so `stale_review` cannot fire and the reviewer's name goes on
    // content they never read. Closing the WRITE closes the blindness.
    const { c, orgId } = await owner();
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'CTA', type: 'hero', data: { heading: 'Reviewed CTA' } });
    const sharedSectionId = shared.body.sharedSectionId;
    const page = await c.post(u(orgId, '/pages'), { title: 'Launch', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }] });
    await setGate('on');
    expect((await c.post(u(orgId, `/pages/${page.body.pageId}/submit`))).status).toBe(200);

    const patch = await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { heading: 'Swapped under the reviewer' } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect((assertFlatErrorEnvelope(patch.body, 'in-review refusal').details?.pages as PageRow[]).map((p) => p.status)).toContain('in_review');
  });

  it('allows the same edit when only DRAFT pages reference it (the negative control)', async () => {
    // Without this the gate above would be satisfied by refusing every shared
    // edit on a gated org, which is not the invariant — draft content is exactly
    // what the review flow exists to let people work on.
    const { c, orgId } = await owner();
    const shared = await c.post(u(orgId, '/shared-sections'), { name: 'Draft-only', type: 'hero', data: { heading: 'a' } });
    const sharedSectionId = shared.body.sharedSectionId;
    await c.post(u(orgId, '/pages'), { title: 'Draft page', sections: [{ type: 'hero', data: {}, ref: { sharedSectionId } }] });
    await setGate('on');
    const patch = await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { heading: 'b' } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  });

  it('allows the edit when the gate is OFF (the second negative control)', async () => {
    const { c, orgId } = await owner();
    const { slug, sharedSectionId } = await sharedRefPage(c, orgId);
    await setGate('off');
    const patch = await c.patch(u(orgId, `/shared-sections/${sharedSectionId}`), { data: { heading: 'Ungated shared edit' } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(await liveHeading(orgId, slug)).toBe('Ungated shared edit');
  });
});
