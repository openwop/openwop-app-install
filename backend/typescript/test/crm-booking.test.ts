/**
 * ADR 0402 §a — CRM booking links, ROUTE-level end-to-end. Boots the real app
 * and drives: authed link CRUD + publish (RBAC), the public surface (link view,
 * slot list, claim), the double-book 409, idempotent replay, the four public
 * invariants (uniform 404 on unpublished / unknown / crm-off), and the
 * manage-token reschedule/cancel flow.
 *
 * Sabotage-witnessed (w4 grade-tests): each link validator (`timezone`,
 * `durations`, `weeklyHours`) reds its own leg of the validation case; dropping
 * the `published` check or the toggle check reds the uniform-404 case; a 201 on
 * replay or an unlinked contact reds the claim case; ignoring the honeypot,
 * not revoking the manage token on cancel, not freeing the old slot on
 * reschedule, the email-shaped host name, a missing horizon / reschedule
 * invite, an unbounded or untrimmed cancel reason, or the reason reaching the
 * timeline each red their own case.
 *
 * Double guard (recorded ceiling): the SEQUENTIAL double-book 409 is refused
 * first by live availability (`isOfferedSlot`) and only then by the claim CAS,
 * so breaking either alone stays green here. The CAS is witnessed at unit level
 * in `crm-booking-time.test.ts` › "first claim wins".
 *
 * The link-delete cascade is witnessed in `adr0837-crm-exits.test.ts` › "the
 * owner's own delete still cascades its bookings" (a case here used to claim it
 * through the manage URL, which 404s on the deleted LINK whether or not the
 * bookings were swept — cut in w4).
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

interface Res { status: number; body: unknown }
/** Narrow a JSON body at its read site (no `any`). */
const bodyAs = <T>(r: Res): T => r.body as T;

/** The public claim / reschedule response. */
interface ClaimBody { bookingId?: string; slotStartUtcMs: number; icsContent: string; manageUrl?: string; confirmationEmailed: boolean }
/** The public manage view. */
interface ManageView { status: string; slotStartUtcMs: number; maxAdvanceDays: number; icsContent?: string }
interface BookingRow { status: string; slotStartUtcMs: number; contactId?: string; cancelReason?: string }

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
type Client = ReturnType<typeof client>;

let n = 0;
const setCrm = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('crm');
  if (def) await saveConfig({ ...def, status }, 'test');
};

async function ownerOrg(opts: { displayName?: string } = {}): Promise<{ owner: Client; orgId: string }> {
  const tenantId = `org:book-${Date.now()}-${n++}`;
  const owner = client();
  const login = await owner.post('/host/openwop-app/test/login', { email: `book-${Date.now()}-${n++}@acme.test`, tenantId, ...opts });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: bodyAs<{ orgId: string }>(org).orgId };
}

