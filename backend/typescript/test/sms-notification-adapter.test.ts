/**
 * SMS (Twilio) + push (Expo) egress adapters via the Connections broker
 * (ADR 0024 §4 Phase 3 / the provider model). Proves the brokered spine
 * generalizes across auth schemes — Twilio HTTP **Basic** (secret =
 * AccountSid:AuthToken, SID in the path) and Expo **Bearer** — resolving the
 * acting user's connection, mapping args, stamping provenance, and fail-closing.
 *
 * What breaks it (sabotage-witnessed, /grade-tests wave 61, 8fw3g1-sms-*,
 * 8fw3g1-push-idem): the Basic scheme, the SID-in-path, the provider-error
 * passthrough, the ADR 0619 ledger dedup, the per-key scoping, and the
 * no-connection / unsupported-provider short-circuits (the stub must receive
 * NOTHING). Provenance is read on a run of its own, so a stamp from another
 * case cannot satisfy it.
 *
 * DOUBLE GUARD (named): the ledger dedup is enforced twice — the `priorSend`
 * short-circuit AND `reserveSend` → `'duplicate'` → winner. Removing only the
 * first still dedups (8fw3g1-sms-prior, vacuous by design); removing both
 * reds the dedup case (8fw3g1-sms-dedup-both-r2).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeSmsAdapter } from '../src/host/smsAdapter.js';
import { makeNotificationAdapter } from '../src/host/notificationAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

describe('SMS + push egress adapters (ADR 0024 §4 Phase 3)', () => {
  let srv: http.Server;
  let storage: Storage;
  let req: { method?: string; url?: string; auth?: string; ctype?: string; body?: string } = {};
  let savedAllowPrivate: string | undefined;
  let respond: { status: number; json: unknown } = { status: 201, json: { sid: 'SM123', status: 'queued' } };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    savedAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18947, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    srv = http.createServer((r, res) => {
      let raw = '';
      r.on('data', (c) => (raw += c));
      r.on('end', () => {
        req = { method: r.method, url: r.url, auth: r.headers.authorization, ctype: r.headers['content-type'], body: raw };
        res.writeHead(respond.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(respond.json));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    process.env.OPENWOP_TWILIO_API_BASE = origin;
    process.env.OPENWOP_EXPO_API_BASE = origin;

    await createSecretConnection({ tenantId: 'tsn', provider: 'twilio', kind: 'basic', secret: 'AC123:authtoken', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: 'tsn', provider: 'expo', kind: 'api_key', secret: 'expo-token', scope: 'user', userId: 'u1' });
    for (const runId of ['run-sn', 'run-sn-basic']) {
      await storage.insertRun({ runId, workflowId: 'w', tenantId: 'tsn', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    }
  });

  afterAll(async () => {
    delete process.env.OPENWOP_TWILIO_API_BASE;
    delete process.env.OPENWOP_EXPO_API_BASE;
    if (savedAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = savedAllowPrivate;
    await new Promise<void>((r) => srv.close(() => r()));
  });
  beforeEach(() => { req = {}; });

  const sms = (u?: string, runId = 'run-sn'): ReturnType<typeof makeSmsAdapter> => makeSmsAdapter({ storage, tenantId: 'tsn', runId, ...(u ? { actingUserId: u } : {}), orgId: 'tsn' });
  const notif = (u?: string): ReturnType<typeof makeNotificationAdapter> => makeNotificationAdapter({ storage, tenantId: 'tsn', runId: 'run-sn', ...(u ? { actingUserId: u } : {}), orgId: 'tsn' });

  it('Twilio SMS: Basic auth, AccountSid in the path, form body, provenance stamp', async () => {
    respond = { status: 201, json: { sid: 'SM999', status: 'queued' } };
    const out = await sms('u1', 'run-sn-basic').sendSms({ to: '+15551112222', from: '+15553334444', text: 'hello' });
    expect(out).toEqual({ sent: true, provider: 'twilio', sid: 'SM999' });
    expect(req.auth).toBe(`Basic ${Buffer.from('AC123:authtoken').toString('base64')}`);
    expect(req.url).toBe('/2010-04-01/Accounts/AC123/Messages.json'); // SID from the secret
    expect(req.ctype).toContain('application/x-www-form-urlencoded');
    expect(req.body).toBe('To=%2B15551112222&From=%2B15553334444&Body=hello');
    const meta = (await storage.getRun('run-sn-basic'))?.metadata as { connectionUse?: Array<{ provider?: string }> } | undefined;
    expect(meta?.connectionUse?.map((u) => u.provider)).toEqual(['twilio']);
  });

  it('Twilio SMS: surfaces a provider error', async () => {
    respond = { status: 400, json: { message: 'invalid To number', code: 21211 } };
    // ADR 0955 D2: a recipient that is not E.164 never reaches Twilio, so the provider error
    // is provoked with a well-formed number the stub rejects.
    const out = await sms('u1').sendSms({ to: '+15551119999', from: '+15553334444', text: 'x' });
    expect(out).toEqual({ sent: false, provider: 'twilio', error: 'invalid To number' });
  });

  it('Expo push: Bearer auth, JSON body, ok→sent', async () => {
    respond = { status: 200, json: { data: { status: 'ok', id: 'expo-receipt-1' } } };
    const out = await notif('u1').push({ deviceToken: 'ExponentPushToken[xxx]', title: 'T', body: 'B', data: { k: 1 } });
    expect(out).toEqual({ sent: true, provider: 'expo', id: 'expo-receipt-1' });
    expect(req.auth).toBe('Bearer expo-token');
    expect(JSON.parse(req.body ?? '{}')).toMatchObject({ to: 'ExponentPushToken[xxx]', title: 'T', body: 'B', data: { k: 1 } });
  });

  it('Expo push: surfaces an Expo error (200 {data.status:error})', async () => {
    respond = { status: 200, json: { data: { status: 'error', message: 'DeviceNotRegistered' } } };
    const out = await notif('u1').push({ deviceToken: 'x', title: 'T', body: 'B' });
    expect(out).toEqual({ sent: false, provider: 'expo', error: 'DeviceNotRegistered' });
  });

  it('both fail-close without a connection, and reject unsupported providers', async () => {
    expect(await sms().sendSms({ to: '+15551112222', from: '+15553334444', text: 'x' })).toEqual({ sent: false, provider: 'twilio', error: 'sms_not_connected' });
    expect(await notif().push({ deviceToken: 'x', title: 'T', body: 'B' })).toEqual({ sent: false, provider: 'expo', error: 'notification_not_connected' });
    expect(await sms('u1').sendSms({ provider: 'vonage', to: '+15551112222', from: '+15553334444', text: 'x' })).toEqual({ sent: false, provider: 'vonage', error: 'sms_provider_unsupported' });
    expect(await notif('u1').push({ provider: 'fcm', deviceToken: 'x', title: 'T', body: 'B' })).toEqual({ sent: false, provider: 'fcm', error: 'notification_provider_unsupported' });
    expect(req, 'no refused send reached a provider').toEqual({});
  });
});

/**
 * ADR 0619 / NP-INT-1 — the egress send-idempotency ledger. A within-run
 * `config.retry` re-run (ADR 0326 — the invocation-log cache is keyed per attempt,
 * so a retry re-executes the node body and re-calls the adapter) must NOT double-send.
 * Counts provider POSTs across two adapter calls carrying the SAME fork-stable key.
 */
