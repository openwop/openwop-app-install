/**
 * SMS (Twilio) + push (Expo) egress adapters via the Connections broker
 * (ADR 0024 §4 Phase 3 / the provider model). Proves the brokered spine
 * generalizes across auth schemes — Twilio HTTP **Basic** (secret =
 * AccountSid:AuthToken, SID in the path) and Expo **Bearer** — resolving the
 * acting user's connection, mapping args, stamping provenance, and fail-closing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  let req: { method?: string; url?: string; auth?: string; ctype?: string; body?: string };
  let respond: { status: number; json: unknown } = { status: 201, json: { sid: 'SM123', status: 'queued' } };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
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
    await new Promise<void>((r) => srv.listen(0, r));
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    process.env.OPENWOP_TWILIO_API_BASE = origin;
    process.env.OPENWOP_EXPO_API_BASE = origin;

    await createSecretConnection({ tenantId: 'tsn', provider: 'twilio', kind: 'basic', secret: 'AC123:authtoken', scope: 'user', userId: 'u1' });
    await createSecretConnection({ tenantId: 'tsn', provider: 'expo', kind: 'api_key', secret: 'expo-token', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-sn', workflowId: 'w', tenantId: 'tsn', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_TWILIO_API_BASE;
    delete process.env.OPENWOP_EXPO_API_BASE;
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const sms = (u?: string): ReturnType<typeof makeSmsAdapter> => makeSmsAdapter({ storage, tenantId: 'tsn', runId: 'run-sn', ...(u ? { actingUserId: u } : {}), orgId: 'tsn' });
  const notif = (u?: string): ReturnType<typeof makeNotificationAdapter> => makeNotificationAdapter({ storage, tenantId: 'tsn', runId: 'run-sn', ...(u ? { actingUserId: u } : {}), orgId: 'tsn' });

  it('Twilio SMS: Basic auth, AccountSid in the path, form body, provenance stamp', async () => {
    respond = { status: 201, json: { sid: 'SM999', status: 'queued' } };
    const out = await sms('u1').sendSms({ to: '+15551112222', from: '+15553334444', text: 'hello' });
    expect(out).toEqual({ sent: true, provider: 'twilio', sid: 'SM999' });
    expect(req.auth).toBe(`Basic ${Buffer.from('AC123:authtoken').toString('base64')}`);
    expect(req.url).toBe('/2010-04-01/Accounts/AC123/Messages.json'); // SID from the secret
    expect(req.ctype).toContain('application/x-www-form-urlencoded');
    expect(req.body).toBe('To=%2B15551112222&From=%2B15553334444&Body=hello');
    const meta = (await storage.getRun('run-sn'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.some((u) => u.provider === 'twilio')).toBe(true);
  });

  it('Twilio SMS: surfaces a provider error', async () => {
    respond = { status: 400, json: { message: 'invalid To number', code: 21211 } };
    const out = await sms('u1').sendSms({ to: 'bad', from: '+1', text: 'x' });
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
    expect(await sms().sendSms({ to: '+1', from: '+1', text: 'x' })).toEqual({ sent: false, provider: 'twilio', error: 'sms_not_connected' });
    expect(await notif().push({ deviceToken: 'x', title: 'T', body: 'B' })).toEqual({ sent: false, provider: 'expo', error: 'notification_not_connected' });
    expect(await sms('u1').sendSms({ provider: 'vonage', to: '+1', from: '+1', text: 'x' })).toEqual({ sent: false, provider: 'vonage', error: 'sms_provider_unsupported' });
    expect(await notif('u1').push({ provider: 'fcm', deviceToken: 'x', title: 'T', body: 'B' })).toEqual({ sent: false, provider: 'fcm', error: 'notification_provider_unsupported' });
  });
});
