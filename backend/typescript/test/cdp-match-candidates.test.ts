/**
 * CDP-B — probabilistic match candidates (ADR 0264). ROUTE-level: the generator
 * PROPOSES scored likely-dupes (shared identifier; similar name+company) beyond
 * exact-email, excludes exact-email dupes, and never mutates. Deterministic.
 *
 * Sabotage that reds it (w38 probes): no shared-identifier signal; un-normalized
 * identifier keys; name similarity forced to 1 (Jane pairs with everyone); no
 * exact-email skip; an ascending score sort.
 *
 * The exact-email skip is reachable only for LEGACY rows: since ADR 0627 D6
 * (`claimPrimaryEmailOrThrow`) the API refuses a second contact with the same primary
 * email (409). Case 2 therefore plants the pre-claim duplicate the way such a row
 * exists in storage — a real contact row (read back from the service) rewritten with
 * the first contact's email through the `crm:contact` collection.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getContact, type Contact } from '../src/features/crm/contactsService.js';
import type { MatchCandidate } from '../src/features/crm/matchCandidatesService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users'); if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
function client() {
  let cookie = '';
  const call = async (m: string, p: string, b?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(c); if (mm) cookie = mm[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
type Client = ReturnType<typeof client>;
let n = 0;
async function owner() { const c = client(); const r = await c.post('/host/openwop-app/test/login', { email: `b-${Date.now()}-${n++}@a.test`, tenantId: `org:b-${Date.now()}-${n++}` }); expect(r.status).toBe(201); return c; }
const enable = async (id: string) => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };
async function mk(c: Client, body: Record<string, unknown>): Promise<string> {
  const r = await c.post('/host/openwop-app/crm/contacts', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { contactId: string }).contactId;
}
async function candidates(c: Client): Promise<MatchCandidate[]> {
  const r = await c.get('/host/openwop-app/crm/match-candidates');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { candidates: MatchCandidate[] }).candidates;
}
const pairKey = (x: MatchCandidate): string => [x.a.contactId, x.b.contactId].sort().join();

describe('CDP-B match candidates', () => {
  it('proposes shared-identifier and name+company dupes; excludes exact-email and dissimilar', async () => {
    await enable('crm');
    const c = await owner();
    const j1 = await mk(c, { name: 'John Smith', email: 'j1@x.test', company: 'Acme' });
    const j2 = await mk(c, { name: 'Jon Smith', email: 'j2@x.test', company: 'Acme' });
    expect((await c.post(`/host/openwop-app/crm/contacts/${j1}/identifiers`, { type: 'phone', value: '+1 (555) 111-0000' })).status).toBe(201);
    expect((await c.post(`/host/openwop-app/crm/contacts/${j2}/identifiers`, { type: 'phone', value: '+15551110000' })).status).toBe(201); // normalizes to the same digits
    // same name + same company, no shared identifier → the name+company signal
    const g1 = await mk(c, { name: 'Grace Hopper', email: 'g1@x.test', company: 'Navy' });
    const g2 = await mk(c, { name: 'Grace Hopper', email: 'g2@x.test', company: 'Navy' });
    await mk(c, { name: 'Jane Doe', email: 'jane@x.test', company: 'Globex' });

    const cands = await candidates(c);
    // exactly the two pairs, strongest first (score desc); Jane Doe pairs with nobody
    expect(cands.map((x) => ({ pair: pairKey(x), reason: x.reason, score: x.score }))).toEqual([
      { pair: [j1, j2].sort().join(), reason: 'shared-identifier', score: 0.95 },
      { pair: [g1, g2].sort().join(), reason: 'name+company', score: 0.9 },
    ]);
    // deterministic: a second read is identical
    expect(await candidates(c)).toEqual(cands);
  });

  it('excludes exact-email dupes (a legacy pre-claim duplicate row)', async () => {
    await enable('crm');
    const c = await owner();
    const first = await mk(c, { name: 'Dup Person', email: 'dup@x.test' });
    const second = await mk(c, { name: 'Dup Person', email: 'dup2@x.test' });
    // positive control: identical names with DIFFERENT emails ARE a candidate
    expect((await candidates(c)).map(pairKey)).toEqual([[first, second].sort().join()]);
    // plant the legacy state: the second row carries the first one's email
    const row = await getContact(second);
    expect(row).not.toBeNull();
    const raw = new DurableCollection<Contact>('crm:contact', (x) => x.contactId, undefined, (x) => x.tenantId);
    await raw.put({ ...row!, email: 'dup@x.test' });
    expect((await getContact(second))?.email).toBe('dup@x.test');
    // the only pair is exact-email → owned by findDuplicateContacts, not proposed here
    expect(await candidates(c)).toEqual([]);
  });
});
