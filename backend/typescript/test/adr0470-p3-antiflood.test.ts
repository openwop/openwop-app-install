/**
 * ADR 0470 P3 — proportionate bot-flood floor (architect ruling): a SECURE DEFAULT on
 * anon held writes/day (the operator inbox was unbounded-by-default) + a honeypot on the
 * public message endpoint. (A server-issued-challenge PoW was deferred as disproportionate
 * once the write target is default-bounded + per-IP rate-limited + HITL-gated.)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { checkAnonWrite } from '../src/features/chat-widget/capsTracker.js';
import { provisionWidget } from '../src/features/chat-widget/widgetService.js';
import type { WidgetConfig } from '../src/features/chat-widget/widgetService.js';

describe('ADR 0470 P3 — secure default write ceiling (inbox bounded WITHOUT operator config)', () => {
  beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

  it('an UNCONFIGURED anon widget (no maxWritesPerDay) is bounded by the default, not uncapped', async () => {
    // The default is OPENWOP_ANON_WRITE_DEFAULT_PER_DAY (25 when unset in the test env).
    const w = { widgetId: 'p3-w', tenantId: 't', orgId: 'o', agentId: 'a', allowedDomains: ['x.com'], caps: {}, token: 'wgt_x', enabled: true, createdBy: 'op', createdAt: '2026-07-23', updatedAt: '2026-07-23' } as WidgetConfig;
    const DAY = '2026-07-23';
    let allowed = 0;
    for (let i = 0; i < 40; i++) { if ((await checkAnonWrite(w, DAY)).allowed) allowed++; else break; }
    expect(allowed).toBe(25); // bounded at the secure default — NOT Infinity
    expect((await checkAnonWrite(w, DAY)).allowed).toBe(false);
  });

  it('an operator cap still wins (tighter bound honored)', async () => {
    const w = { widgetId: 'p3-w2', tenantId: 't', orgId: 'o', agentId: 'a', allowedDomains: ['x.com'], caps: { maxWritesPerDay: 2 }, token: 'wgt_y', enabled: true, createdBy: 'op', createdAt: '2026-07-23', updatedAt: '2026-07-23' } as WidgetConfig;
    const DAY = '2026-07-24';
    expect((await checkAnonWrite(w, DAY)).allowed).toBe(true);
    expect((await checkAnonWrite(w, DAY)).allowed).toBe(true);
    expect((await checkAnonWrite(w, DAY)).allowed).toBe(false); // operator's 2 < default 25
  });
});

describe('ADR 0470 P3 — honeypot on /widget/message', () => {
  let BASE: string; let server: http.Server; let token: string;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const w = await provisionWidget('hp-t', 'hp-o', 'admin', { agentId: 'feature.code-exec.agents.default', allowedDomains: ['acme.com'] });
    token = w.token;
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const postMsg = (body: unknown) => fetch(`${BASE}/v1/host/openwop-app/public/widget/message`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://acme.com' }, body: JSON.stringify(body),
  });

  it('REJECTS (400) a message whose honeypot field is filled — a bot signal', async () => {
    const r = await postMsg({ token, message: 'hi', sessionId: 's1', hp: 'spam@bot.com' });
    expect(r.status).toBe(400);
  });

  it('does NOT reject for the honeypot when hp is empty (the real widget always sends it empty)', async () => {
    const r = await postMsg({ token, message: 'hi', sessionId: 's2', hp: '' });
    // May 5xx (free-tier unavailable in tests) or 200, but NOT the 400 honeypot rejection.
    expect(r.status).not.toBe(400);
  });
});
