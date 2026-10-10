/**
 * ADR 0853 D4 — inbound `decision:` messages on a project-linked connection.
 * Real app; the real `handleInboundEvent` (signature verification, dedup):
 *   - a signed Slack message starting `decision:` ⇒ ONE suggestion on the
 *     project (prefix stripped; title from the first line); a redelivery of the
 *     same event adds nothing;
 *   - any other text ⇒ nothing; a connection with no project ⇒ nothing.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import { handleInboundEvent, setInboundConfig } from '../src/features/connections/inboundWebhooks.js';
import { inboundText } from '../src/host/inboundMessageObservers.js';
import { listSuggestions } from '../src/features/team-intent-ledger/suggestions.js';

const SIGNING = 'slack-signing-secret-adr0853';
let BASE: string;
let server: http.Server;
let deps: Parameters<typeof handleInboundEvent>[0];
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite } as Parameters<typeof handleInboundEvent>[0];
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) as any };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b) };
}
const signed = (body: string, now: number) => {
  const ts = String(Math.floor(now / 1000));
  return { timestamp: ts, signature: `v0=${createHmac('sha256', SIGNING).update(`v0:${ts}:${body}`).digest('hex')}` };
};

async function setup(withProject = true) {
  const tenantId = `org:ib-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post('/host/openwop-app/test/login', { email: `ib-${n++}@acme.test`, tenantId })).body.user.userId as string;
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'InCo' })).body.orgId as string;
  const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Launch' })).body as { id: string };
  expect((await owner.post(`/host/openwop-app/team-ledger/projects/${proj.id}`)).status).toBe(201);
  const conn = await upsertOAuthConnection({ tenantId, provider: 'slack', userId: ownerId, tokens: { accessToken: 'AT', tokenType: 'Bearer', scopes: ['channels:read'] } });
  await setInboundConfig({ tenantId, connectionId: conn.connectionId, provider: 'slack', workflowId: 'wf-not-in-catalog', signingSecret: SIGNING, ...(withProject ? { projectId: proj.id } : {}) });
  return { tenantId, projectId: proj.id, connectionId: conn.connectionId };
}
const deliver = (connectionId: string, eventId: string, text: string) => {
  const now = Date.now();
  const raw = JSON.stringify({ type: 'event_callback', event_id: eventId, event: { type: 'message', text } });
  return handleInboundEvent(deps, { connectionId, rawBody: raw, body: JSON.parse(raw), headers: signed(raw, now), now });
};

describe('ADR 0853 D4 — inbound decisions', () => {
  it('reads the text of each provider shape', () => {
    expect(inboundText('slack', { text: 'a' })).toBe('a'); // what the handler passes (Slack's event object)
    expect(inboundText('slack', { event: { text: 'a2' } })).toBe('a2');
    expect(inboundText('telegram', { message: { text: 'b' } })).toBe('b');
    expect(inboundText('discord', { content: 'c' })).toBe('c');
    expect(inboundText('whatsapp-twilio', { Body: 'd' })).toBe('d');
    expect(inboundText('zoom-webinar', { text: 'x' })).toBeUndefined();
  });

  it('a "decision:" message ⇒ one suggestion; a redelivery adds nothing', async () => {
    const s = await setup();
    await deliver(s.connectionId, 'Ev1', 'Decision: ship the EU first\nlegal is ready');
    await deliver(s.connectionId, 'Ev1', 'Decision: ship the EU first\nlegal is ready');
    const list = await listSuggestions(s.tenantId, s.projectId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'ship the EU first', text: 'ship the EU first\nlegal is ready', source: { kind: 'inbound', ref: `${s.connectionId}:Ev1` }, suggestedBy: { kind: 'host', id: 'slack' } });
  });

  it('other text, or a connection with no project ⇒ nothing', async () => {
    const s = await setup();
    await deliver(s.connectionId, 'Ev2', 'we should maybe ship EU first?');
    expect(await listSuggestions(s.tenantId, s.projectId)).toHaveLength(0);
    const t = await setup(false);
    await deliver(t.connectionId, 'Ev3', 'decision: ship EU first');
    expect(await listSuggestions(t.tenantId, t.projectId)).toHaveLength(0);
  });
});
