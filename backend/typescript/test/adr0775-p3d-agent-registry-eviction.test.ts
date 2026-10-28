/**
 * ADR 0775 P3d (D5 H2) — a user agent deleted or edited on one instance is
 * dropped from every OTHER instance's in-process registry, so those instances
 * re-read storage instead of serving the old agent until they restart.
 *
 * One process stands in for the fleet: storage pub/sub is the same channel
 * either way (an in-process emitter here, LISTEN/NOTIFY on Postgres), and a
 * message with a different `origin` is exactly what a peer instance sends.
 *
 * Red when (wave 60 probes, tracker TST-BRC-4): `applyAgentEviction` drops its own
 * origin filter or stops removing; the booted listener stops applying; PATCH, DELETE
 * or the roster cascade stops broadcasting; the TTL never expires a copy; a storage
 * fault during the TTL refresh unregisters the copy.
 *
 * Double guard, recorded: a tenant-less message is refused by the shape check AND
 * by `remove(agentId, undefined)`, which finds no user agent without its tenant, so
 * dropping the shape check alone stays green (w60g2-p3d-tenant-required).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry, setAgentPackResolver } from '../src/executor/agentRegistry.js';
import { ensureAgentPackResolverInstalled } from '../src/bootstrap/agentPackResolver.js';
import type { Storage } from '../src/storage/storage.js';
import { publishHostExtEvent, subscribeHostExtEvent } from '../src/host/hostExtPersistence.js';
import { AGENT_EVICTION_CHANNEL, INSTANCE_ID, applyAgentEviction } from '../src/host/agentRegistryEviction.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';

let server: http.Server;
let BASE: string;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'p3d', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const stale = (agentId: string, tenant: string): ResolvedAgentManifest => ({
  agentId, persona: 'stale copy', modelClass: 'chat', systemPrompt: 'OLD PROMPT', packName: `user:${tenant}`, packVersion: '0',
  toolAllowlist: [], ownerTenant: tenant,
});

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 50 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe('applying a peer\'s eviction', () => {
  it('a peer\'s message drops the agent; this instance\'s own message and malformed ones do not', () => {
    const reg = getAgentRegistry();
    reg.register(stale('user.p3d-unit', 't-p3d'));
    expect(applyAgentEviction(JSON.stringify({ tenantId: 't-p3d', agentId: 'user.p3d-unit', origin: INSTANCE_ID }))).toBe(false);
    expect(applyAgentEviction('not json')).toBe(false);
    expect(applyAgentEviction(JSON.stringify({ agentId: 'user.p3d-unit', origin: 'peer' }))).toBe(false);
    expect(reg.get('user.p3d-unit', 't-p3d')).not.toBeNull();
    expect(applyAgentEviction(JSON.stringify({ tenantId: 't-p3d', agentId: 'user.p3d-unit', origin: 'peer' }))).toBe(true);
    expect(reg.get('user.p3d-unit', 't-p3d')).toBeNull();
  });
});

describe('the fleet', () => {
  async function createAgent(): Promise<{ agentId: string; tenantId: string }> {
    const r = await call('POST', '/host/openwop-app/agents', { persona: `p3d-${Date.now()}`, modelClass: 'chat', systemPrompt: 'v1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { agentId: r.body.agentId as string, tenantId: (r.body.packName as string).slice('user:'.length) };
  }

  it('the booted listener drops an agent a PEER deleted, and the next resolve reads storage', async () => {
    const { agentId, tenantId } = await createAgent();
    const reg = getAgentRegistry();
    reg.register(stale(agentId, tenantId)); // this instance's out-of-date copy
    await publishHostExtEvent(AGENT_EVICTION_CHANNEL, JSON.stringify({ tenantId, agentId, origin: 'peer-instance' }));
    await until(() => reg.get(agentId, tenantId) === null);
    expect(reg.get(agentId, tenantId)).toBeNull();
    // A miss re-reads storage: the agent still exists there, so it comes back CURRENT.
    expect((await reg.resolve(agentId, tenantId))?.systemPrompt).toBe('v1');
  });

  it('DELETE and PATCH broadcast the agent to the other instances', async () => {
    const seen: string[] = [];
    const unsubscribe = await subscribeHostExtEvent(AGENT_EVICTION_CHANNEL, (p) => { seen.push(p); });
    try {
      const { agentId, tenantId } = await createAgent();
      expect((await call('PATCH', `/host/openwop-app/agents/${encodeURIComponent(agentId)}`, { systemPrompt: 'v2' })).status).toBe(200);
      expect((await call('DELETE', `/host/openwop-app/agents/${encodeURIComponent(agentId)}`)).status).toBe(204);
      await until(() => seen.length >= 2);
      const mine = seen.map((p) => JSON.parse(p) as { tenantId: string; agentId: string; origin: string }).filter((m) => m.agentId === agentId);
      expect(mine).toHaveLength(2);
      expect(mine.every((m) => m.tenantId === tenantId && m.origin === INSTANCE_ID)).toBe(true);
    } finally {
      await unsubscribe();
    }
  });

  it('removing the roster member that owns a user agent broadcasts it too (the cascade)', async () => {
    const seen: string[] = [];
    const unsubscribe = await subscribeHostExtEvent(AGENT_EVICTION_CHANNEL, (p) => { seen.push(p); });
    try {
      const { agentId } = await createAgent();
      const member = await call('POST', '/host/openwop-app/roster', { persona: `p3d member ${Date.now()}`, agentRef: { agentId } });
      expect(member.status, JSON.stringify(member.body)).toBe(201);
      const del = await call('DELETE', `/host/openwop-app/roster/${encodeURIComponent(member.body.rosterId as string)}`);
      expect(del.status).toBeLessThan(300);
      await until(() => seen.some((p) => p.includes(agentId)));
      expect(seen.some((p) => (JSON.parse(p) as { agentId: string }).agentId === agentId)).toBe(true);
    } finally {
      await unsubscribe();
    }
  });
});

describe('the TTL backstop for a MISSED message', () => {
  const SIX_MIN = 6 * 60_000;
  let ttlSeq = 0;
  async function createAgent(): Promise<{ agentId: string; tenantId: string }> {
    // Two calls can land in the same millisecond, and a persona name must be unique per
    // workspace (409 idempotency_key_conflict), so the name carries a per-call counter too.
    const r = await call('POST', '/host/openwop-app/agents', { persona: `p3d-ttl-${Date.now()}-${++ttlSeq}`, modelClass: 'chat', systemPrompt: 'current' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { agentId: r.body.agentId as string, tenantId: (r.body.packName as string).slice('user:'.length) };
  }

  it('a copy past the TTL is re-read on resolve: edited → the stored record, deleted → gone', async () => {
    const reg = getAgentRegistry();
    const kept = await createAgent();
    const gone = await createAgent();
    reg.register(stale(kept.agentId, kept.tenantId));
    reg.register(stale(gone.agentId, gone.tenantId));
    await storage.deleteUserAgent(gone.tenantId, gone.agentId); // deleted elsewhere, message missed
    // Inside the TTL the stale copy is still served (the eviction message is the fast path).
    expect((await reg.resolve(kept.agentId, kept.tenantId))?.systemPrompt).toBe('OLD PROMPT');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + SIX_MIN);
      expect((await reg.resolve(kept.agentId, kept.tenantId))?.systemPrompt).toBe('current');
      expect(await reg.resolve(gone.agentId, gone.tenantId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a storage FAULT during the refresh keeps the copy instead of unregistering it', async () => {
    const reg = getAgentRegistry();
    const a = await createAgent();
    reg.register(stale(a.agentId, a.tenantId));
    setAgentPackResolver(async () => { throw new Error('db down'); });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + SIX_MIN);
      expect((await reg.resolve(a.agentId, a.tenantId))?.systemPrompt).toBe('OLD PROMPT');
    } finally {
      vi.useRealTimers();
      ensureAgentPackResolverInstalled(storage);
    }
  });
});

