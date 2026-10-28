/**
 * ADR 0955 P1 — strict SMS consent, inbound `twilio` SMS, the shared keyword ladder, and the
 * STOP guard at the SMS adapter.
 *
 * Exit criteria (ADR 0955 phase table): a STOP blocks the next send from every caller,
 * including the generic `sms-send` node; the WhatsApp ladder suites are unchanged (they run
 * as they are: `whatsapp-channel`, `adr0878-wa-service-reply`).
 *
 * The Twilio API is a local stub server (`OPENWOP_TWILIO_API_BASE`) — recorded shapes, no
 * vendor account. A live sandbox row is OPEN for David (ADR 0955 Q4).
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the adapter guard removed                                     → "generic sms-send node"
 *  - the guard always passing `anySender: false`                   → "unbound sender"
 *  - the `MessageSid` dedup removed                                → "replayed STOP"
 *  - START lifting any reason (no actor/note check)                → "STOPALL survives START"
 *  - `marketing.sms` dropped from STRICT_EXPLICIT_OPT_IN           → "strict"
 *  - the STOP scope ignoring the `To` binding                      → "client A's STOP"
 *  - the SMS observer acked fail-soft (no strict notify)           → "could not be written"
 *  - START lifting any reason (with the STOPALL + operator-hold cases) → both START cases
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setInboundConfig, inboundSupported } from '../src/features/connections/inboundWebhooks.js';
import { setSmsSender } from '../src/features/crm/smsSenders.js';
import { makeSmsAdapter } from '../src/host/smsAdapter.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { getConsent, isAllowed, recordConsent } from '../src/features/consent/consentService.js';
import { classifyKeyword } from '../src/features/consent/keywordLadder.js';

type SmsSendNode = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: { sent: boolean; error?: string } }>;
async function loadSmsSend(): Promise<SmsSendNode> {
  // Same exception as email-send-fork-idempotency.test.ts: the pack is untyped ESM, imported for a node-level test.
  // @ts-expect-error TS7016 — untyped ESM pack imported for a node-level unit test; vitest resolves it at runtime.
  const mod = (await import('../../../packs/core.openwop.integration/index.mjs')) as { smsSend: SmsSendNode };
  return mod.smsSend;
}

const AUTH_TOKEN = 'twilio-auth-token-secret-0955';
let BASE = '';
let PUBLIC = '';
let storage: Storage;
let twilio: http.Server;
let twilioReply: { status: number; json: unknown } = { status: 201, json: { sid: 'SM-out-1', status: 'queued' } };
let posts = 0;
let TENANT = '';
let orgA = '';
let orgB = '';
let connectionId = '';
const NUM_A = '+15550100001';
const NUM_B = '+15550100002';
const NUM_UNBOUND = '+15550100009';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.test';
  PUBLIC = 'https://app.example.test';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  twilio = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { posts += 1; res.writeHead(twilioReply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(twilioReply.json)); });
  });
  await new Promise<void>((r) => twilio.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_TWILIO_API_BASE = `http://127.0.0.1:${(twilio.address() as AddressInfo).port}`;
  // crm and campaign-journeys stay OFF: the keyword observer and the exit guard are ungated.
  const consent = getToggleDefault('consent');
  if (consent) await saveConfig({ ...consent, status: 'on' }, 'test');
  // A non-signed-in tenant id (as `whatsapp-channel.test.ts` uses): the inbound signing secret
  // goes through BYOK, which refuses a signed-in tenant without KMS in this test process.
  TENANT = `org:sms0955-${randomBytes(3).toString('hex')}`;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B (synthetic)' })).orgId;
  connectionId = (await createSecretConnection({ tenantId: TENANT, provider: 'twilio', kind: 'basic', secret: 'AC0955:authtoken', scope: 'user', userId: 'u1' })).connectionId;
  await setInboundConfig({ tenantId: TENANT, connectionId, provider: 'twilio', signingSecret: AUTH_TOKEN });
  await setSmsSender({ tenantId: TENANT, number: NUM_A, orgId: orgA, connectionId, boundBy: 'admin' });
  await setSmsSender({ tenantId: TENANT, number: NUM_B, orgId: orgB, connectionId, boundBy: 'admin' });
  await storage.insertRun({ runId: 'run-sms0955', workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
});
afterAll(async () => {
  delete process.env.OPENWOP_TWILIO_API_BASE;
  delete process.env.OPENWOP_PUBLIC_BASE_URL;
  await new Promise<void>((r) => twilio.close(() => r()));
});

const sms = () => makeSmsAdapter({ storage, tenantId: TENANT, runId: 'run-sms0955', actingUserId: 'u1' });
const fresh = () => `+1555020${String(Math.floor(Math.random() * 9000) + 1000)}`;

function sign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', AUTH_TOKEN).update(data, 'utf8').digest('base64');
}

/** A signed Twilio inbound SMS through the real public route. */
async function inbound(from: string, to: string, body: string, opts: { sid?: string; signature?: string } = {}): Promise<{ status: number; sid: string }> {
  const path = `/host/openwop-app/connections-inbound/${encodeURIComponent(connectionId)}`;
  const sid = opts.sid ?? `SM${randomBytes(8).toString('hex')}`;
  const params = { MessageSid: sid, From: from, To: to, Body: body };
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': opts.signature ?? sign(`${PUBLIC}${path}`, params) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, sid };
}

