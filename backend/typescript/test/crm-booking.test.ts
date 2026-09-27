/**
 * ADR 0402 §a — CRM booking links, ROUTE-level end-to-end. Boots the real app
 * and drives: authed link CRUD + publish (RBAC), the public surface (link view,
 * slot list, claim), the double-book 409, idempotent replay, the four public
 * invariants (uniform 404 on unpublished / unknown / crm-off), and the
 * manage-token reschedule/cancel flow.
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
  delete process.env.OPENWOP_CRM_BOOKING_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(headers: Record<string, string> = {}) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers, ...extra, ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const cRaw of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(cRaw);
      if (m) cookie = m[1];
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown, extra?: Record<string, string>) => call('POST', p, b, extra),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}

let n = 0;
const setCrm = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('crm');
  if (def) await saveConfig({ ...def, status }, 'test');
};

async function ownerOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const tenantId = `org:book-${Date.now()}-${n++}`;
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `book-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

const linkBase = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/booking-links${suffix}`;
const ALL_DAYS = Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:30' }));

async function makePublishedLink(owner: ReturnType<typeof client>, orgId: string): Promise<{ slug: string; bookingLinkId: string }> {
  const create = await owner.post(linkBase(orgId), {
    title: 'Intro call', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30], minNoticeMin: 0, maxAdvanceDays: 30,
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  expect(create.body.status).toBe('draft');
  const publish = await owner.patch(linkBase(orgId, `/${create.body.bookingLinkId}`), { status: 'published' });
  expect(publish.status, JSON.stringify(publish.body)).toBe(200);
  return { slug: create.body.slug, bookingLinkId: create.body.bookingLinkId };
}

describe('booking links — authed management + validation', () => {
  it('rejects a link with no valid availability', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const bad = await owner.post(linkBase(orgId), { title: 'X', timezone: 'Not/AZone', weeklyHours: [], durations: [] });
    expect(bad.status).toBe(400);
  });

  it('creates, lists, and mints a unique slug', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const a = await makePublishedLink(owner, orgId);
    const list = await owner.get(linkBase(orgId));
    expect(list.status).toBe(200);
    expect(list.body.bookingLinks.some((l: any) => l.bookingLinkId === a.bookingLinkId)).toBe(true);
    expect(a.slug.length).toBeGreaterThan(0);
  });
});

describe('booking links — public surface (four invariants + claim)', () => {
  it('uniform 404 on unknown / unpublished / crm-off', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const anon = client();
    // Unknown slug.
    expect((await anon.get('/v1/host/openwop-app/public-book/does-not-exist')).status).toBe(404);
    // Draft (unpublished) link is dark.
    const draft = await owner.post(linkBase(orgId), { title: 'Hidden', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30] });
    expect(draft.status).toBe(201);
    expect((await anon.get(`/v1/host/openwop-app/public-book/${draft.body.slug}`)).status).toBe(404);
    // Published, then crm off → dark.
    const pub = await makePublishedLink(owner, orgId);
    expect((await anon.get(`/v1/host/openwop-app/public-book/${pub.slug}`)).status).toBe(200);
    await setCrm('off');
    expect((await anon.get(`/v1/host/openwop-app/public-book/${pub.slug}`)).status).toBe(404);
    await setCrm('on');
  });

  it('lists slots, claims one, blocks a double-book, replays an idempotent retry', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();

    const now = Date.now();
    const to = now + 2 * 86_400_000;
    const slotsRes = await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${to}&durationMin=30`);
    expect(slotsRes.status, JSON.stringify(slotsRes.body)).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Visitor', inviteeEmail: 'visitor@x.test' },
      { 'Idempotency-Key': 'idem-1' });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    expect(claim.body.icsContent).toContain('BEGIN:VCALENDAR');
    expect(typeof claim.body.manageUrl).toBe('string');

    // Owner sees the booking (with a captured contact linked).
    const bookings = await owner.get(linkBase(orgId, `/${bookingLinkId}/bookings`));
    expect(bookings.status).toBe(200);
    expect(bookings.body.bookings).toHaveLength(1);
    expect(bookings.body.bookings[0].contactId).toBeTruthy();

    // Double-book the same slot from another visitor → 409.
    const dbl = await client().post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Other', inviteeEmail: 'other@x.test' });
    expect(dbl.status).toBe(409);

    // Idempotent replay (same key) → 200, same booking.
    const replay = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Visitor', inviteeEmail: 'visitor@x.test' },
      { 'Idempotency-Key': 'idem-1' });
    expect(replay.status).toBe(200);
    expect(replay.body.bookingId).toBe(claim.body.bookingId);
  });

  it('honeypot claim is silently dropped (no booking)', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const now = Date.now();
    const slots = (await client().get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const hp = await client().post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'Bot', inviteeEmail: 'bot@x.test', _hp_ref: 'spam' });
    expect(hp.status).toBe(200);
    expect(hp.body.bookingId).toBeUndefined();
  });
});

describe('booking links — manage token (reschedule / cancel)', () => {
  it('resolves the manage view and cancels, freeing the slot', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();
    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const slot = slots[0];
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    const token = String(claim.body.manageUrl).split('/').pop();

    const view = await anon.get(`/v1/host/openwop-app/public-book/manage/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.status).toBe('confirmed');

    const cancel = await anon.post(`/v1/host/openwop-app/public-book/manage/${token}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    // The manage token is revoked after cancel → uniform 404.
    expect((await anon.get(`/v1/host/openwop-app/public-book/manage/${token}`)).status).toBe(404);

    // The slot is bookable again.
    const reclaim = await client().post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'W', inviteeEmail: 'w@x.test' });
    expect(reclaim.status).toBe(201);
  });

  it('deleting a booking link cascades — its bookings are removed and manage tokens revoked', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();
    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    const token = String(claim.body.manageUrl).split('/').pop();

    const del = await owner.del(linkBase(orgId, `/${bookingLinkId}`));
    expect(del.status).toBe(204);
    // The manage token no longer resolves (revoked + link gone) — no orphan surface.
    expect((await anon.get(`/v1/host/openwop-app/public-book/manage/${token}`)).status).toBe(404);
  });

  it('reschedules to a new slot and frees the old one', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();
    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const [first, second] = [slots[0], slots[1]];
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: first, durationMin: 30, inviteeName: 'R', inviteeEmail: 'r@x.test' });
    expect(claim.status).toBe(201);
    const token = String(claim.body.manageUrl).split('/').pop();

    const resched = await anon.post(`/v1/host/openwop-app/public-book/manage/${token}/reschedule`, { slotStartUtcMs: second });
    expect(resched.status, JSON.stringify(resched.body)).toBe(200);
    expect(resched.body.slotStartUtcMs).toBe(second);

    // The new slot is now taken; the old slot is free again.
    const confirmed = (await owner.get(linkBase(orgId, `/${bookingLinkId}/bookings`))).body.bookings.filter((b: any) => b.status === 'confirmed');
    expect(confirmed.map((b: any) => b.slotStartUtcMs)).toEqual([second]);
  });
});

describe('R2 wire truth — the fields the round-2 UI renders actually ride the wire (review F1/F7/F10)', () => {
  it('public link view carries maxAdvanceDays context and NEVER an email; manage view carries the horizon + the confirmed invite', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();

    // Public link view: no email may appear anywhere on this unauthed surface
    // (hostName is displayName-only by design; a displayName that IS an email
    // must be suppressed, review F10).
    const pub = await anon.get(`/v1/host/openwop-app/public-book/${slug}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('@');

    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    // Claim surfaces email-delivery honesty (console stub ⇒ false, never undefined).
    expect(claim.body.confirmationEmailed).toBe(false);
    const token = String(claim.body.manageUrl).split('/').pop();

    // Manage view: the LINK's real horizon (the page stops hardcoding 60) and
    // the confirmed booking's invite for re-download.
    const view = await anon.get(`/v1/host/openwop-app/public-book/manage/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.maxAdvanceDays).toBe(30);
    expect(String(view.body.icsContent)).toContain('BEGIN:VCALENDAR');
  });

  it('reschedule responds with the new invite + delivery honesty, and the rotated manage view stays confirmed', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();
    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 3 * 86_400_000}&durationMin=30`)).body.slots;
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    const token = String(claim.body.manageUrl).split('/').pop();

    const resched = await anon.post(`/v1/host/openwop-app/public-book/manage/${token}/reschedule`, { slotStartUtcMs: slots[1] });
    expect(resched.status, JSON.stringify(resched.body)).toBe(200);
    expect(resched.body.slotStartUtcMs).toBe(slots[1]);
    expect(String(resched.body.icsContent)).toContain('BEGIN:VCALENDAR');
    expect(resched.body.confirmationEmailed).toBe(false);

    // The rotated token resolves to a confirmed view at the NEW time.
    const newTok = String(resched.body.manageUrl).split('/').pop();
    const view = await anon.get(`/v1/host/openwop-app/public-book/manage/${newTok}`);
    expect(view.status).toBe(200);
    expect(view.body.status).toBe('confirmed');
    expect(view.body.slotStartUtcMs).toBe(slots[1]);
    expect(String(view.body.icsContent)).toContain('BEGIN:VCALENDAR');
  });
});

describe('R3-CP1 — the visitor\'s optional cancellation reason', () => {
  /** Claim a slot as an anon visitor; return the manage token + contactId. */
  async function claimed(): Promise<{ anon: ReturnType<typeof client>; owner: ReturnType<typeof client>; orgId: string; token: string }> {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();
    const now = Date.now();
    const slots = (await anon.get(`/v1/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + 2 * 86_400_000}&durationMin=30`)).body.slots;
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    return { anon, owner, orgId, token: String(claim.body.manageUrl).split('/').pop()! };
  }

  const cancelNote = async (owner: ReturnType<typeof client>, orgId: string): Promise<string> => {
    const acts = (await owner.get(`/v1/host/openwop-app/crm/orgs/${orgId}/activities`)).body.activities as Array<{ body: string }>;
    const note = acts.find((a) => a.body.startsWith('Booking cancelled:'));
    expect(note, 'the cancellation timeline note exists').toBeTruthy();
    return note!.body;
  };

  it('a typed reason reaches the host\'s timeline note, bounded', async () => {
    const { anon, owner, orgId, token } = await claimed();
    // PROBE CORRECTION: the first version padded 600 chars and asserted
    // length < 700 — the unbounded variant landed at ~673 and the probe came
    // back GREEN. The padding must make bounded and unbounded DISTINGUISHABLE:
    // 2000 chars of padding, and the assertion counts the padding that landed.
    const res = await anon.post(`/v1/host/openwop-app/public-book/manage/${token}/cancel`, { reason: `Changed plans${'!'.repeat(2000)}` });
    expect(res.status).toBe(200);
    const body = await cancelNote(owner, orgId);
    expect(body).toContain('visitor\'s note: "Changed plans');
    const landed = (body.match(/!/g) ?? []).length;
    expect(landed, 'the 500-char bound holds — padding beyond it never lands').toBeLessThanOrEqual(500 - 'Changed plans'.length);
    expect(landed, 'and the bound is a TRUNCATION, not a rejection').toBeGreaterThan(400);
  });

  it('no reason (and whitespace-only) keeps the note byte-identical to before', async () => {
    const { anon, owner, orgId, token } = await claimed();
    const res = await anon.post(`/v1/host/openwop-app/public-book/manage/${token}/cancel`, { reason: '   ' });
    expect(res.status).toBe(200);
    const body = await cancelNote(owner, orgId);
    expect(body, 'the pre-R3 note shape, unchanged').toMatch(/^Booking cancelled: ".+" \(.+\)$/);
    expect(body).not.toContain('visitor');
  });
});
