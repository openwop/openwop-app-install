/**
 * ADR 0775 P4 (`ARWF-11`) — the stale-write guards over HTTP: every agent-area
 * edit route returns its version as `ETag` (and `etag` in the body), honours
 * `If-Match` with `409 conflict` + `details.reason: 'stale_write'`, and the
 * profile PUT merges (an omitted field is kept; `null` or `[]` clears).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function call<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; etag: string | null; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, etag: res.headers.get('etag'), body: (await res.json()) as T };
}

async function rosterMember(persona: string): Promise<string> {
  const r = await call<{ rosterId: string }>('/host/openwop-app/roster', {
    method: 'POST',
    body: JSON.stringify({ persona, agentRef: { agentId: 'core.openwop.agents.brief-writer' } }),
  });
  expect(r.status).toBe(201);
  return r.body.rosterId;
}

describe('roster PATCH', () => {
  it('returns ETag + body etag, accepts a current If-Match, refuses a stale one', async () => {
    const id = await rosterMember('Etag Pat');
    const read = await call<{ etag: string }>(`/host/openwop-app/roster/${encodeURIComponent(id)}`);
    expect(read.etag).toBe(`"${read.body.etag}"`);

    const ok = await call<{ etag: string; label: string }>(`/host/openwop-app/roster/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ label: 'First' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.etag).not.toBe(read.body.etag);

    const stale = await call<{ details?: { reason?: string; currentEtag?: string } }>(`/host/openwop-app/roster/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'If-Match': read.etag! }, body: JSON.stringify({ label: 'Second' }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ reason: 'stale_write', currentEtag: ok.body.etag });
    const after = await call<{ label: string }>(`/host/openwop-app/roster/${encodeURIComponent(id)}`);
    expect(after.body.label).toBe('First');
  });

  it('lists carry each row\'s etag', async () => {
    await rosterMember('Etag List');
    const list = await call<{ roster: { etag?: string }[] }>('/host/openwop-app/roster');
    expect(list.body.roster.length).toBeGreaterThan(0);
    expect(list.body.roster.every((e) => typeof e.etag === 'string')).toBe(true);
  });
});

describe('agent profile PUT', () => {
  const base = { roleKey: 'custom', autonomy: { specLevel: 'draft-only' } };

  it('merges, clears with null / [], and honours If-Match', async () => {
    const id = encodeURIComponent(await rosterMember('Profile Pat'));
    const first = await call<{ etag: string }>(`/host/openwop-app/agents/${id}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ ...base, channels: { approval: 'slack' }, hitl: ['refund'], metrics: ['m'], escalation: { contacts: ['a'], triggers: ['b'] } }),
    });
    expect(first.status).toBe(200);
    expect(first.etag).toBe(`"${first.body.etag}"`);

    const second = await call<Record<string, unknown> & { etag: string }>(`/host/openwop-app/agents/${id}/profile`, {
      method: 'PUT',
      headers: { 'If-Match': first.etag! },
      body: JSON.stringify({ ...base, hitl: ['refund', 'delete'], metrics: [], escalation: null }),
    });
    expect(second.status).toBe(200);
    expect(second.body.channels).toEqual({ approval: 'slack' }); // omitted → kept
    expect(second.body.hitl).toEqual(['refund', 'delete']); // sent → replaced
    expect(second.body).not.toHaveProperty('metrics'); // [] → cleared
    expect(second.body).not.toHaveProperty('escalation'); // null → cleared

    const stale = await call<{ details?: { reason?: string } }>(`/host/openwop-app/agents/${id}/profile`, {
      method: 'PUT', headers: { 'If-Match': first.etag! }, body: JSON.stringify({ ...base, hitl: [] }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason).toBe('stale_write');
  });
});

describe('user-agent PATCH', () => {
  it('returns its version and refuses a stale If-Match', async () => {
    const created = await call<{ agentId: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({ persona: 'Etag Writer', modelClass: 'chat', systemPrompt: 'v1' }),
    });
    expect(created.status).toBe(201);
    const path = `/host/openwop-app/agents/${encodeURIComponent(created.body.agentId)}`;
    const a = await call<{ etag: string }>(path, { method: 'PATCH', body: JSON.stringify({ systemPrompt: 'v2' }) });
    expect(a.status).toBe(200);
    expect(a.etag).toBe(`"${a.body.etag}"`);
    const b = await call<{ etag: string }>(path, { method: 'PATCH', headers: { 'If-Match': a.etag! }, body: JSON.stringify({ systemPrompt: 'v3' }) });
    expect(b.status).toBe(200);
    const stale = await call<{ details?: { reason?: string } }>(path, { method: 'PATCH', headers: { 'If-Match': a.etag! }, body: JSON.stringify({ systemPrompt: 'v4' }) });
    expect(stale.status).toBe(409);
    expect(stale.body.details?.reason).toBe('stale_write');
  });
});