const linkBase = (orgId: string, suffix = ''): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/booking-links${suffix}`;
const ALL_DAYS = Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:30' }));

async function makePublishedLink(owner: Client, orgId: string, title = 'Intro call'): Promise<{ slug: string; bookingLinkId: string }> {
  const create = await owner.post(linkBase(orgId), {
    title, timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30], minNoticeMin: 0, maxAdvanceDays: 30,
  });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const link = bodyAs<{ status: string; slug: string; bookingLinkId: string }>(create);
  expect(link.status).toBe('draft');
  const publish = await owner.patch(linkBase(orgId, `/${link.bookingLinkId}`), { status: 'published' });
  expect(publish.status, JSON.stringify(publish.body)).toBe(200);
  return { slug: link.slug, bookingLinkId: link.bookingLinkId };
}

/** The public slot list for a link over the next `days` days. */
async function slotsFor(c: Client, slug: string, days = 2): Promise<number[]> {
  const now = Date.now();
  const r = await c.get(`/host/openwop-app/public-book/${slug}/slots?from=${now}&to=${now + days * 86_400_000}&durationMin=30`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return bodyAs<{ slots: number[] }>(r).slots;
}
const manageToken = (r: Res): string => String(bodyAs<ClaimBody>(r).manageUrl).split('/').pop()!;
const bookingsOf = async (owner: Client, orgId: string, bookingLinkId: string): Promise<BookingRow[]> =>
  bodyAs<{ bookings: BookingRow[] }>(await owner.get(linkBase(orgId, `/${bookingLinkId}/bookings`))).bookings;

describe('booking links — authed management + validation', () => {
  it('rejects a link with no valid availability', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    // One invalid field per post, so each validator is witnessed on its own
    // (a single all-invalid post stayed green with any ONE validator removed).
    const valid = { title: 'X', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30] };
    for (const [field, bad] of [['timezone', 'Not/AZone'], ['durations', []], ['weeklyHours', []]] as const) {
      const r = await owner.post(linkBase(orgId), { ...valid, [field]: bad });
      expect(r.status, `${field}: ${JSON.stringify(r.body)}`).toBe(400);
      const e = bodyAs<{ error?: { details?: { field?: string } }; details?: { field?: string } }>(r);
      expect(e.error?.details?.field ?? e.details?.field).toBe(field);
    }
    expect(bodyAs<{ bookingLinks: unknown[] }>(await owner.get(linkBase(orgId))).bookingLinks).toEqual([]);
  });

  it('creates, lists, and mints a unique slug', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    // Same title twice: the second link must get a DIFFERENT slug.
    const a = await makePublishedLink(owner, orgId, 'Same title');
    const b = await makePublishedLink(owner, orgId, 'Same title');
    expect(a.slug.length).toBeGreaterThan(0);
    expect(b.slug).not.toBe(a.slug);
    const list = await owner.get(linkBase(orgId));
    expect(list.status).toBe(200);
    const ids = bodyAs<{ bookingLinks: Array<{ bookingLinkId: string }> }>(list).bookingLinks.map((l) => l.bookingLinkId);
    expect(ids).toEqual(expect.arrayContaining([a.bookingLinkId, b.bookingLinkId]));
  });
});

describe('booking links — public surface (four invariants + claim)', () => {
  it('uniform 404 on unknown / unpublished / crm-off', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const anon = client();
    // Unknown slug.
    expect((await anon.get('/host/openwop-app/public-book/does-not-exist')).status).toBe(404);
    // Draft (unpublished) link is dark.
    const draft = await owner.post(linkBase(orgId), { title: 'Hidden', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30] });
    expect(draft.status).toBe(201);
    expect((await anon.get(`/host/openwop-app/public-book/${bodyAs<{ slug: string }>(draft).slug}`)).status).toBe(404);
    // Published, then crm off → dark.
    const pub = await makePublishedLink(owner, orgId);
    expect((await anon.get(`/host/openwop-app/public-book/${pub.slug}`)).status).toBe(200);
    try {
      await setCrm('off');
      expect((await anon.get(`/host/openwop-app/public-book/${pub.slug}`)).status).toBe(404);
    } finally {
      await setCrm('on');
    }
  });

  it('lists slots, claims one, blocks a double-book, replays an idempotent retry', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();

    const slots = await slotsFor(anon, slug);
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0]!;

    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Visitor', inviteeEmail: 'visitor@x.test' },
      { 'Idempotency-Key': 'idem-1' });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    const claimed = bodyAs<ClaimBody>(claim);
    expect(claimed.icsContent).toContain('BEGIN:VCALENDAR');
    expect(typeof claimed.manageUrl).toBe('string');

    // Owner sees the booking (with a captured contact linked).
    const bookings = await bookingsOf(owner, orgId, bookingLinkId);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.contactId).toBeTruthy();

    // Double-book the same slot from another visitor → 409.
    const dbl = await client().post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Other', inviteeEmail: 'other@x.test' });
    expect(dbl.status).toBe(409);

    // Idempotent replay (same key) → 200, same booking.
    const replay = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'Visitor', inviteeEmail: 'visitor@x.test' },
      { 'Idempotency-Key': 'idem-1' });
    expect(replay.status).toBe(200);
    expect(bodyAs<ClaimBody>(replay).bookingId).toBe(claimed.bookingId);
    expect(await bookingsOf(owner, orgId, bookingLinkId)).toHaveLength(1);
  });

  it('honeypot claim is silently dropped (no booking)', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const slots = await slotsFor(client(), slug);
    const hp = await client().post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'Bot', inviteeEmail: 'bot@x.test', _hp_ref: 'spam' });
    expect(hp.status).toBe(200);
    expect(bodyAs<Partial<ClaimBody>>(hp).bookingId).toBeUndefined();
    // …and nothing landed: the bot's 200 is a silent drop, not a booking.
    expect(await bookingsOf(owner, orgId, bookingLinkId)).toEqual([]);
  });
});

describe('booking links — manage token (reschedule / cancel)', () => {
  it('resolves the manage view and cancels, freeing the slot', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();
    const slot = (await slotsFor(anon, slug))[0];
    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    const token = manageToken(claim);

    const view = await anon.get(`/host/openwop-app/public-book/manage/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(bodyAs<ManageView>(view).status).toBe('confirmed');

    const cancel = await anon.post(`/host/openwop-app/public-book/manage/${token}/cancel`);
    expect(cancel.status).toBe(200);
    expect(bodyAs<{ status: string }>(cancel).status).toBe('cancelled');

    // The manage token is revoked after cancel → uniform 404.
    expect((await anon.get(`/host/openwop-app/public-book/manage/${token}`)).status).toBe(404);

    // The slot is bookable again.
    const reclaim = await client().post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slot, durationMin: 30, inviteeName: 'W', inviteeEmail: 'w@x.test' });
    expect(reclaim.status).toBe(201);
  });

  it('reschedules to a new slot and frees the old one', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();
    const [first, second] = await slotsFor(anon, slug);
    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: first, durationMin: 30, inviteeName: 'R', inviteeEmail: 'r@x.test' });
    expect(claim.status).toBe(201);
    const token = manageToken(claim);

    const resched = await anon.post(`/host/openwop-app/public-book/manage/${token}/reschedule`, { slotStartUtcMs: second });
    expect(resched.status, JSON.stringify(resched.body)).toBe(200);
    expect(bodyAs<ClaimBody>(resched).slotStartUtcMs).toBe(second);

    // The new slot is now taken; the old slot is free again.
    const confirmed = (await bookingsOf(owner, orgId, bookingLinkId)).filter((b) => b.status === 'confirmed');
    expect(confirmed.map((b) => b.slotStartUtcMs)).toEqual([second]);
  });
});

