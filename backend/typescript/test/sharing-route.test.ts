/**
 * Sharing (ADR 0013) — ROUTE-level harness. Drives both surfaces: the AUTHED
 * link management (RBAC-gated mint/list/revoke) and the PUBLIC, unauthenticated
 * token resolve — including the value-add over Publishing (sharing a DRAFT page),
 * a KB-collection overview share, the social card, and revoke/toggle-off gating.
 *
 * Sabotage-witnessed (w7 /grade-tests): mint or revoke gated on `workspace:read`
 * · revoke not persisted · the resourceType / expiresInDays / maxViews validators
 * loosened · the label dropped from resolve · views not accumulating · the card
 * consuming a view, or not enforcing the cap · the revoked gate removed from
 * `resolveActiveLink` (caught on the CARD lane, which has no second guard) · the
 * cms delete cascade skipped · cms/kb markdown or the kb name dropped · expiry
 * collapsed to a 404 · `lastViewedAt` not stamped.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { ShareLink } from '../src/features/sharing/sharingService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // `sharing` is always-on since ADR 0434 — only its composed features need enabling.
  for (const id of ['users', 'cms', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The host error envelope (`errorEnvelope.ts`). */
interface ErrorBody { error: string; message?: string; details?: Record<string, unknown> }
type ListedLink = ShareLink & { cardTitle?: string; resourceMissing?: boolean; featureDisabled?: boolean };
interface ListBody { links: ListedLink[] }
type MintBody = ShareLink & { token: string };
interface SharedBody { resourceType: string; label?: string; resource: Record<string, unknown> }
interface CardBody { title: string; description: string }
interface Res<T> { status: number; body: T }
/** Typed per call at the JSON boundary — the one place a wire body becomes a product type. */
type Call = <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client { get: Call; post: Call; del: Call }
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('shr'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  // Co-tenant owner + member: mint each into one shared explicit tenantId.
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}

