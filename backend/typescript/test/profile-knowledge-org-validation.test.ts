/**
 * RI-ORG-2 — the profile-knowledge routes take `orgId` from the REQUEST BODY, so the
 * org's existence in the caller's tenant is asserted explicitly before authority is
 * resolved (`features/profile-memory/knowledgeRoutes.ts` `requireOrgScope`).
 *
 * Authorization alone already fenced this: the guard resolves via
 * `resolveEffectiveAccess`, which needs a member row matching `(tenantId, orgId)` — a
 * foreign org has none, so it yields zero scopes and a 403.
 *
 * The hole is DEMO MODE. The caller's home tenant is single-principal, so the
 * de-facto-owner bypass (narrowed by ADR 0508 / GC-6 to exactly those tenants)
 * legitimately returns OWNER there — and a body-supplied foreign `orgId` would then be
 * accepted, keying a KB row `${tenantId}:${orgId}:` against an org that does not exist
 * in this tenant. Contained to the caller's own tenant, but a dangling reference.
 *
 * These cases run WITH `OPENWOP_DEMO_MODE=true` on purpose: that is the only
 * configuration in which the defect is reachable, so testing without it would pass
 * against a fence that was never the one at risk (ADR 0502, mechanism vs wiring).
 *
 * THEY GO THROUGH THE ROUTE, not the service. The guard is module-private, so a
 * service-level test cannot invoke it — the first version of this file asserted
 * preconditions about `resolveEffectiveAccess`/`getOrg` instead and stayed GREEN when
 * the guard was deleted. Only the HTTP boundary observes it.
 *
 * Each refusal asserts the whole claim: a uniform `not_found` envelope AND no
 * collection created/bound against the refused org (the dangling row is the harm).
 *
 * Sabotage that turns it red (w3g2-orgval-*):
 *   - `if (!org)` (drop the tenant comparison)            → case 1 (201, row bound)
 *   - `if (org && org.tenantId !== tenantId)` (drop `!org`) → case 2
 *   - `org.tenantId === tenantId` (inverted comparison)    → case 3 (and case 1)
 *   - the guard's 404 → 403                                → cases 1 and 2
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { getSetCookies } from './headerCookies.js';

let BASE: string;
let server: http.Server;
const PRIOR_DEMO = process.env.OPENWOP_DEMO_MODE;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_DEMO_MODE = 'true'; // the only mode where RI-ORG-2 is reachable
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'profiles', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (PRIOR_DEMO === undefined) delete process.env.OPENWOP_DEMO_MODE;
  else process.env.OPENWOP_DEMO_MODE = PRIOR_DEMO;
});

interface Res { status: number; body: unknown }
/** The host error envelope (`middleware/errorEnvelope.ts`). */
interface ErrBody { error?: string; details?: { orgId?: string } }
interface ColBody { collectionId: string; orgId: string; name: string }
interface ViewBody { collections: Array<{ collectionId: string; orgId: string; name: string }> }
interface OrgBody { orgId: string }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of getSetCookies(res.headers)) {
      const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1];
    }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

const KNOWLEDGE = '/host/openwop-app/profiles/me/knowledge';
const COLLECTIONS = `${KNOWLEDGE}/collections`;
let n = 0;

async function signedIn(): Promise<ReturnType<typeof client>> {
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `ri2-${n++}@t.test` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  return c;
}

async function boundCollections(c: ReturnType<typeof client>): Promise<ViewBody['collections']> {
  const view = await c.get(KNOWLEDGE);
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  return (view.body as ViewBody).collections;
}

describe('RI-ORG-2 — a body-supplied orgId must exist in the caller tenant', () => {
  it('an org in ANOTHER tenant is refused with 404, even under demo mode', async () => {
    // The org genuinely exists — in somebody else's tenant. Demo mode means
    // authorization ALONE would let this through (single-principal home tenant ⇒
    // de-facto owner), so a pass here proves the EXISTENCE check specifically.
    const foreign = await createOrg({
      tenantId: `ws:ri-org-2-elsewhere-${n++}`,
      createdBy: 'oidc:someone-else',
      name: 'Elsewhere',
    });

    const c = await signedIn();
    const res = await c.post(COLLECTIONS, { orgId: foreign.orgId, name: 'Smuggled' });
    // 404, not 403: a foreign org must be indistinguishable from an absent one.
    expect(
      res.status,
      `a foreign org must not be usable as a collection parent; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(404);
    expect((res.body as ErrBody).error).toBe('not_found');
    expect((res.body as ErrBody).details?.orgId).toBe(foreign.orgId);
    // The harm is the dangling row: nothing was created or bound against it.
    expect(await boundCollections(c)).toEqual([]);
  });

  it('a wholly made-up orgId is refused with 404', async () => {
    const c = await signedIn();
    const ghost = `org-nonexistent-${n++}`;
    const res = await c.post(COLLECTIONS, { orgId: ghost, name: 'Ghost' });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect((res.body as ErrBody).error).toBe('not_found');
    expect((res.body as ErrBody).details?.orgId).toBe(ghost);
    expect(await boundCollections(c)).toEqual([]);
  });

  it("an org in the caller's OWN tenant is NOT refused — the guard does not over-fence", async () => {
    // The regression direction. Without this, deleting the whole route would also
    // make the two refusals above pass.
    const c = await signedIn();
    const org = await c.post('/host/openwop-app/orgs', { name: 'Mine' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const { orgId } = org.body as OrgBody;

    const res = await c.post(COLLECTIONS, { orgId, name: 'Legit' });
    expect(
      res.status,
      `the caller's own org must remain usable; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(201);
    const col = res.body as ColBody;
    expect(col).toMatchObject({ orgId, name: 'Legit' });
    expect((await boundCollections(c)).map((x) => x.collectionId)).toEqual([col.collectionId]);
  });
});
