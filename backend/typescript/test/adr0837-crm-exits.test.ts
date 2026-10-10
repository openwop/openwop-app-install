/**
 * ADR 0837 — CRM exit guards (feature loop 2026-10 row 23). Each block names the
 * decision it witnesses; the headline legs were RED on `origin/main` (869ac06bf)
 * before the fix:
 *
 *   D1 — a booking-link DELETE from another tenant wiped the victim's bookings
 *        (the prefix-scan cascade ran BEFORE the ownership check; the route then
 *        answered 404 with the rows already gone).
 *   D3 — two crossed merges (A←B, B←A) both landed: two tombstones, a cycle, and
 *        both contacts gone from the rolodex.
 *   D4 — the public booking lane rebuilt an ERASED subject's contact.
 *   D6 — the lead score read a non-member's org; a booking link could name any
 *        user as its owner; the CSV guard missed TAB / CR.
 *
 * Sabotage-witnessed (w4 grade-tests): dropping `getBookingLink`'s tenant/org
 * guard reds D1; bypassing `underMergeLock` reds D3; not releasing the tenant op
 * lock reds the sequential merge; skipping the erasure check in
 * `ensureContactWithOutcome` reds D4; each D6 guard reds its own case. The D1
 * tenant-scoped sweep inside `deleteBookingsOfLink` is a SECOND layer behind the
 * link lookup — a double guard no outcome here can witness alone.
 *
 * D2 (surface floors) and D5 (territories) have their own files.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContact, findContactByEmail, getContact, listContacts, resolveContactSurvivor } from '../src/features/crm/contactsService.js';
import { mergeContacts } from '../src/features/crm/crmMergeService.js';
import { writeErasureTombstone } from '../src/features/consent/consentService.js';
import { csvEscape } from '../src/features/crm/csvExport.js';
import { listBookings } from '../src/features/crm/entities/bookings.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_CRM_BOOKING_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: unknown }
/** Narrow a JSON body at its read site (no `any`). */
const bodyAs = <T>(r: Res): T => r.body as T;
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

