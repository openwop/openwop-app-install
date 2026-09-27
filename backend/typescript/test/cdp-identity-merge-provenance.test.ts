/**
 * CDP-G1 / CDP-G2 (docs/steward/UX_UPGRADE-cdp.md) — merge provenance on the golden record.
 *
 *  - CDP-G2: a resolve that had to FOLLOW a merge tombstone reports `mergedFrom`
 *    (the record the identifier is actually filed under), so the console can say
 *    "this is the surviving record" instead of silently answering about somebody
 *    else. A direct hit must NOT carry the field — a false merge claim is as bad
 *    as a missing one.
 *  - CDP-G1: the resolver uses the CANONICAL, cycle-guarded survivor resolver.
 *    The hand-rolled `while (mergedInto && hops < 8)` loop it replaced FAILED
 *    OPEN — a merge cycle fell out of the loop still holding a tombstone and
 *    handed that dead record back as the live golden record.
 *
 * Route-level harness (mirrors cdp-identity-resolution.test.ts) for the normal
 * paths; the cycle is forged with a direct `tombstoneContact` call because the
 * CRM merge route correctly refuses to create one.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { tombstoneContact } from '../src/features/crm/contactsService.js';
import { resolveIdentity } from '../src/features/cdp/identityService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cRaw of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(cRaw);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
// ADR 0627 D3 — the merge route now requires `workspace:write`; a SECOND login
// into an already-owned shared workspace joins as a member without it. Each
// case therefore gets its own workspace whose first login is its owner.
let TENANT = 'cdp-merge-prov';
async function owner(): Promise<Client> {
  const c = client();
  TENANT = `cdp-merge-prov-${Date.now()}-${n++}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `mp-${Date.now()}-${n++}@acme.test`, tenantId: TENANT });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return c;
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test');
};
const resolve = (c: Client, type: string, value: string): Promise<Res> =>
  c.get(`/v1/host/openwop-app/cdp/identity/resolve?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`);

describe('CDP golden record — merge provenance', () => {
  it('a direct hit carries NO mergedFrom', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const made = await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Direct', email: 'direct@acme.test' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const r = await resolve(c, 'email', 'direct@acme.test');
    expect(r.status).toBe(200);
    expect(r.body.contact.contactId).toBe(made.body.contactId);
    expect(r.body.mergedFrom).toBeUndefined();
  });

  it('a CLEANLY merged email is re-pointed, so it is the survivor\'s own — no merge claimed', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Survivor', email: 'keep@acme.test' })).body;
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Dupe', email: 'dupe@acme.test' })).body;
    const merged = await c.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    const r = await resolve(c, 'email', 'dupe@acme.test');
    expect(r.status).toBe(200);
    expect(r.body.contact.contactId).toBe(survivor.contactId);
    // `mergeContacts` absorbs the source email as an identifier AND re-points
    // its index key at the survivor, so this identifier now genuinely belongs
    // to the survivor. No tombstone was followed ⇒ nothing to report. Claiming
    // a merge on every historically-merged identifier would be noise that
    // trains people to ignore the banner.
    expect(r.body.mergedFrom).toBeUndefined();
  });

  it('a STALE index key pointing at a tombstone is reported, not silently substituted', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Survivor', email: 'live@acme.test' })).body;
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Dupe', email: 'stale@acme.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${source.contactId}/identifiers`, { type: 'loyalty', value: 'LOY-STALE' });

    // `mergeContacts` tombstones and THEN reindexes, in two non-transactional
    // steps. This is the state left behind when the second never runs: the key
    // still points at the tombstone. It is the very case the resolver's
    // tombstone-follow exists to reconcile — and the case where, before this
    // change, the console answered about a different person in silence.
    await tombstoneContact(source.contactId, TENANT, survivor.contactId);

    const r = await resolve(c, 'loyalty', 'LOY-STALE');
    expect(r.status).toBe(200);
    // The answer is the survivor …
    expect(r.body.contact.contactId).toBe(survivor.contactId);
    expect(r.body.contact.name).toBe('Survivor');
    // … and the page is TOLD so, rather than having to infer it from a name
    // that doesn't match what was typed.
    expect(r.body.mergedFrom).toEqual({ contactId: source.contactId });
    // resolvedBy still echoes the identifier searched — the two together are
    // what make the answer legible.
    expect(r.body.resolvedBy).toEqual({ type: 'loyalty', value: 'LOY-STALE' });
  });

  it("the survivor's OWN email is a direct hit even after it absorbed a merge", async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Keeper', email: 'keeper@acme.test' })).body;
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'Gone', email: 'gone@acme.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });

    const r = await resolve(c, 'email', 'keeper@acme.test');
    expect(r.status).toBe(200);
    expect(r.body.contact.contactId).toBe(survivor.contactId);
    // Nothing was followed, so nothing is claimed.
    expect(r.body.mergedFrom).toBeUndefined();
  });

  it('an absorbed non-email identifier now BELONGS to the survivor — no merge claimed', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const survivor = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'S2', email: 's2@acme.test' })).body;
    const source = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'D2', email: 'd2@acme.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${source.contactId}/identifiers`, { type: 'loyalty', value: 'LOY-77' });
    await c.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });

    const r = await resolve(c, 'loyalty', 'LOY-77');
    expect(r.status).toBe(200);
    expect(r.body.contact.contactId).toBe(survivor.contactId);
    // The merge RELINKED this identifier onto the survivor, so it is genuinely
    // the survivor's now. Reporting a merge here would be noise, not honesty.
    expect(r.body.mergedFrom).toBeUndefined();
  });

  it('CDP-G1: a merge CYCLE fails closed instead of handing back a tombstone', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const a = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'CycA', email: 'cyc-a@acme.test' })).body;
    const b = (await c.post('/v1/host/openwop-app/crm/contacts', { name: 'CycB', email: 'cyc-b@acme.test' })).body;
    await c.post(`/v1/host/openwop-app/crm/contacts/${a.contactId}/identifiers`, { type: 'device', value: 'cyc-dev-1' });

    // Forge A→B→A directly: the merge ROUTE refuses to build a cycle (it checks
    // the survivor's own tombstone), which is exactly why this has to bypass it.
    await tombstoneContact(a.contactId, TENANT, b.contactId);
    await tombstoneContact(b.contactId, TENANT, a.contactId);

    // The old hand-rolled loop exited after 8 hops still holding a tombstone and
    // returned it as the live golden record. Fail CLOSED: no record at all.
    const rec = await resolveIdentity(TENANT, 'device', 'cyc-dev-1');
    expect(rec).toBeNull();
  });

  it('CDP-G1: a merge chain LONGER than the old 8-hop bound still resolves', async () => {
    await setToggle('crm', 'on');
    await setToggle('cdp', 'on');
    const c = await owner();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push((await c.post('/v1/host/openwop-app/crm/contacts', { name: `Chain${i}`, email: `chain-${i}-${n}@acme.test` })).body.contactId);
    }
    await c.post(`/v1/host/openwop-app/crm/contacts/${ids[0]}/identifiers`, { type: 'device', value: 'chain-dev-1' });
    // ids[0] → ids[1] → … → ids[10]: a 10-hop chain, past the old bound.
    for (let i = 0; i < ids.length - 1; i++) await tombstoneContact(ids[i], TENANT, ids[i + 1]);

    const rec = await resolveIdentity(TENANT, 'device', 'chain-dev-1');
    expect(rec).not.toBeNull();
    // The LIVE end of the chain, not the tombstone the old loop ran out of hops on.
    expect(rec!.contact.contactId).toBe(ids[ids.length - 1]);
    expect(rec!.mergedFrom).toEqual({ contactId: ids[0] });
  });
});
