/**
 * Slack egress adapter via the Connections broker (ADR 0024 §4 Phase 3). Proves
 * ctx.slack.postMessage resolves the acting user's Slack Connection, calls
 * chat.postMessage with the token, maps the args, stamps provenance, and
 * gracefully no-ops (never throws) when no connection exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeSlackAdapter } from '../src/host/slackAdapter.js';
import { __resetConnectionsStore, upsertOAuthConnection } from '../src/features/connections/connectionsService.js';

describe('Slack egress adapter (ADR 0024 §4 Phase 3)', () => {
  let slackApi: http.Server;
  let storage: Storage;
  let received: { auth?: string; body?: Record<string, unknown> };
  let nextResponse: Record<string, unknown> = { ok: true, ts: '1700000000.000100', channel: 'C123' };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // allow loopback egress in test
    const app = await createApp({ port: 18945, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();

    slackApi = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received = { auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(nextResponse));
      });
    });
    await new Promise<void>((r) => slackApi.listen(0, r));
    process.env.OPENWOP_SLACK_API_BASE = `http://127.0.0.1:${(slackApi.address() as AddressInfo).port}`;

    await upsertOAuthConnection({ tenantId: 'tslack', provider: 'slack', userId: 'u1', tokens: { accessToken: 'xoxb-TESTTOKEN', tokenType: 'Bearer', scopes: ['chat:write'] } });
    await storage.insertRun({ runId: 'run-slack', workflowId: 'w', tenantId: 'tslack', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
  });

  afterAll(async () => {
    delete process.env.OPENWOP_SLACK_API_BASE;
    await new Promise<void>((r) => slackApi.close(() => r()));
  });

  const adapter = (actingUserId?: string): ReturnType<typeof makeSlackAdapter> =>
    makeSlackAdapter({ storage, tenantId: 'tslack', runId: 'run-slack', ...(actingUserId ? { actingUserId } : {}), orgId: 'tslack' });

  it('posts with the acting user’s token, maps args, and stamps provenance', async () => {
    nextResponse = { ok: true, ts: '1700000000.000100', channel: 'C123' };
    const out = await adapter('u1').postMessage({ channel: 'C123', text: 'hello', threadTs: '111.222', broadcast: true, idempotencyKey: 'k' });
    expect(out).toEqual({ ok: true, ts: '1700000000.000100', channel: 'C123' });
    expect(received.auth).toBe('Bearer xoxb-TESTTOKEN');
    expect(received.body).toMatchObject({ channel: 'C123', text: 'hello', thread_ts: '111.222', reply_broadcast: true });
    const meta = (await storage.getRun('run-slack'))?.metadata as Record<string, unknown> | undefined;
    expect((meta?.connectionUse as Array<{ provider?: string }> | undefined)?.[0]?.provider).toBe('slack');
  });

  it('surfaces a Slack API error (HTTP 200 {ok:false})', async () => {
    nextResponse = { ok: false, error: 'channel_not_found' };
    const out = await adapter('u1').postMessage({ channel: 'CNOPE', text: 'x' });
    expect(out).toEqual({ ok: false, error: 'channel_not_found' });
  });

  it('gracefully no-ops (never throws) when the acting user has no Slack connection', async () => {
    const noUser = await adapter().postMessage({ channel: 'C1', text: 'x' }); // no actingUserId → fail-closed
    expect(noUser).toEqual({ ok: false, error: 'slack_not_connected' });
    const otherUser = await adapter('u-without-slack').postMessage({ channel: 'C1', text: 'x' });
    expect(otherUser).toEqual({ ok: false, error: 'slack_not_connected' });
  });

  it('refuses to send the token over a non-https base unless private egress is allowed', async () => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; // production posture
    try {
      const out = await adapter('u1').postMessage({ channel: 'C1', text: 'x' }); // base is http://127.0.0.1
      expect(out).toEqual({ ok: false, error: 'insecure_slack_base' });
    } finally {
      process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true'; // restore for any later tests
    }
  });
});
