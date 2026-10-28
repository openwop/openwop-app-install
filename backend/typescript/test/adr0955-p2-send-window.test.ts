/**
 * ADR 0955 P2(a) — per-client send windows, the `next-send-window` timer node, the `send-sms`
 * journey node and the `campaign-journeys.sms` sub-toggle.
 *
 * Exit criteria (ADR 0955 phase table): a send outside the window waits and resumes; a fork
 * before the wait inherits `resumeAt`. The wait is witnessed through the REAL executor
 * (`POST /runs` → a `timer` interrupt carrying the frozen `until`) and a REAL `:fork` of the
 * suspended run (its interrupt keeps the same deadline). Twilio is a local stub.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - `nextSendWindow` checking only the FIRST zone (no intersection)      → "+1 intersects"
 *  - the resumeKey without the deadline (`send-window`)                    → "a new deadline suspends again"
 *  - `send-sms` returning success on a refusal                             → "typed failures"
 *  - the sub-toggle check removed                                           → "toggle off"
 *  - `smsSendContext` sending without a bound number (no `no_sender`)       → "typed failures"
 *  - `setSendPolicy` accepting a policy with no SMS window                   → "always has a window"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { bareRunId } from './support/bareRunId.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setSmsSender } from '../src/features/crm/smsSenders.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { makeSmsAdapter } from '../src/host/smsAdapter.js';
import { nextSendWindow, setSendPolicy, zonesFor } from '../src/features/campaign-journeys/sendPolicy.js';
import { buildCampaignJourneysSurface } from '../src/features/campaign-journeys/surface.js';
import * as pack from '../../../packs/feature.campaign-journeys.nodes/index.mjs';

let BASE = '';
let storage: Storage;
let twilio: http.Server;
const sent: string[] = [];
const T = `org:sms0955p2-${randomBytes(3).toString('hex')}`;
const SENDER = '+15550300001';

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  twilio = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { sent.push(raw); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sid: `SM${sent.length}`, status: 'queued' })); });
  });
  await new Promise<void>((r) => twilio.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_TWILIO_API_BASE = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  for (const id of ['campaign-journeys', 'campaign-journeys.sms', 'consent', 'crm', 'users']) await setToggle(id, 'on');
  const conn = await createSecretConnection({ tenantId: T, provider: 'twilio', kind: 'basic', secret: 'AC0955:token', scope: 'user', userId: 'u1' });
  await setSmsSender({ tenantId: T, number: SENDER, connectionId: conn.connectionId, boundBy: 'admin' });
  await storage.insertRun({ runId: 'run-p2', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  delete process.env.OPENWOP_TWILIO_API_BASE;
  await new Promise<void>((r) => twilio.close(() => r()));
});

describe('ADR 0955 D4 — the next send window', () => {
  const sms = { start: '09:00', end: '20:00' };
  it('inside the window is now; outside it is the next local start', () => {
    const inside = new Date('2026-10-20T15:00:00Z'); // 10:00 CDT
    expect(nextSendWindow({ now: inside, window: sms, zones: ['America/Chicago'] })).toEqual(inside);
    expect(nextSendWindow({ now: new Date('2026-10-20T03:00:00Z'), window: sms, zones: ['America/Chicago'] })?.toISOString()).toBe('2026-10-20T14:00:00.000Z');
  });
  it('+1 intersects all six US zones: inside the window from Honolulu to New York', () => {
    const z = zonesFor({ phone: '+15550100000' });
    expect(z.basis).toBe('phone_country');
    // 09:00 HST = 19:00Z is the first instant inside 09:00–20:00 everywhere (20:00 EDT = 00:00Z).
    expect(nextSendWindow({ now: new Date('2026-10-20T12:00:00Z'), window: sms, zones: z.zones })?.toISOString()).toBe('2026-10-20T19:00:00.000Z');
  });
  it('honours a DST change (New York leaves DST on 2026-11-01)', () => {
    expect(nextSendWindow({ now: new Date('2026-11-01T05:00:00Z'), window: sms, zones: ['America/New_York'] })?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
  it('no zone, or windows that never overlap, have no answer', () => {
    expect(nextSendWindow({ now: new Date(), window: sms, zones: [] })).toBeNull();
    expect(nextSendWindow({ now: new Date('2026-10-20T00:00:00Z'), window: { start: '09:00', end: '09:30' }, zones: ['Europe/London', 'Asia/Tokyo'] })).toBeNull();
  });
  it('resolves the zone in order: contact, client default, phone country, else unknown', () => {
    expect(zonesFor({ contactTimezone: 'Europe/Paris', defaultTimezone: 'UTC', phone: '+15550100000' })).toEqual({ zones: ['Europe/Paris'], basis: 'contact_timezone' });
    expect(zonesFor({ contactTimezone: 'Mars/Olympus', defaultTimezone: 'UTC' })).toEqual({ zones: ['UTC'], basis: 'client_default' });
    expect(zonesFor({ phone: '+4420' })).toEqual({ zones: ['Europe/London'], basis: 'phone_country' });
    expect(zonesFor({ phone: '+99912345678' })).toEqual({ zones: [], basis: 'unknown' });
  });
  it('a policy always has an SMS window, and refuses a bad one', async () => {
    const p = await setSendPolicy({ tenantId: T, orgId: 'policy-only-test', windows: { email: { start: '08:00', end: '18:00' } }, updatedBy: 'a' });
    expect(p.windows.sms).toEqual({ start: '09:00', end: '20:00' });
    await expect(setSendPolicy({ tenantId: T, orgId: 'x', windows: { sms: { start: '20:00', end: '09:00' } }, updatedBy: 'a' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(setSendPolicy({ tenantId: T, orgId: 'x', defaultTimezone: 'Nowhere/Here', updatedBy: 'a' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});

/** A contact who may receive marketing SMS. */
async function textable(): Promise<string> {
  const number = `+1555040${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const c = await createContact({ tenantId: T, name: 'Pat', phone: number });
  await recordConsent({ tenantId: T, subjectKey: c.contactId, categories: { 'marketing.sms': true }, source: 'test' });
  return c.contactId;
}

type NodeCtx = Record<string, unknown>;
const ctxFor = (inputs: Record<string, unknown>, extra: NodeCtx = {}): NodeCtx => ({
  runId: 'run-p2', nodeId: `n-${randomBytes(3).toString('hex')}`, inputs,
  features: { 'campaign-journeys': buildCampaignJourneysSurface({ tenantId: T }) },
  messaging: makeSmsAdapter({ storage, tenantId: T, runId: 'run-p2', actingUserId: 'u1' }),
  suspend: async (p: unknown) => { throw Object.assign(new Error('suspended'), { payload: p }); },
  ...extra,
});
const BODY = 'Hi Pat, 20% off today. Reply STOP to opt out.';

describe('ADR 0955 D2/D4 — the send-sms journey node', () => {
  // Pin the clock inside the workspace window (UTC 09:00–20:00), Date only.
  beforeAll(async () => { await setSendPolicy({ tenantId: T, orgId: '', defaultTimezone: 'UTC', updatedBy: 'a' }); });
  const at = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)); };

  it('sends from the client’s own number inside the window', async () => {
    at('2026-10-20T12:00:00Z');
    try {
      const contactId = await textable();
      const before = sent.length;
      const r = await pack.sendSms(ctxFor({ contactId, text: BODY }));
      expect(r).toMatchObject({ status: 'success', outputs: { sent: true, channel: 'sms' } });
      expect(sent.length).toBe(before + 1);
      expect(decodeURIComponent(sent.at(-1)!)).toContain(`From=${SENDER}`);
    } finally { vi.useRealTimers(); }
  });

  it('outside the window it waits (a timer until the window opens) instead of sending', async () => {
    at('2026-10-20T22:00:00Z');
    try {
      const contactId = await textable();
      const before = sent.length;
      await expect(pack.sendSms(ctxFor({ contactId, text: BODY }))).rejects.toMatchObject({ payload: { kind: 'until', timestamp: '2026-10-21T09:00:00.000Z', resumeKey: 'send-window:2026-10-21T09:00:00.000Z' } });
      expect(sent.length).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it('a new deadline suspends again instead of reusing an old resolution', async () => {
    at('2026-10-20T22:00:00Z');
    try {
      const contactId = await textable();
      // A resolution for a DIFFERENT (older) deadline must not let the node through.
      // Every key except this deadline's has an (older) resolution on record.
      const stale = async (p: { resumeKey?: string }) => { if (p.resumeKey !== 'send-window:2026-10-21T09:00:00.000Z') return { elapsed: true }; throw Object.assign(new Error('suspended'), { payload: p }); };
      await expect(pack.nextSendWindow(ctxFor({ contactId }, { suspend: stale }))).rejects.toMatchObject({ payload: { timestamp: '2026-10-21T09:00:00.000Z' } });
    } finally { vi.useRealTimers(); }
  });

  it('typed failures, never success with sent:false', async () => {
    at('2026-10-20T12:00:00Z');
    try {
      const contactId = await textable();
      expect(await pack.sendSms(ctxFor({ contactId, text: '20% off today.' }))).toMatchObject({ status: 'failed', error: { code: 'sms_body_invalid' } });
      const noConsent = (await createContact({ tenantId: T, name: 'No', phone: '+15550409999' })).contactId;
      expect(await pack.sendSms(ctxFor({ contactId: noConsent, text: BODY }))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
      const stopped = await textable();
      const { getContact } = await import('../src/features/crm/contactsService.js');
      await addSuppression(T, (await getContact(stopped))!.phone!, 'unsubscribed', 'sms:keyword-stop', undefined, { channel: 'sms' });
      expect(await pack.sendSms(ctxFor({ contactId: stopped, text: BODY }))).toMatchObject({ status: 'failed', error: { code: 'not_eligible' } });
      // A workspace with no bound number: never "any number", a typed no_sender.
      const T2 = `${T}-nosender`;
      await setSendPolicy({ tenantId: T2, orgId: '', defaultTimezone: 'UTC', updatedBy: 'a' });
      const lone = await createContact({ tenantId: T2, name: 'Lone', phone: '+15550408888' });
      await recordConsent({ tenantId: T2, subjectKey: lone.contactId, categories: { 'marketing.sms': true }, source: 'test' });
      const r = await pack.sendSms({ ...ctxFor({ contactId: lone.contactId, text: BODY }), features: { 'campaign-journeys': buildCampaignJourneysSurface({ tenantId: T2 }) } });
      expect(r).toMatchObject({ status: 'failed', error: { code: 'no_sender' } });
    } finally { vi.useRealTimers(); }
  });

  it('toggle off ⇒ sms_disabled', async () => {
    at('2026-10-20T12:00:00Z');
    await setToggle('campaign-journeys.sms', 'off');
    try {
      const contactId = await textable();
      expect(await pack.sendSms(ctxFor({ contactId, text: BODY }))).toMatchObject({ status: 'failed', error: { code: 'sms_disabled' } });
    } finally { await setToggle('campaign-journeys.sms', 'on'); vi.useRealTimers(); }
  });
});

// ── The real executor: the wait is a timer interrupt, and a fork inherits its deadline. ──
interface Res { status: number; body: Record<string, unknown> }
function client(): { call: (method: string, path: string, body?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  };
}

describe('ADR 0955 P2 exit — a send outside the window waits, and a fork inherits resumeAt', () => {
  it('suspends on a frozen `until`, and the fork of the suspended run keeps the same deadline', async () => {
    const tenantId = `org:p2exec-${randomBytes(3).toString('hex')}`;
    const owner = client();
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `p2exec-${randomBytes(3).toString('hex')}@acme.test`, tenantId })).status).toBe(201);
    // A window that is NOT now: a 5-minute slot twelve hours away, in UTC.
    const h = (new Date().getUTCHours() + 12) % 24;
    const start = `${String(h).padStart(2, '0')}:00`;
    await setSendPolicy({ tenantId, orgId: '', defaultTimezone: 'UTC', windows: { sms: { start, end: `${String(h).padStart(2, '0')}:05` } }, updatedBy: 'a' });
    const contact = await createContact({ tenantId, name: 'Exec', email: 'exec@acme.test' });
    const workflowId = `adr0955-p2-wait-${randomBytes(3).toString('hex')}`;
    registerWorkflow({ workflowId, name: 'wait for window', version: '1', nodes: [{ nodeId: 'window', typeId: 'feature.campaign-journeys.nodes.next-send-window', inputs: { contactId: contact.contactId, channel: 'sms' } }], edges: [] } as never);
    const create = await owner.call('POST', '/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = String(create.body.runId);
    const waitFor = async (id: string): Promise<string> => {
      for (let i = 0; i < 80; i++) { const s = String((await owner.call('GET', `/runs/${id}`)).body.status); if (s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return s; await new Promise((r) => setTimeout(r, 25)); }
      return 'timeout';
    };
    expect(await waitFor(runId)).toMatch(/^waiting/);
    const interrupts = async (id: string) => ((await owner.call('GET', `/host/openwop-app/runs/${bareRunId(id)}/interrupts`)).body.interrupts ?? []) as Array<{ kind: string; data?: Record<string, unknown> }>;
    const [timer] = await interrupts(runId);
    expect(timer).toMatchObject({ kind: 'timer', data: { kind: 'until' } });
    const resumeAt = String(timer!.data!.timestamp);
    expect(new Date(resumeAt).getUTCHours()).toBe(h);
    const marker = await getEventLog().append({ runId: bareRunId(runId), type: 'log.message', payload: { message: 'adr0955 fork point' } });
    const forked = await owner.call('POST', `/runs/${runId}:fork`, { mode: 'replay', fromSeq: marker.sequence });
    expect(forked.status, JSON.stringify(forked.body)).toBe(201);
    const forkId = String(forked.body.runId);
    expect(await waitFor(forkId)).toMatch(/^waiting/);
    const [forkTimer] = await interrupts(forkId);
    expect(forkTimer).toMatchObject({ kind: 'timer', data: { kind: 'until', timestamp: resumeAt } });
  });
});

describe('ADR 0955 D1 — the P2 verbs refuse an absent org once the workspace has a client', () => {
  it('checkSendWindow and smsSendContext', async () => {
    const { createOrg } = await import('../src/host/accessControlService.js');
    const { createClient } = await import('../src/features/campaign-ops/clientService.js');
    const tenantId = `org:p2abs-${randomBytes(3).toString('hex')}`;
    const org = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client (synthetic)' })).orgId;
    await createClient({ tenantId, orgId: org, name: 'Client (synthetic)', createdBy: 'seed' });
    const s = buildCampaignJourneysSurface({ tenantId });
    await expect(s.checkSendWindow!({ contactId: 'c' })).rejects.toMatchObject({ details: { reason: 'client_required' } });
    await expect(s.smsSendContext!({ contactId: 'c' })).rejects.toMatchObject({ details: { reason: 'client_required' } });
  });
});

describe('ADR 0955 D4 — the send-policy routes', () => {
  it('the workspace admin reads and writes it; a bad zone is a 400; another workspace cannot', async () => {
    const tenantId = `org:p2route-${randomBytes(3).toString('hex')}`;
    const owner = client();
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `p2r-${randomBytes(3).toString('hex')}@acme.test`, tenantId })).status).toBe(201);
    const put = await owner.call('PUT', '/host/openwop-app/campaign-journeys/send-policy', { defaultTimezone: 'America/Chicago', windows: { sms: { start: '10:00', end: '19:00' } } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const got = await owner.call('GET', '/host/openwop-app/campaign-journeys/send-policy');
    expect(got.body.policy).toMatchObject({ defaultTimezone: 'America/Chicago', windows: { sms: { start: '10:00', end: '19:00' } }, stored: true });
    expect((await owner.call('PUT', '/host/openwop-app/campaign-journeys/send-policy', { defaultTimezone: 'Nowhere/Here' })).status).toBe(400);
    const stranger = client();
    expect((await stranger.call('POST', '/host/openwop-app/test/login', { email: `p2s-${randomBytes(3).toString('hex')}@other.test`, tenantId: `org:p2other-${randomBytes(3).toString('hex')}` })).status).toBe(201);
    // The stranger's own workspace is theirs; they cannot name this one's client either.
    expect([403, 404]).toContain((await stranger.call('PUT', '/host/openwop-app/campaign-journeys/send-policy', { orgId: 'org-not-theirs' })).status);
  });
});