describe('ADR 0955 D3 — the shared keyword ladder', () => {
  it('classifies SMS keywords and keeps WhatsApp’s words exactly', () => {
    expect(classifyKeyword('sms', ' STOP ')).toBe('opt-out');
    expect(classifyKeyword('sms', 'stopall')).toBe('opt-out-all');
    expect(classifyKeyword('sms', 'Unstop')).toBe('opt-in');
    expect(classifyKeyword('sms', 'help')).toBe('help');
    expect(classifyKeyword('sms', 'stop texting me please')).toBeNull();
    expect(classifyKeyword('sms', 'yes')).toBeNull();
    expect(classifyKeyword('whatsapp', 'baja')).toBe('opt-out');
    expect(classifyKeyword('whatsapp', 'stopall')).toBe('opt-out'); // WhatsApp has no workspace-wide variant
    expect(classifyKeyword('whatsapp', 'help')).toBeNull();
  });
});

describe('ADR 0955 D3 (J3) — marketing SMS is strict explicit opt-in', () => {
  it('an umbrella-only record no longer permits SMS; an explicit one does', async () => {
    await recordConsent({ tenantId: TENANT, subjectKey: 'strict-umbrella', categories: { marketing: true }, source: 'test' });
    expect(await isAllowed(TENANT, 'strict-umbrella', 'marketing.email')).toBe(true);
    expect(await isAllowed(TENANT, 'strict-umbrella', 'marketing.sms')).toBe(false);
    await recordConsent({ tenantId: TENANT, subjectKey: 'strict-explicit', categories: { 'marketing.sms': true }, source: 'test' });
    expect(await isAllowed(TENANT, 'strict-explicit', 'marketing.sms')).toBe(true);
  });
});

