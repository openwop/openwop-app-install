/**
 * Email egress adapter via the Connections broker (ADR 0024 §4 Phase 3 / the
 * email-provider model). Proves ctx.email.send resolves the acting user's
 * api_key Connection, calls the provider's REST API (SendGrid) with the key,
 * maps the args, stamps provenance, and fail-closes gracefully.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeEmailAdapter } from '../src/host/emailAdapter.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';

describe('Email egress adapter — SendGrid (ADR 0024 §4 Phase 3)', () => {
  let sg: http.Server;
  let storage: Storage;
  let received: { auth?: string; body?: Record<string, unknown> };
  let status = 202;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18946, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    sg = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received = { auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} };
        if (status === 202) {
          res.writeHead(202, { 'x-message-id': 'sg-msg-123' });
          res.end();
        } else {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ message: 'invalid from address' }] }));
        }
      });
    });
    await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tmail', provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-mail', workflowId: 'w', tenantId: 'tmail', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_SENDGRID_API_BASE;
    await new Promise<void>((r) => sg.close(() => r()));
  });

  const adapter = (actingUserId?: string): ReturnType<typeof makeEmailAdapter> =>
    makeEmailAdapter({ storage, tenantId: 'tmail', runId: 'run-mail', ...(actingUserId ? { actingUserId } : {}), orgId: 'tmail' });

  it('sends via SendGrid with the api key, maps the args, and stamps provenance', async () => {
    status = 202;
    const out = await adapter('u1').send({ from: 'a@x.com', to: ['b@y.com'], cc: 'c@y.com', subject: 'hi', text: 'body', html: '<b>body</b>', provider: 'sendgrid' });
    expect(out).toEqual({ sent: true, provider: 'sendgrid', messageId: 'sg-msg-123' });
    expect(received.auth).toBe('Bearer SG.testkey');
    expect(received.body).toMatchObject({
      from: { email: 'a@x.com' },
      subject: 'hi',
      personalizations: [{ to: [{ email: 'b@y.com' }], cc: [{ email: 'c@y.com' }] }],
    });
    const meta = (await storage.getRun('run-mail'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.[0]?.provider).toBe('sendgrid');
  });

  it('surfaces a SendGrid error (non-2xx with structured body)', async () => {
    status = 400;
    const out = await adapter('u1').send({ from: 'bad', to: 'b@y.com', subject: 's', text: 't', provider: 'sendgrid' });
    expect(out).toEqual({ sent: false, provider: 'sendgrid', error: 'invalid from address' });
  });

  it('rejects an unsupported provider without sending', async () => {
    const out = await adapter('u1').send({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't', provider: 'mailgun' });
    expect(out).toEqual({ sent: false, provider: 'mailgun', error: 'email_provider_unsupported' });
  });

  it('fail-closes (never throws) without a connection', async () => {
    status = 202;
    const noUser = await adapter().send({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't', provider: 'sendgrid' });
    expect(noUser).toEqual({ sent: false, provider: 'sendgrid', error: 'email_not_connected' });
  });
});

describe('Email adapter — Postmark + idempotency ledger (ADR 0193 Phase 1)', () => {
  let pm: http.Server;
  let storage: Storage;
  let calls: Array<{ token?: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 18947, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    

    pm = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls.push({ token: req.headers['x-postmark-server-token'] as string, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ MessageID: 'pm-msg-1', ErrorCode: 0, Message: 'OK' }));
      });
    });
    await new Promise<void>((r) => pm.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_POSTMARK_API_BASE = `http://127.0.0.1:${(pm.address() as AddressInfo).port}`;

    await createSecretConnection({ tenantId: 'tpm', provider: 'postmark', kind: 'api_key', secret: 'PM-TOKEN-1', scope: 'user', userId: 'u1' });
    await storage.insertRun({ runId: 'run-pm', workflowId: 'w', tenantId: 'tpm', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_POSTMARK_API_BASE;
    await new Promise<void>((r) => pm.close(() => r()));
  });
  beforeEach(() => { calls = []; });

  const adapter = () => makeEmailAdapter({ storage, tenantId: 'tpm', runId: 'run-pm', actingUserId: 'u1', orgId: 'tpm' });

  it('sends via Postmark using the custom token header + Postmark body shape', async () => {
    const out = await adapter().send({ from: 'a@x.com', to: 'b@y.com', subject: 'hi', text: 'body', html: '<b>b</b>', provider: 'postmark', idempotencyKey: 'k-postmark-1' });
    expect(out).toEqual({ sent: true, provider: 'postmark', messageId: 'pm-msg-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe('PM-TOKEN-1'); // raw header, no Bearer prefix
    expect(calls[0]?.body).toMatchObject({ From: 'a@x.com', To: 'b@y.com', Subject: 'hi', TextBody: 'body', HtmlBody: '<b>b</b>', MessageStream: 'outbound' });
  });

  it('dedups on the idempotencyKey — a replay/retry does NOT call the provider twice', async () => {
    const args = { from: 'a@x.com', to: 'b@y.com', subject: 'dedup', text: 'once', provider: 'postmark', idempotencyKey: 'k-dedup' };
    const first = await adapter().send(args);
    const second = await adapter().send(args); // simulated replay: same key
    expect(first).toEqual({ sent: true, provider: 'postmark', messageId: 'pm-msg-1' });
    expect(second).toEqual(first); // recorded send returned verbatim
    expect(calls).toHaveLength(1); // provider hit exactly once
  });

  it('a genuinely different send (different key) is NOT suppressed', async () => {
    await adapter().send({ from: 'a@x.com', to: 'b@y.com', subject: 'first', text: 't', provider: 'postmark', idempotencyKey: 'k-a' });
    await adapter().send({ from: 'a@x.com', to: 'b@y.com', subject: 'second', text: 't', provider: 'postmark', idempotencyKey: 'k-b' });
    expect(calls).toHaveLength(2);
  });

  it('OPENWOP_EMAIL_DEFAULT_PROVIDER picks the provider when the node sets none', async () => {
    process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER = 'postmark';
    try {
      const out = await adapter().send({ from: 'a@x.com', to: 'b@y.com', subject: 'def', text: 't', idempotencyKey: 'k-default' });
      expect(out.provider).toBe('postmark');
      expect(out.sent).toBe(true);
    } finally {
      delete process.env.OPENWOP_EMAIL_DEFAULT_PROVIDER;
    }
  });
});
