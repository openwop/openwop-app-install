/**
 * ADR 0755 D1/D3 — the ADR 0745 residual: an `owk_` key's DECLARED scopes now hold
 * on every surface `scopes_supported` names, not only runs/artifacts.
 *
 *   D1  webhooks + trigger subscriptions → `webhooks:manage`; trigger ingest →
 *       `runs:create`; prompts → `prompts:read`/`prompts:write`; annotations →
 *       `runs:annotate` (POST) / `runs:read` (GET). Each refusal carries the
 *       RFC 0200 `insufficient_scope` challenge; each has a CONTROL key holding the
 *       scope that is not refused (without it a host refusing every key passes).
 *   D3  a `runs:read` key reads a waiting run but NOT its interrupt resume token —
 *       the token is the authority `POST /v1/interrupts/{token}` accepts, and it
 *       needs `approvals:respond`. Before this ADR the read-only key resolved the
 *       gate end to end (WIT-AUTH-1); the last leg drives exactly that path.
 *
 * Default posture (RFC 0049 membership enforcement OFF) throughout: key narrowing
 * is unconditional, so it must hold here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { keyDeclarationPermits } from '../src/host/protocolAuthorization.js';

const TENANT = 'adr0755-scopes';
let server: http.Server;
let storage: Storage;
let BASE = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0755-scopes', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function key(scopes: string[]): Promise<string> {
  const { token } = await issueApiKey({ tenantId: TENANT, name: 'adr0755', createdBy: 'user:adr0755', scopes });
  return token;
}

function call(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function challengeScope(res: Response): string[] {
  const h = res.headers.get('www-authenticate') ?? '';
  expect(h, 'a scope 403 carries the RFC 0200 challenge').toMatch(/error="insufficient_scope"/);
  return (/scope="([^"]*)"/.exec(h)?.[1] ?? '').split(' ');
}

// [label, method, path, body, required scope]
const GATES: Array<[string, string, string, unknown, string]> = [
  ['webhook list', 'GET', '/v1/webhooks', undefined, 'webhooks:manage'],
  ['webhook register', 'POST', '/v1/webhooks', { url: 'https://example.com/hook', events: ['run.completed'] }, 'webhooks:manage'],
  ['webhook rotate', 'POST', '/v1/webhooks/no-such/rotate-secret', {}, 'webhooks:manage'],
  ['webhook delete', 'DELETE', '/v1/webhooks/no-such', undefined, 'webhooks:manage'],
  ['trigger-subscription list', 'GET', '/v1/trigger-subscriptions', undefined, 'webhooks:manage'],
  ['trigger-subscription register', 'POST', '/v1/trigger-subscriptions', { source: 'webhook', workflowId: 'openwop-app.uppercase' }, 'webhooks:manage'],
  ['trigger ingest', 'POST', '/v1/trigger-subscriptions/no-such/ingest', {}, 'runs:create'],
  ['prompt list', 'GET', '/v1/prompts', undefined, 'prompts:read'],
  ['prompt create', 'POST', '/v1/prompts', {}, 'prompts:write'],
  ['annotation create', 'POST', '/v1/runs/no-such/annotations', { signal: { kind: 'flag' } }, 'runs:annotate'],
  ['annotation list', 'GET', '/v1/runs/no-such/annotations', undefined, 'runs:read'],
];

describe('ADR 0755 D1 — every advertised scope refuses a key that did not declare it', () => {
  it.each(GATES)('%s: a key without the scope is 403 insufficient_scope naming it', async (_l, method, path, body, scope) => {
    // A key holding some OTHER real scope — narrowed, not undeclared.
    const other = scope === 'runs:read' ? 'artifacts:read' : 'runs:read';
    const res = await call(method, path, await key([other]), body);
    expect(res.status, `${method} ${path}`).toBe(403);
    expect(challengeScope(res)).toEqual([scope]);
  });

  it.each(GATES)('%s: CONTROL — a key holding the scope is not refused for scope', async (_l, method, path, body, scope) => {
    const res = await call(method, path, await key([scope]), body);
    // Past the gate the request fails or succeeds on its own merits (404 unknown
    // id, 400 body, 501 capability…) — but never a scope 403.
    expect(res.status === 403 && /insufficient_scope/.test(res.headers.get('www-authenticate') ?? ''), `${method} ${path} → ${res.status}`).toBe(false);
  });
});

describe('ADR 0755 D2 — one reading of a key declaration, shared with the MCP lane', () => {
  it('undeclared and `*` permit; a declared list permits exactly its members', () => {
    expect(keyDeclarationPermits([], 'runs:create')).toBe(true);
    expect(keyDeclarationPermits(['*'], 'webhooks:manage')).toBe(true);
    expect(keyDeclarationPermits(['runs:read'], 'runs:read')).toBe(true);
    expect(keyDeclarationPermits(['runs:read'], 'approvals:respond')).toBe(false);
  });
});

describe('ADR 0755 D3 — a runs:read key reads the gate but cannot get its resume token', () => {
  let seq = 0;
  async function waitingRun(): Promise<{ run: RunRecord; interrupt: InterruptRecord }> {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-adr0755-${++seq}-${Math.random().toString(36).slice(2)}`,
      workflowId: 'wf-adr0755',
      tenantId: TENANT,
      status: 'waiting-approval',
      inputs: {},
      metadata: {},
      configurable: {},
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertRun(run);
    const interrupt: InterruptRecord = {
      interruptId: `int-adr0755-${seq}`,
      runId: run.runId,
      nodeId: 'gate',
      kind: 'approval',
      token: `tok-adr0755-${seq}-${Math.random().toString(36).slice(2)}`,
      data: { prompt: 'ship?' },
      createdAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await storage.insertInterrupt(interrupt);
    return { run, interrupt };
  }

  it('the run snapshot omits interruptToken + callbackUrl for runs:read, and carries them for approvals:respond', async () => {
    const { run, interrupt } = await waitingRun();
    const read = await call('GET', `/v1/runs/${run.runId}`, await key(['runs:read']));
    expect(read.status).toBe(200);
    const snap = (await read.json()) as { interrupt?: Record<string, unknown> };
    expect(snap.interrupt?.['nodeId'], 'the gate itself stays visible to a reader').toBe('gate');
    expect(snap.interrupt?.['interruptToken']).toBeUndefined();
    expect(snap.interrupt?.['callbackUrl']).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain(interrupt.token);

    const control = await call('GET', `/v1/runs/${run.runId}`, await key(['runs:read', 'approvals:respond']));
    const cs = (await control.json()) as { interrupt?: Record<string, unknown> };
    expect(cs.interrupt?.['interruptToken'], 'CONTROL: a responder still gets the handle').toBe(interrupt.token);
  });

  it('the host-extension interrupt list omits `token` for runs:read, and carries it for approvals:respond', async () => {
    const { run, interrupt } = await waitingRun();
    const path = `/v1/host/openwop-app/runs/${run.runId}/interrupts`;
    const read = (await (await call('GET', path, await key(['runs:read']))).json()) as { interrupts: Array<Record<string, unknown>> };
    expect(read.interrupts).toHaveLength(1);
    expect(read.interrupts[0]!['token']).toBeUndefined();
    const control = (await (await call('GET', path, await key(['runs:read', 'approvals:respond']))).json()) as { interrupts: Array<Record<string, unknown>> };
    expect(control.interrupts[0]!['token']).toBe(interrupt.token);
  });

  it('end to end: nothing a runs:read key can read lets it resolve the gate', async () => {
    const { run } = await waitingRun();
    const k = await key(['runs:read']);
    const body = JSON.stringify(await (await call('GET', `/v1/runs/${run.runId}`, k)).json())
      + JSON.stringify(await (await call('GET', `/v1/host/openwop-app/runs/${run.runId}/interrupts`, k)).json());
    expect(body).not.toMatch(/tok-adr0755-/);
    expect(await storage.getInterruptByNode(run.runId, 'gate'), 'the gate is still open').toBeTruthy();
  });
});