let n = 0;
async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: `a0837-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return bodyAs<{ user: { userId: string } }>(r).user.userId;
}
async function ownerOrg(): Promise<{ owner: Client; ownerId: string; orgId: string; tenantId: string }> {
  const tenantId = `org:a0837-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = await signup(owner, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, ownerId, orgId: bodyAs<{ orgId: string }>(org).orgId, tenantId };
}
const links = (orgId: string, s = ''): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/booking-links${s}`;
const ALL_DAYS = Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:30' }));

async function publishedLink(owner: Client, orgId: string): Promise<{ slug: string; bookingLinkId: string }> {
  const made = await owner.post(links(orgId), { title: 'Intro', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30], minNoticeMin: 0, maxAdvanceDays: 30 });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const link = bodyAs<{ slug: string; bookingLinkId: string }>(made);
  expect((await owner.patch(links(orgId, `/${link.bookingLinkId}`), { status: 'published' })).status).toBe(200);
  return { slug: link.slug, bookingLinkId: link.bookingLinkId };
}
async function book(slug: string, email: string, nth = 0): Promise<Res> {
  const now = Date.now();
  const { slots } = bodyAs<{ slots: number[] }>(await client().get(`/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`));
  return client().post(`/host/openwop-app/public-book/${slug}/claim`, { slotStartUtcMs: slots[nth], durationMin: 30, inviteeName: 'Visitor', inviteeEmail: email });
}

describe('ADR 0837 D1 — a booking-link delete only ever touches the caller\'s own link', () => {
  it('another tenant naming the victim link, or the bare `booking-link` prefix, deletes nothing', async () => {
    const victim = await ownerOrg();
    const { slug, bookingLinkId } = await publishedLink(victim.owner, victim.orgId);
    const claim = await book(slug, 'guest@victim.test');
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    // The public claim hands the booking id back — and it embeds the link id.
    expect(String(bodyAs<{ bookingId: string }>(claim).bookingId).startsWith(`${bookingLinkId}:`)).toBe(true);

    const attacker = await ownerOrg();
    for (const id of [bookingLinkId, 'booking-link']) {
      const del = await attacker.owner.del(links(attacker.orgId, `/${encodeURIComponent(id)}`));
      expect(del.status).toBe(404);
    }
    const left = await victim.owner.get(links(victim.orgId, `/${bookingLinkId}/bookings`));
    expect(left.status).toBe(200);
    expect(bodyAs<{ bookings: unknown[] }>(left).bookings).toHaveLength(1); // RED on origin/main: 0
  });

  it('the owner\'s own delete still cascades its bookings', async () => {
    const t = await ownerOrg();
    const { slug, bookingLinkId } = await publishedLink(t.owner, t.orgId);
    expect((await book(slug, 'a@own.test')).status).toBe(201);
    expect((await t.owner.del(links(t.orgId, `/${bookingLinkId}`))).status).toBe(204);
    expect(await listBookings(t.tenantId, t.orgId, { bookingLinkId })).toHaveLength(0);
  });
});

describe('ADR 0837 D3 — one merge at a time per tenant', () => {
  it('crossed merges A←B and B←A never both land (no cycle, a live survivor remains)', async () => {
    const tenantId = `t-a0837-merge-${n++}`;
    const a = await createContact({ tenantId, name: 'Ann A', email: `ann-a-${n}@x.test` });
    const b = await createContact({ tenantId, name: 'Ann B', email: `ann-b-${n}@x.test` });
    const results = await Promise.allSettled([mergeContacts(tenantId, a.contactId, b.contactId), mergeContacts(tenantId, b.contactId, a.contactId)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1); // RED on origin/main: 2
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'conflict' });
    const live = (await listContacts(tenantId)).map((c) => c.contactId);
    expect(live).toHaveLength(1);
    expect(await resolveContactSurvivor(tenantId, a.contactId)).not.toBeNull();
    expect(await resolveContactSurvivor(tenantId, b.contactId)).not.toBeNull();
  });

  it('a merge after the first one settles is admitted (the lock is released)', async () => {
    const tenantId = `t-a0837-merge-${n++}`;
    const a = await createContact({ tenantId, name: 'A', email: `seq-a-${n}@x.test` });
    const b = await createContact({ tenantId, name: 'B', email: `seq-b-${n}@x.test` });
    const c = await createContact({ tenantId, name: 'C', email: `seq-c-${n}@x.test` });
    await mergeContacts(tenantId, a.contactId, b.contactId);
    await mergeContacts(tenantId, a.contactId, c.contactId);
    expect((await getContact(c.contactId))?.mergedInto).toBe(a.contactId);
  });
});

describe('ADR 0837 D4 — unattended lanes do not rebuild an erased subject', () => {
  it('a public booking from an erased address is served, but no contact is re-created', async () => {
    const t = await ownerOrg();
    const { slug, bookingLinkId } = await publishedLink(t.owner, t.orgId);
    const email = `erased-${n++}@x.test`;
    await writeErasureTombstone(t.tenantId, email);
    const claim = await book(slug, email);
    expect(claim.status, JSON.stringify(claim.body)).toBe(201); // the person is still served
    expect(await findContactByEmail(t.tenantId, email)).toBeNull(); // RED on origin/main: a contact
    const rows = await t.owner.get(links(t.orgId, `/${bookingLinkId}/bookings`));
    expect(rows.status, JSON.stringify(rows.body)).toBe(200);
    const bookings = bodyAs<{ bookings: Array<{ contactId?: string }> }>(rows).bookings;
    expect(bookings).toHaveLength(1); // the person was served a persisted booking
    expect(bookings[0]?.contactId).toBeUndefined();
  });

  it('a booking note stays on the booking and never reaches the timeline', async () => {
    const t = await ownerOrg();
    const { slug } = await publishedLink(t.owner, t.orgId);
    const now = Date.now();
    const { slots } = bodyAs<{ slots: number[] }>(await client().get(`/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`));
    const claim = await client().post(`/host/openwop-app/public-book/${slug}/claim`, { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: `note-${n++}@x.test`, inviteeNote: 'secret-note-text' });
    expect(claim.status).toBe(201);
    const acts = await t.owner.get(`/host/openwop-app/crm/orgs/${encodeURIComponent(t.orgId)}/activities`);
    expect(acts.status).toBe(200);
    // Positive control: the booking DID reach the timeline (as the meeting
    // activity), so the absence below is the note being kept off it — not an
    // empty or failed timeline read.
    expect(bodyAs<{ activities: Array<{ body: string }> }>(acts).activities.some((a) => a.body.startsWith('Booked "Intro"'))).toBe(true);
    expect(JSON.stringify(acts.body)).not.toContain('secret-note-text');
  });
});

describe('ADR 0837 D6 — the smaller exits', () => {
  it('the lead score refuses an org the caller is not a member of', async () => {
    const t = await ownerOrg();
    const outsider = client();
    await signup(outsider, t.tenantId); // same tenant, NOT a member of the org
    const contact = await t.owner.post('/host/openwop-app/crm/contacts', { name: 'Lead', email: `lead-${n++}@x.test` });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const path = `/host/openwop-app/crm/contacts/${encodeURIComponent(bodyAs<{ contactId: string }>(contact).contactId)}/score?orgId=${encodeURIComponent(t.orgId)}`;
    expect((await t.owner.get(path)).status).toBe(200);
    expect((await outsider.get(path)).status).toBe(404); // RED on origin/main: 200
  });

  it('a booking link owner other than the caller must be a member of the org', async () => {
    const t = await ownerOrg();
    const member = client();
    const memberId = await signup(member, t.tenantId);
    expect((await t.owner.post(`/host/openwop-app/orgs/${encodeURIComponent(t.orgId)}/members`, { displayName: 'M', subject: memberId, roles: ['editor'] })).status).toBe(201);
    const base = { title: 'X', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30] };
    const foreign = await t.owner.post(links(t.orgId), { ...base, ownerUserId: 'user:someone-elsewhere' });
    expect(foreign.status).toBe(400); // RED on origin/main: 201
    const refusal = bodyAs<{ error?: { details?: { field?: string } }; details?: { field?: string } }>(foreign);
    expect(refusal.error?.details?.field ?? refusal.details?.field).toBe('ownerUserId');
    expect((await t.owner.post(links(t.orgId), { ...base, ownerUserId: memberId })).status).toBe(201);
    expect((await t.owner.post(links(t.orgId), base)).status).toBe(201);
  });

  it('the CSV formula guard also neutralizes a leading TAB and CR', () => {
    expect(csvEscape('\t=HYPERLINK("x")').startsWith("\"'")).toBe(true);
    expect(csvEscape('\r=1+1').startsWith("\"'")).toBe(true);
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('plain')).toBe('plain');
  });
});
