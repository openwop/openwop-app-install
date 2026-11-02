/**
 * ADR 0542 P5 — the public listing index, over the EXISTING public-entities path.
 *
 * The architecture review found this phase needs no new route. The kernel
 * already serves `public-entities/:tenantId/types/:typeName/entities` with the
 * exact properties D4 requires: tenant from the RESOURCE, one uniform 404 that
 * cannot distinguish "unpublished" from "does not exist" from "wrong tenant",
 * and a projection that strips actor subjects.
 *
 * Adding a `/job-search/public/listings` route would have been a second public
 * surface and a second place for that no-leak logic to drift. So these tests
 * verify the existing path carries listings correctly — which is the ADR's
 * verification either way ("cross-tenant 404, unpublished 404, rate limit").
 *
 * All state is seeded in `beforeAll` and NO case writes: OWNER is published there,
 * OTHER never is. (The cases used to publish OWNER inside case 2 and rely on run
 * order — a shuffled run read OWNER before it was published.)
 *
 * Tracker TST-DHD-2 (wave 71). Red when: the public gate stops requiring
 * `publicRead` (`w71g3-pi-gate`); the `filters` length bound goes
 * (`pi-filters-r2` — the body is VALID JSON over 2048 chars, so the parse no
 * longer refuses it first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { upsertListing, setListingsPublic, LISTING_TYPE } from '../src/features/job-search/boards/listing.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';

const PUB = '/host/openwop-app/public-entities';
const OWNER = 'user:jobs-public-owner';
const OTHER = 'user:jobs-public-other';

let server: Server;
let BASE: string;

const UNIFORM_404 = { error: 'not_found', message: 'Not found.' };

const listingsUrl = (tenantId: string) => `${BASE}${PUB}/${encodeURIComponent(tenantId)}/types/${LISTING_TYPE}/entities`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });

  // `entities` gates the PUBLIC read (unlike its service layer), so both tenants
  // need it on or every assertion below would pass for the wrong reason.
  for (const t of [OWNER, OTHER]) {
    await enableTenantOverride('entities', t, 'test');
    await enableTenantOverride('job-search', t, 'test');
  }
  await upsertListing(OWNER, 'user-1', { title: 'Staff Backend Engineer', companyName: 'Northwind Systems', location: 'Austin, TX' });
  await upsertListing(OTHER, 'user-2', { title: 'Platform Engineer', companyName: 'Harbor Analytics', location: 'Chicago, IL' });
  // The one publish, done here so no case depends on another having run.
  await setListingsPublic(OWNER, true, 'user-1');
}, 180_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0542 D4 — the public index is opt-in and leaks nothing', () => {
  it('an UNPUBLISHED tenant’s listings are a 404, not an empty list', async () => {
    // An empty 200 would confirm the tenant exists. The uniform 404 is what
    // makes "unpublished" and "no such tenant" indistinguishable.
    const res = await fetch(listingsUrl(OTHER));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject(UNIFORM_404);
  });

  it('after an explicit publish, the listings are readable anonymously', async () => {
    const res = await fetch(listingsUrl(OWNER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entities?: Array<{ values?: Record<string, unknown> }> };
    expect(body.entities?.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toContain('Staff Backend Engineer');
  });

  it('publishing one tenant does NOT expose another — the cross-tenant case', async () => {
    // OWNER is published (beforeAll); OTHER never was. Positive control first.
    expect((await fetch(listingsUrl(OWNER))).status).toBe(200);
    const res = await fetch(listingsUrl(OTHER));
    expect(res.status, 'a published neighbour must not publish you').toBe(404);
    expect(await res.json()).toMatchObject(UNIFORM_404);
  });

  it('an UNKNOWN tenant is the SAME 404 — no existence oracle', async () => {
    const unknown = await fetch(listingsUrl('user:does-not-exist'));
    const unpublished = await fetch(listingsUrl(OTHER));
    expect(unknown.status).toBe(unpublished.status);
    // Same body too: a differing message is an existence oracle just as much as
    // a differing status code.
    expect(await unknown.text()).toBe(await unpublished.text());
  });

  it('the public projection carries NO actor subjects or storage internals', async () => {
    const res = await fetch(listingsUrl(OWNER));
    expect(res.status, 'the projection read must be the PUBLISHED body, not a 404').toBe(200);
    const body = await res.text();
    expect(body).toContain('Staff Backend Engineer');
    for (const leak of ['createdBy', 'updatedBy', 'recordKey', 'tenantId', 'user-1']) {
      expect(body, `public projection leaked ${leak}`).not.toContain(leak);
    }
  });

  it('needs no authentication — it is a genuinely public surface', async () => {
    // Asserted explicitly because a public route that quietly required a session
    // would look identical in a signed-in browser and fail for every real reader.
    const res = await fetch(listingsUrl(OWNER), { headers: { cookie: '' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('Staff Backend Engineer');
  });

  it('bounds the `filters` query rather than parsing unbounded input', async () => {
    // VALID JSON over the 2048-char bound: a non-JSON body is refused by the
    // parse with the same 400, which hid the bound itself.
    const filters = JSON.stringify(Array.from({ length: 600 }, () => 'x'));
    expect(filters.length).toBeGreaterThan(2048);
    const res = await fetch(`${listingsUrl(OWNER)}?filters=${encodeURIComponent(filters)}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message?: string }).message).toBe('`filters` is too long.');
  });
});