describe('SMS + push egress — idempotency ledger dedup (ADR 0619)', () => {
  let srv: http.Server;
  let storage: Storage;
  let calls: { sms: number; push: number } = { sms: 0, push: 0 };
  let savedAllowPrivate: string | undefined;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    savedAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18952, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    srv = http.createServer((r, res) => {
      let raw = '';
      r.on('data', (c) => (raw += c));
      r.on('end', () => {
        if ((r.url ?? '').includes('Messages.json')) {
          calls.sms++;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ sid: `SM-${calls.sms}`, status: 'queued' }));
        } else {
          calls.push++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { status: 'ok', id: `EX-${calls.push}` } }));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    process.env.OPENWOP_TWILIO_API_BASE = origin;
    process.env.OPENWOP_EXPO_API_BASE = origin;

    await createSecretConnection({ tenantId: 'tidem', provider: 'twilio', kind: 'basic', secret: 'AC777:tok', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: 'tidem', provider: 'expo', kind: 'api_key', secret: 'expo-tok', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-idem', workflowId: 'w', tenantId: 'tidem', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_TWILIO_API_BASE;
    delete process.env.OPENWOP_EXPO_API_BASE;
    if (savedAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = savedAllowPrivate;
    await new Promise<void>((r) => srv.close(() => r()));
  });

  // Reset the POST counter per test; the ledger persists (distinct keys per test
  // avoid any cross-test dedup).
  beforeEach(() => { calls = { sms: 0, push: 0 }; });

  const sms = () => makeSmsAdapter({ storage, tenantId: 'tidem', runId: 'run-idem', actingUserId: 'u1', orgId: 'tidem' });
  const push = () => makeNotificationAdapter({ storage, tenantId: 'tidem', runId: 'run-idem', actingUserId: 'u1', orgId: 'tidem' });

  it('SMS: a config.retry re-run with the SAME idempotencyKey dedups — Twilio POSTed once', async () => {
    const args = { provider: 'twilio', to: '+15551112222', from: '+15553334444', text: 'hi', idempotencyKey: 'idem-sms-1' };
    const first = await sms().sendSms(args);
    const retry = await sms().sendSms(args); // simulated attempt-2 (same runId/nodeId/key)
    expect(first).toEqual({ sent: true, provider: 'twilio', sid: 'SM-1' });
    expect(retry).toEqual(first); // recorded accept returned verbatim, no re-POST
    expect(calls.sms).toBe(1);
  });

  it('SMS: a genuinely different key is NOT suppressed', async () => {
    await sms().sendSms({ provider: 'twilio', to: '+15551112222', from: '+15553334444', text: 'a', idempotencyKey: 'idem-sms-a' });
    await sms().sendSms({ provider: 'twilio', to: '+15551112222', from: '+15553334444', text: 'b', idempotencyKey: 'idem-sms-b' });
    expect(calls.sms).toBe(2);
  });

  it('SMS: NO idempotencyKey ⇒ unguarded (pre-ADR behaviour, both POST)', async () => {
    const args = { provider: 'twilio', to: '+15551112222', from: '+15553334444', text: 'x' };
    await sms().sendSms(args);
    await sms().sendSms(args);
    expect(calls.sms).toBe(2);
  });

  it('push: a retry with the SAME idempotencyKey dedups — Expo POSTed once', async () => {
    const args = { provider: 'expo', deviceToken: 'ExponentPushToken[x]', title: 'T', body: 'B', idempotencyKey: 'idem-push-1' };
    const first = await push().push(args);
    const retry = await push().push(args);
    expect(first).toEqual({ sent: true, provider: 'expo', id: 'EX-1' });
    expect(retry).toEqual(first);
    expect(calls.push).toBe(1);
  });
});