describe('ADR 0955 D2/D3 — a STOP blocks the next send from every caller', () => {
  it('inbound SMS is a supported, signature-verified provider', async () => {
    expect(inboundSupported('twilio')).toBe(true);
    expect((await inbound(fresh(), NUM_A, 'STOP', { signature: 'forged' })).status).toBe(401);
  });

  it('client A’s STOP stops client A’s sender only', async () => {
    const person = fresh();
    expect((await inbound(person, NUM_A, 'STOP')).status).toBe(202);
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'promo' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
    expect(await sms().sendSms({ to: person, from: NUM_B, text: 'promo' })).toMatchObject({ sent: true });
  });

  it('the generic sms-send node is refused too (the guard is at the exit)', async () => {
    const person = fresh();
    await inbound(person, NUM_A, 'stop');
    const before = posts;
    const out = await (await loadSmsSend())({ runId: 'run-sms0955', nodeId: 'n1', config: {}, inputs: { to: person, from: NUM_A, text: 'hi' }, messaging: sms() });
    expect(out.outputs).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
    expect(posts).toBe(before); // Twilio was never called
  });

  it('a sender bound to no client is checked against every scope (unbound sender)', async () => {
    const person = fresh();
    await inbound(person, NUM_B, 'STOP');
    expect(await sms().sendSms({ to: person, from: NUM_UNBOUND, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
  });

  it('START lifts that sender’s own STOP, and a replayed STOP does nothing', async () => {
    const person = fresh();
    const stop = await inbound(person, NUM_A, 'STOP');
    expect((await inbound(person, NUM_A, 'START')).status).toBe(202);
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'back' })).toMatchObject({ sent: true });
    // The same signed STOP, replayed after the START: applied at most once, by MessageSid.
    expect((await inbound(person, NUM_A, 'STOP', { sid: stop.sid })).status).toBe(202);
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'still back' })).toMatchObject({ sent: true });
  });

  it('STOPALL stops every client, revokes consent on the number and the contact, and survives a START', async () => {
    const person = fresh();
    const contact = await createContact({ tenantId: TENANT, name: 'Stopall', phone: person });
    await recordConsent({ tenantId: TENANT, subjectKey: contact.contactId, categories: { 'marketing.sms': true }, source: 'test' });
    expect((await inbound(person, NUM_B, 'STOPALL')).status).toBe(202);
    for (const from of [NUM_A, NUM_B, NUM_UNBOUND]) {
      expect(await sms().sendSms({ to: person, from, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
    }
    expect((await getConsent(TENANT, person))?.categories['marketing.sms']).toBe(false);
    expect((await getConsent(TENANT, contact.contactId))?.categories['marketing.sms']).toBe(false);
    await inbound(person, NUM_A, 'START');
    // A START to a number bound to no client reaches the workspace-scope row itself: it
    // must still not lift a STOPALL (only a consent-bearing flow can).
    await inbound(person, NUM_UNBOUND, 'START');
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
  });

  it('START never lifts an operator hold on that sender', async () => {
    const person = fresh();
    const { addSuppression } = await import('../src/features/crm/suppressionService.js');
    await addSuppression(TENANT, person, 'manual', 'operator', 'legal hold', { channel: 'sms', senderOrgId: orgA });
    await inbound(person, NUM_A, 'START');
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
  });

  it.each(['complaint', 'manual'] as const)('START cannot erase a concurrent %s hold on that sender', async (reason) => {
    const person = fresh();
    await inbound(person, NUM_A, 'STOP');
    const { addSuppression } = await import('../src/features/crm/suppressionService.js');
    const target = `hostext:crm:suppression:${TENANT}::#sms:${person}:${orgA}`;
    const get = storage.kvGet.bind(storage);
    let interleaved = false;
    const staleRead = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      const observed = await get(key);
      if (!interleaved && key === target && observed && (JSON.parse(observed) as { reason?: string }).reason === 'unsubscribed') {
        interleaved = true;
        await addSuppression(TENANT, person, reason, 'operator', 'Concurrent hold', { channel: 'sms', senderOrgId: orgA });
      }
      return observed;
    });
    try { expect((await inbound(person, NUM_A, 'START')).status).toBe(202); }
    finally { staleRead.mockRestore(); }
    expect(interleaved).toBe(true);
    const before = posts;
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'held' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
    expect(posts).toBe(before);
  });

  it('a STOP that could not be written is a 5xx, and its redelivery still lands', async () => {
    const person = fresh();
    // Inject below the suppression owner's guarded writer: addSuppression now
    // uses CAS so a failed read/write can never downgrade an existing hold.
    const swap = storage.kvCompareAndSwap.bind(storage);
    const failing = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0].startsWith('hostext:crm:suppression:')) throw new Error('kv down');
      return swap(...args);
    });
    let first: { status: number; sid: string };
    try { first = await inbound(person, NUM_A, 'STOP'); } finally { failing.mockRestore(); }
    expect(first.status).toBe(500);
    expect((await inbound(person, NUM_A, 'STOP', { sid: first.sid })).status).toBe(202);
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
  });

  it('HELP and ordinary replies write nothing', async () => {
    const person = fresh();
    await inbound(person, NUM_A, 'HELP');
    await inbound(person, NUM_A, 'what time do you open?');
    expect(await sms().sendSms({ to: person, from: NUM_A, text: 'x' })).toMatchObject({ sent: true });
  });

  it('refuses a recipient that is not E.164, and names Twilio’s own opt-out (21610)', async () => {
    expect(await sms().sendSms({ to: '415 555 0100', from: NUM_A, text: 'x' })).toMatchObject({ sent: false, error: 'sms_invalid_recipient' });
    twilioReply = { status: 400, json: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } };
    try {
      expect(await sms().sendSms({ to: fresh(), from: NUM_A, text: 'x' })).toMatchObject({ sent: false, error: 'sms_recipient_opted_out' });
    } finally { twilioReply = { status: 201, json: { sid: 'SM-out-1', status: 'queued' } }; }
  });
});

describe('ADR 0955 D3 — sender bindings stay tied to their connection', () => {
  it('refuses a non-Twilio connection, a foreign org, and a number that is not E.164', async () => {
    const other = (await createSecretConnection({ tenantId: TENANT, provider: 'expo', kind: 'api_key', secret: 'k', scope: 'user', userId: 'u1' })).connectionId;
    await expect(setSmsSender({ tenantId: TENANT, number: fresh(), connectionId: other, boundBy: 'a' })).rejects.toMatchObject({ details: { reason: 'not_twilio' } });
    await expect(setSmsSender({ tenantId: TENANT, number: fresh(), orgId: 'org-elsewhere', connectionId, boundBy: 'a' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(setSmsSender({ tenantId: TENANT, number: '555', connectionId, boundBy: 'a' })).rejects.toMatchObject({ code: 'validation_error' });
  });
});