async function draftPage(owner: Client, orgId: string, title: string): Promise<string> {
  const r = await owner.post<{ pageId: string; status: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title, sections: [{ type: 'hero', data: { heading: 'Hi', subheading: 'Card description text.' } }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.status).toBe('draft');
  return r.body.pageId;
}

const STRANGER_REVOKE_STATUS = 404;
const links = (orgId: string): string => `/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;
const shared = (token: string, s = ''): string => `/host/openwop-app/shared/${encodeURIComponent(token)}${s}`;
const mintLink = (c: Client, orgId: string, body: Record<string, unknown>): Promise<Res<MintBody>> => c.post<MintBody>(links(orgId), body);
const listLinks = async (c: Client, orgId: string): Promise<ListedLink[]> => (await c.get<ListBody>(links(orgId))).body.links;

describe('sharing — link management (RBAC)', () => {
  it('owner mints + lists + revokes; viewer lists but cannot mint/revoke (403)', async () => {
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Page A');

    const mint = await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, label: 'Review link' });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    expect(mint.body.token).toBeTruthy();
    expect(mint.body.revoked).toBe(false);
    const tokenPath = `${links(orgId)}/${encodeURIComponent(mint.body.token)}`;

    const list = await member.get<ListBody>(links(orgId));
    expect(list.status).toBe(200);
    expect(list.body.links[0]!.cardTitle).toBe('Page A');

    expect((await member.post(links(orgId), { resourceType: 'cms_page', resourceId: pageId })).status).toBe(403);
    expect((await listLinks(owner, orgId)).length, 'the refused mint wrote nothing').toBe(1);
    expect((await member.del(tokenPath)).status).toBe(403);
    // The refused revoke left the link LIVE (a 403 alone does not show that).
    expect((await client().get(shared(mint.body.token))).status).toBe(200);
    expect((await owner.del(tokenPath)).status).toBe(204);
    // …and the owner's revoke actually landed: persisted, and the public lane is dark.
    expect((await listLinks(owner, orgId)).find((l) => l.tokenHash === mint.body.tokenHash)?.revoked).toBe(true);
    expect((await client().get(shared(mint.body.token))).status).toBe(404);
    // Idempotent revoke; a non-existent token 404s.
    expect((await owner.del(tokenPath)).status).toBe(204);
    expect((await owner.del(`${links(orgId)}/nope`)).status).toBe(404);
  });

  it('rejects an unknown resourceType (400) and a resource not in the org (404)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const badType = await owner.post(links(orgId), { resourceType: 'nope', resourceId: 'x' });
    expect(badType.status).toBe(400);
    expect(badType.body).toMatchObject({ error: 'validation_error', details: { field: 'resourceType' } });
    const missing = await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: 'no-such-page' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    const badExpiry = await owner.post(links(orgId), { resourceType: 'cms_page', resourceId: 'x', expiresInDays: -1 });
    expect(badExpiry.status).toBe(400);
    expect(badExpiry.body).toMatchObject({ error: 'validation_error', details: { field: 'expiresInDays' } });
    expect(await listLinks(owner, orgId), 'no refused mint wrote a row').toEqual([]);
  });
});

describe('sharing — public resolve (unauthenticated)', () => {
  it('resolves a DRAFT CMS page by token (what the published-only public surface cannot serve)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Secret Draft');
    const mint = await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, label: 'preview' });
    const token = mint.body.token;

    const anon = client(); // NO cookie
    const r = await anon.get<SharedBody>(shared(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.resourceType).toBe('cms_page');
    expect(r.body.label).toBe('preview');
    expect(r.body.resource.title).toBe('Secret Draft');
    expect(r.body.resource.status).toBe('draft');

    const card = await anon.get<CardBody>(shared(token, '/card'));
    expect(card.status).toBe(200);
    expect(card.body.title).toBe('Secret Draft');
    expect(card.body.description).toBe('Card description text.');
  });

  it('PUB-7: enforces a per-link view cap on content (card preview is exempt)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Capped');
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, maxViews: 2 })).body.token;
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(200);  // view 1
    expect((await anon.get(shared(token))).status).toBe(200);  // view 2
    expect((await anon.get(shared(token))).status).toBe(404);  // over the cap → uniform 404
    // SHWF-2 / ADR 0644 D2 — this assertion USED TO READ `.toBe(200)` here, with a
    // comment claiming the card path "does not consume OR ENFORCE the cap". The
    // first half is the real requirement (an unfurl must never burn a recipient's
    // view); the second half was a defect PINNED AS CORRECT — an exhausted
    // burn-after-reading link kept serving the resource's LIVE title and
    // description forever, unauthenticated, on a lane with no in-repo consumer.
    // The card now ENFORCES without CONSUMING. Both halves are asserted below.
    expect((await anon.get(shared(token, '/card'))).status).toBe(404);
  });

  it('SHWF-2: the card enforces the cap WITHOUT consuming a view', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'CardCap');
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, maxViews: 1 })).body.token;
    const anon = client();
    // Does NOT consume: three unfurls in a row, then the single content view still works.
    expect((await anon.get(shared(token, '/card'))).status).toBe(200);
    expect((await anon.get(shared(token, '/card'))).status).toBe(200);
    expect((await anon.get(shared(token, '/card'))).status).toBe(200);
    expect((await anon.get(shared(token))).status).toBe(200);   // the recipient's one view survived
    // DOES enforce: the budget is now spent, so the metadata lane goes dark too.
    expect((await anon.get(shared(token))).status).toBe(404);
    expect((await anon.get(shared(token, '/card'))).status).toBe(404);
  });

  // SHWF-7 / ADR 0644 D6 — the cap's CONCURRENCY witness deliberately does NOT live
  // here. A route-level `Promise.all` of two views on a maxViews:1 link reads like a
  // race test and is VACUOUS: MEASURED by sabotage, replacing the compare-and-swap in
  // `countShareViewOrThrow` with a plain put left the route-level version GREEN,
  // because two requests routed through HTTP do not interleave at the
  // read-modify-write. The load-bearing version is service-level, in
  // `sharing-owning-feature-gate.test.ts` ("two CONCURRENT views…"), where the same
  // sabotage turns it red. Do not "restore" an HTTP-level race test here.

  it('PUB-7: rejects a non-positive / oversized maxViews at mint (400)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'BadCap');
    expect((await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, maxViews: 0 })).status).toBe(400);
    expect((await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, maxViews: 2.5 })).status).toBe(400);
  });

  it('404s a revoked link and an unknown/garbage token (the token IS the credential)', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Live');
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId })).body.token;
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(200);

    // garbage / unknown token
    expect((await anon.get(shared('not a real token!!'))).status).toBe(404);
    expect((await anon.get(shared('Zm9vYmFy'))).status).toBe(404);

    // revoke → 404, on BOTH public read lanes. The card leg is the discriminating
    // one: content resolve has a second revoked check in `countShareViewOrThrow`,
    // so with `resolveActiveLink`'s check removed it still 404s (measured — that
    // probe stayed green); the card lane has no second guard.
    expect((await owner.del(`${links(orgId)}/${encodeURIComponent(token)}`)).status).toBe(204);
    expect((await anon.get(shared(token))).status).toBe(404);
    expect((await anon.get(shared(token, '/card'))).status).toBe(404);

    // ADR 0434 — `sharing` graduated to always-on, so there is no longer a toggle
    // leg here. The gates that DO hold the public surface are asserted above and
    // below: charset, unknown token, revocation, expiry, and org↔tenant binding,
    // each a uniform 404. A fresh valid link keeps resolving.
    const token2 = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId })).body.token;
    expect((await anon.get(shared(token2))).status).toBe(200);
    expect((await anon.get(shared(token2, '/card'))).status).toBe(200);
  });

  it('a cross-org caller cannot revoke another org link (IDOR → 404), and a deleted resource 404s the link', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Doomed');
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId })).body.token;

    // A different tenant's user can't revoke this org's link (not a member → 404/403).
    const stranger = client();
    await signup(stranger);
    // SHWF-13 / ADR 0644 — was `expect([403, 404]).toContain(...)`. 403 and 404 are
    // materially DIFFERENT answers to "does this org's link exist", so accepting
    // both meant the test could not detect an existence-leak regression in either
    // direction. Pinned to the value the route actually returns.
    expect((await stranger.del(`${links(orgId)}/${encodeURIComponent(token)}`)).status).toBe(STRANGER_REVOKE_STATUS);
    // The claim is "cannot revoke", not "gets a 404": the link is still live.
    expect((await client().get(shared(token))).status).toBe(200);

    // SHWF-8 / ADR 0644 D7 — this used to assert ONLY the 404 below, under the
    // comment "the link resolves to a gone resource". That assertion passes WITH OR
    // WITHOUT the delete cascade, because `cms_page.load` re-reads the page and
    // returns null either way — so it witnessed the resolver's fail-closed read and
    // was read by everyone as witnessing `purgeLinksForResource`. The two costs the
    // cascade actually retires are unbounded row growth outside the sweep's reach
    // and `hasActiveLinkForResource` reporting true for an orphan; neither is
    // observable through the public 404. Assert the ROW.
    expect((await listLinks(owner, orgId)).some((l) => l.resourceId === pageId)).toBe(true);
    await owner.del(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pageId}`);
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(404);
    // The cascade, actually witnessed: the owner's link list no longer carries it.
    expect((await listLinks(owner, orgId)).some((l) => l.resourceId === pageId)).toBe(false);
  });
});

