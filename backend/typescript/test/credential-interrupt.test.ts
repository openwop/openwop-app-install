/**
 * RFC 0199 §C — the `credential` interrupt, end to end over HTTP (ADR 0753 P4).
 *
 * One workflow, one node declaring `auth: { type: "oauth2", provider, scopes }`.
 * The provider's token endpoint is the guarded-egress chokepoint, faked here.
 * Legs run in order because credentials persist between them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

vi.mock('../src/host/webhookEgressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    guardedEgressFetch: vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, access_token: 'xoxp-test', refresh_token: 'rt', expires_in: 3600, scope: 'chat:write' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })),
  };
});

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { __setConnectionStatusForTests, listConnections, revokeConnection, upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import { projectRunStatusToTaskState } from '../src/host/a2aTaskStore.js';
import { projectTaskRecordToA2aTask10 } from '../src/host/a2aCodec10.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
const TOKEN = 'dev-token';
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const WF = `cred-wf-${Date.now()}`;
const NODE = 'use-credential';
const PUBLIC_BASE = 'https://host.example';

type Ev = { type: string; payload?: Record<string, unknown> };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID = 'cid';
  process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET = 'csecret';
  process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = PUBLIC_BASE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const reg = await fetch(`${BASE}/v1/host/openwop-app/workflows`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      workflowId: WF,
      nodes: [{ nodeId: NODE, typeId: 'core.noop', config: { auth: { type: 'oauth2', provider: 'slack', scopes: ['chat:write'] } } }],
      edges: [],
    }),
  });
  expect([200, 201], await reg.clone().text()).toContain(reg.status);
});

afterAll(async () => {
  delete process.env.OPENWOP_OAUTH_ADVERTISE;
  await new Promise<void>((res) => server.close(() => res()));
});

async function startRun(): Promise<string> {
  const r = await fetch(`${BASE}/v1/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: WF, inputs: {} }) });
  expect([200, 201, 202], await r.clone().text()).toContain(r.status);
  return ((await r.json()) as { runId: string }).runId;
}

async function settle(runId: string, want: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${BASE}/v1/runs/${runId}`, { headers: H });
    status = ((await r.json()) as { status: string }).status;
    if (want(status)) return status;
    await new Promise((res) => setTimeout(res, 50));
  }
  return status;
}

async function events(runId: string): Promise<Ev[]> {
  const r = await fetch(`${BASE}/v1/runs/${runId}/events/poll?timeout=0`, { headers: H });
  return ((await r.json()) as { events?: Ev[] }).events ?? [];
}

async function resolve(runId: string, resumeValue: unknown): Promise<Response> {
  return fetch(`${BASE}/v1/runs/${runId}/interrupts/${NODE}`, { method: 'POST', headers: H, body: JSON.stringify({ resumeValue }) });
}

function v2SuspendRequestValidator(): (x: unknown) => boolean {
  const dir = join(locateRepoSchemasDir(__dirname, 'v2/suspend-request.schema.json'), 'v2');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.schema.json'))) {
    try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as object); } catch { /* duplicate ids are fine */ }
  }
  const v = ajv.getSchema('https://openwop.dev/spec/v2/suspend-request.schema.json');
  if (!v) throw new Error('suspend-request schema not found');
  return (x) => v(x) as boolean;
}

async function mySubject(): Promise<string> {
  const run = await storage.getRun(await startRun());
  return String((run?.metadata as Record<string, unknown>).actingUserId);
}

describe('RFC 0199 §C.1 — without the facet, nothing changes', () => {
  it('a node declaring oauth2 runs as before (no interrupt) when oauth is not advertised', async () => {
    delete process.env.OPENWOP_OAUTH_ADVERTISE;
    const runId = await startRun();
    expect(await settle(runId, (s) => s === 'completed' || s === 'failed' || s.startsWith('waiting'))).toBe('completed');
    expect((await events(runId)).some((e) => e.type === 'interrupt.requested')).toBe(false);
  });
});