describe('R2 wire truth — the fields the round-2 UI renders actually ride the wire (review F1/F7/F10)', () => {
  it('public link view carries maxAdvanceDays context and NEVER an email; manage view carries the horizon + the confirmed invite', async () => {
    await setCrm('on');
    // F10 — the owner's displayName IS an email (imports/SCIM do this), so the
    // public view must suppress it; without an email-shaped name the '@' check
    // below could not fail.
    const { owner, orgId } = await ownerOrg({ displayName: 'owner-name@acme.test' });
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();

    // Public link view: no email may appear anywhere on this unauthed surface
    // (hostName is displayName-only by design; a displayName that IS an email
    // must be suppressed, review F10).
    const pub = await anon.get(`/host/openwop-app/public-book/${slug}`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('@');

    const slots = await slotsFor(anon, slug);
    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    // Claim surfaces email-delivery honesty (console stub ⇒ false, never undefined).
    expect(bodyAs<ClaimBody>(claim).confirmationEmailed).toBe(false);
    const token = manageToken(claim);

    // Manage view: the LINK's real horizon (the page stops hardcoding 60) and
    // the confirmed booking's invite for re-download.
    const view = await anon.get(`/host/openwop-app/public-book/manage/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(bodyAs<ManageView>(view).maxAdvanceDays).toBe(30);
    expect(String(bodyAs<ManageView>(view).icsContent)).toContain('BEGIN:VCALENDAR');
  });

  it('reschedule responds with the new invite + delivery honesty, and the rotated manage view stays confirmed', async () => {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug } = await makePublishedLink(owner, orgId);
    const anon = client();
    const slots = await slotsFor(anon, slug, 3);
    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    const token = manageToken(claim);

    const resched = await anon.post(`/host/openwop-app/public-book/manage/${token}/reschedule`, { slotStartUtcMs: slots[1] });
    expect(resched.status, JSON.stringify(resched.body)).toBe(200);
    const moved = bodyAs<ClaimBody>(resched);
    expect(moved.slotStartUtcMs).toBe(slots[1]);
    expect(String(moved.icsContent)).toContain('BEGIN:VCALENDAR');
    expect(moved.confirmationEmailed).toBe(false);

    // The rotated token resolves to a confirmed view at the NEW time.
    const view = await anon.get(`/host/openwop-app/public-book/manage/${manageToken(resched)}`);
    expect(view.status).toBe(200);
    const v = bodyAs<ManageView>(view);
    expect(v.status).toBe('confirmed');
    expect(v.slotStartUtcMs).toBe(slots[1]);
    expect(String(v.icsContent)).toContain('BEGIN:VCALENDAR');
  });
});

describe('R3-CP1 — the visitor\'s optional cancellation reason', () => {
  /** Claim a slot as an anon visitor; return the manage token + contactId. */
  async function claimed(): Promise<{ anon: Client; owner: Client; orgId: string; token: string; bookingLinkId: string }> {
    await setCrm('on');
    const { owner, orgId } = await ownerOrg();
    const { slug, bookingLinkId } = await makePublishedLink(owner, orgId);
    const anon = client();
    const slots = await slotsFor(anon, slug);
    const claim = await anon.post(`/host/openwop-app/public-book/${slug}/claim`,
      { slotStartUtcMs: slots[0], durationMin: 30, inviteeName: 'V', inviteeEmail: 'v@x.test' });
    expect(claim.status).toBe(201);
    return { anon, owner, orgId, bookingLinkId, token: manageToken(claim) };
  }

  const cancelNote = async (owner: Client, orgId: string): Promise<string> => {
    const acts = bodyAs<{ activities: Array<{ body: string }> }>(await owner.get(`/host/openwop-app/crm/orgs/${orgId}/activities`)).activities;
    const note = acts.find((a) => a.body.startsWith('Booking cancelled:'));
    expect(note, 'the cancellation timeline note exists').toBeTruthy();
    return note!.body;
  };

  // ADR 0837 D4 — CORRECTED. The reason used to ride INSIDE the timeline note,
  // which erasure keeps by design, so a visitor's free text outlived their
  // erasure. It now lives on the booking row (an erasure-scrubbed PII field),
  // shown in the bookings table; the note only says a reason was left.
  it('a typed reason lands on the booking (bounded) and the timeline only points at it', async () => {
    const { anon, owner, orgId, token, bookingLinkId } = await claimed();
    // PROBE CORRECTION: the first version padded 600 chars and asserted
    // length < 700 — the unbounded variant landed at ~673 and the probe came
    // back GREEN. The padding must make bounded and unbounded DISTINGUISHABLE:
    // 2000 chars of padding, and the assertion counts the padding that landed.
    const res = await anon.post(`/host/openwop-app/public-book/manage/${token}/cancel`, { reason: `Changed plans${'!'.repeat(2000)}` });
    expect(res.status).toBe(200);
    const body = await cancelNote(owner, orgId);
    expect(body).toContain('the visitor gave a reason, shown on the booking in the Booking tab');
    expect(body).not.toContain('Changed plans');
    const rows = await bookingsOf(owner, orgId, bookingLinkId);
    const reason = rows.find((b) => b.cancelReason)?.cancelReason ?? '';
    expect(reason.startsWith('Changed plans')).toBe(true);
    const landed = (reason.match(/!/g) ?? []).length;
    expect(landed, 'the 500-char bound holds — padding beyond it never lands').toBeLessThanOrEqual(500 - 'Changed plans'.length);
    expect(landed, 'and the bound is a TRUNCATION, not a rejection').toBeGreaterThan(400);
  });

  it('no reason (and whitespace-only) keeps the note byte-identical to before', async () => {
    const { anon, owner, orgId, token } = await claimed();
    const res = await anon.post(`/host/openwop-app/public-book/manage/${token}/cancel`, { reason: '   ' });
    expect(res.status).toBe(200);
    const body = await cancelNote(owner, orgId);
    expect(body, 'the pre-R3 note shape, unchanged').toMatch(/^Booking cancelled: ".+" \(.+\)$/);
    expect(body).not.toContain('visitor');
  });
});