describe('R2 SR-1 — cms/kb shares carry a RENDERED markdown body (the Blocker: the viewer showed "Nothing to show here")', () => {
  it('cms_page resolve prerenders sections to markdown — text content in, live sections honestly noted', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const r = await owner.post<{ pageId: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, {
      title: 'Landing', sections: [
        { type: 'hero', data: { heading: 'Build faster', subheading: 'Ship the thing.' } },
        { type: 'richText', data: { heading: 'How it works', text: 'Step one. Step two.' } },
        { type: 'faq', data: { items: [{ q: 'Is it good?', a: 'Yes.' }] } },
        { type: 'form', data: { formId: 'f-123' } },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: r.body.pageId })).body.token;

    const res = await client().get<SharedBody>(shared(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const md = String(res.body.resource.markdown);
    expect(md).toContain('# Build faster');
    expect(md).toContain('Ship the thing.');
    expect(md).toContain('## How it works');
    expect(md).toContain('Step one. Step two.');
    expect(md).toContain('### Is it good?');
    expect(md).toContain('Yes.');
    // The live form section is NOTED, not silently dropped — the shared view
    // must not present a lead-capture page as if it had no form.
    expect(md).toContain('isn’t included in this shared view');
  });

  // Absorbs the former "resolves a KB-collection overview by token" case, which
  // built the identical fixture to assert the structured `name` + `documents`.
  it('kb_collection resolve prerenders name/description/documents to markdown', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const col = await owner.post<{ collectionId: string }>(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`, { name: 'Handbook', description: 'Everything we know.' });
    const cid = col.body.collectionId;
    await owner.post(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${cid}/documents`, { title: 'Doc One', text: 'hello world' });
    const token = (await mintLink(owner, orgId, { resourceType: 'kb_collection', resourceId: cid })).body.token;

    const res = await client().get<SharedBody>(shared(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const md = String(res.body.resource.markdown);
    expect(md).toContain('Everything we know.');
    expect(md).toContain('- Doc One');
    expect(md).toContain('document(s)');
    // The structured overview stays on the wire beside the markdown.
    expect(res.body.resource.name).toBe('Handbook');
    expect((res.body.resource.documents as Array<{ title: string }>)[0]!.title).toBe('Doc One');
  });
});

describe('R2 SR-10 — expired says EXPIRED (410); revoked and never-existed stay uniform 404', () => {
  it('an expired link resolves 410 {reason: expired}; revoked and garbage resolve identical 404s', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Expiring');
    const mint = await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId, expiresInDays: 1 });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token;
    const anon = client();
    expect((await anon.get(shared(token))).status).toBe(200);

    // Fake ONLY Date (the server runs in-process): two days pass.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 86_400_000 });
    try {
      const expired = await anon.get<ErrorBody>(shared(token));
      expect(expired.status).toBe(410);
      expect(expired.body?.details?.reason).toBe('expired');
    } finally { vi.useRealTimers(); }

    // Revoked and never-existed are DELIBERATELY indistinguishable (oracle rule).
    const pageId2 = await draftPage(owner, orgId, 'Revoked');
    const tok2 = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId2 })).body.token;
    const row = (await listLinks(owner, orgId)).find((l) => l.resourceId === pageId2);
    expect(row?.tokenHash, 'the owner list carries the at-rest hash').toBeTruthy();
    // Revoke BY HASH — the only handle the management list holds (ADR 0448 P2).
    expect((await owner.del(`${links(orgId)}/${encodeURIComponent(row!.tokenHash)}`)).status).toBe(204);
    const revoked = await anon.get(shared(tok2));
    const garbage = await anon.get(shared('tokenthatneverexisted123'));
    expect(revoked.status).toBe(404);
    expect(garbage.status).toBe(404);
    expect(JSON.stringify(revoked.body)).toBe(JSON.stringify(garbage.body));
  });
});