describe('RFC 0199 §C — the credential interrupt (facet advertised)', () => {
  beforeAll(() => { process.env.OPENWOP_OAUTH_ADVERTISE = 'true'; });

  let runId = '';

  it('§C.2/§C.3 — no credential: the run waits on a closed, schema-valid credential ask', async () => {
    runId = await startRun();
    expect(await settle(runId, (s) => s.startsWith('waiting') || s === 'completed' || s === 'failed')).toBe('waiting-input');
    const ask = (await events(runId)).find((e) => e.type === 'interrupt.requested');
    expect(ask?.payload?.kind).toBe('credential');
    expect(ask?.payload?.key).toBe(NODE);
    const data = ask?.payload?.data as Record<string, unknown>;
    expect(data).toMatchObject({ provider: 'slack', scopes: ['chat:write'], reason: 'missing' });
    // The canonical, version-agnostic vendor root (ADR 0652) — it outlives `/v1`.
    expect(String(data.connectUrl)).toBe(`${PUBLIC_BASE}/host/openwop-app/connections/connect/${encodeURIComponent(runId)}/${NODE}`);
    expect(v2SuspendRequestValidator()(ask?.payload)).toBe(true);
  });

  it('§C.4 — a caller\'s "authorized" is re-checked: 400 validation_error on resumeValue while nothing resolves', async () => {
    const r = await resolve(runId, { outcome: 'authorized' });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; details?: { field?: string } };
    expect(body.error).toBe('validation_error');
    expect(body.details?.field).toBe('resumeValue');
    expect(await settle(runId, () => true)).toBe('waiting-input');
  });

  it('§C.4/§C.6 — the resume is closed: a credential cannot ride it', async () => {
    expect((await resolve(runId, { outcome: 'authorized', token: 'xoxb-secret' })).status).toBe(400);
    expect((await resolve(runId, { outcome: 'maybe' })).status).toBe(400);
  });

  it('§C.3 — connectUrl is not pre-authenticated: anonymous gets no authorization URL', async () => {
    const r = await fetch(`${BASE}/v1/host/openwop-app/connections/connect/${runId}/${NODE}`, { redirect: 'manual' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers.get('location') ?? '').not.toContain('slack.com');
  });

  it('§C.3 — connectUrl refuses a user other than the run\'s owner (no authorization URL)', async () => {
    const other = await startRun();
    await settle(other, (s) => s === 'waiting-input');
    const run = await storage.getRun(other);
    await storage.updateRun(other, { metadata: { ...(run!.metadata as Record<string, unknown>), actingUserId: 'someone-else' } });
    const r = await fetch(`${BASE}/v1/host/openwop-app/connections/connect/${other}/${NODE}`, { headers: H, redirect: 'manual' });
    expect(r.status).toBe(403);
    expect(r.headers.get('location')).toBeNull();
  });

  it('a recorded DECLINE wins over a credential that appeared since (never silently overridden)', async () => {
    const subject = await mySubject();
    await upsertOAuthConnection({ tenantId: 'default', provider: 'slack', userId: subject, tokens: { accessToken: 'at', refreshToken: 'rt', scopes: ['chat:write'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } as never });
    expect((await resolve(runId, { outcome: 'declined' })).status).toBeLessThan(300);
    expect(await settle(runId, (s) => s === 'failed' || s === 'completed')).toBe('failed');
    const failed = (await events(runId)).find((e) => e.type === 'node.failed');
    expect((failed?.payload?.error as { code?: string })?.code).toBe('connector_auth_declined');
    for (const c of await listConnections('default', subject)) await revokeConnection('default', c.connectionId);
  });

  it('§C.4 — the owner opens connectUrl, consents, and the HOST resolves the interrupt: the run completes', async () => {
    const run2 = await startRun();
    expect(await settle(run2, (s) => s === 'waiting-input')).toBe('waiting-input');
    // Open the EXACT connectUrl the interrupt carries (its canonical `/host/…` path), on this test server.
    const ask = (await events(run2)).find((e) => e.type === 'interrupt.requested');
    const connectUrl = String((ask?.payload?.data as { connectUrl?: string }).connectUrl).replace(PUBLIC_BASE, BASE);
    const open = await fetch(connectUrl, { headers: H, redirect: 'manual' });
    expect(open.status).toBe(302);
    const authorizeUrl = new URL(open.headers.get('location') ?? '');
    expect(authorizeUrl.host).toBe('slack.com');
    const state = authorizeUrl.searchParams.get('state')!;
    const cb = await fetch(`${BASE}/v1/host/openwop-app/connections/slack/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: H, redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('connected=slack');
    expect(await settle(run2, (s) => s === 'completed' || s === 'failed')).toBe('completed');
    const resolved = (await events(run2)).find((e) => e.type === 'interrupt.resolved');
    expect(resolved?.payload?.resumeValue).toEqual({ outcome: 'authorized' });
  });

  it('§C.2(b) — a terminal refresh failure emits connector.auth_expired BEFORE the credential ask (reason: expired)', async () => {
    const subject = await mySubject();
    const [conn] = await listConnections('default', subject);
    expect(conn).toBeDefined();
    await __setConnectionStatusForTests(conn!.connectionId, 'needs-reconsent');
    const run3 = await startRun();
    expect(await settle(run3, (s) => s === 'waiting-input' || s === 'completed' || s === 'failed')).toBe('waiting-input');
    const evs = await events(run3);
    const expired = evs.findIndex((e) => e.type === 'connector.auth_expired');
    const asked = evs.findIndex((e) => e.type === 'interrupt.requested');
    expect(expired).toBeGreaterThanOrEqual(0);
    expect(expired).toBeLessThan(asked);
    expect(evs[expired]?.payload).toMatchObject({ provider: 'slack', credentialRef: conn!.connectionId });
    expect((evs[asked]?.payload?.data as { reason?: string }).reason).toBe('expired');
  });
});

describe('RFC 0199 §D.1 — A2A projection', () => {
  const open = { kind: 'credential', data: { provider: 'slack', scopes: ['chat:write'], reason: 'missing', connectUrl: 'https://host.example/c/r/n' } };

  it('a waiting-input run on a credential interrupt is auth-required, naming the provider and connectUrl', () => {
    const p = projectRunStatusToTaskState('waiting-input', open);
    expect(p.state).toBe('auth-required');
    expect(p.interruptKind).toBe('credential');
    expect(p.statusMessage).toContain('slack');
    expect(p.statusMessage).toContain('https://host.example/c/r/n');
    expect(projectRunStatusToTaskState('waiting-input', { kind: 'clarification', data: {} }).state).toBe('input-required');
  });

  it('the 1.0 Task carries TASK_STATE_AUTH_REQUIRED, the status message and interrupt kind', () => {
    const task = projectTaskRecordToA2aTask10({
      taskId: 't1', runId: 't1', state: 'auth-required', interruptKind: 'credential',
      statusMessage: 'Authorize slack (chat:write): https://host.example/c/r/n', updatedAt: '2026-09-26T00:00:00Z',
    } as never);
    const status = task.status as { state: string; message?: { parts: { text: string }[] } };
    expect(status.state).toBe('TASK_STATE_AUTH_REQUIRED');
    expect(status.message?.parts[0]?.text).toContain('https://host.example/c/r/n');
    expect(task.metadata).toEqual({ openwop: { interrupt: { kind: 'credential' } } });
  });
});