describe('R3-SH1 — the WHEN of "who/when last viewed"', () => {
  it('stamps lastViewedAt in the SAME write the count rides, and the owner list carries it', async () => {
    const { owner, orgId } = await ownerWithMember('viewer');
    const pageId = await draftPage(owner, orgId, 'Watched');
    const token = (await mintLink(owner, orgId, { resourceType: 'cms_page', resourceId: pageId })).body.token;

    // Before any view: no fabricated "never" value — the field is ABSENT.
    const before = await listLinks(owner, orgId);
    const mine = before.find((l) => (l.viewCount ?? 0) === 0);
    expect(mine, 'the fresh link is listed').toBeTruthy();
    expect(mine).not.toHaveProperty('lastViewedAt');

    const t0 = Date.now();
    expect((await client().get(shared(token))).status).toBe(200);

    const after = await listLinks(owner, orgId);
    const viewed = after.find((l) => (l.viewCount ?? 0) === 1);
    expect(viewed, 'the viewed link is listed with its count').toBeTruthy();
    const stamp = Date.parse(viewed!.lastViewedAt ?? '');
    expect(Number.isFinite(stamp), 'the stamp is a real instant').toBe(true);
    expect(stamp, 'stamped at view time, not mint time').toBeGreaterThanOrEqual(t0 - 1000);
  });
});
