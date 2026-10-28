/**
 * Sample-extension user-authored agents route tests (phase E1 fixes,
 * 2026-05-28).
 *
 * Covers the validate / conflict / cross-tenant gates for
 *   POST   /host/openwop-app/agents
 *   DELETE /host/openwop-app/agents/{agentId}
 *
 * Also exercises:
 *   - Idempotency-Key replay (#5) — same key + same body → cached
 *     201 with `openwop-Idempotent-Replay: true` marker
 *   - Cross-tenant agent isolation (#1) — `GET /v1/agents` filters
 *     user-authored agents to the requesting tenant
 *   - vendor.openwop-app.agent.routed event namespacing (#3) is
 *     covered by the chat-responder; not exercised here
 *
 * "Cross-tenant" here means the wildcard dev-token's explicit `?tenantId=`
 * inventory/dispatch filter (`tenantForInventory`), which is the filter the
 * routes really apply; no second principal is involved.
 *
 * DOUBLE GUARDS, named so a vacuous single probe reads as expected:
 *  - DELETE 404: `storage.getUserAgent(tenant, id)` null → 404 first; the
 *    `removed ? 204 : 404` tail is a second copy.
 *  - dispatch gate: `resolveAgentForTenant` = a tenant-keyed registry resolve
 *    AND `agentVisibleToTenant` (round-1 probe ua-resolve-vis: vacuous on the
 *    visibility half alone). The route-level `if (!gateAgent)` is pinned by the
 *    exact `error: 'not_found'` (the fall-through answers `agent_not_found`).
 * Sabotage witnesses (grade-tests w63): drop the dispatch gate → the AGENTRT-2
 * case red; visibility `return true` → the tenant-filter case red; a no-op
 * delete → the DELETE case red (read-back below).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { loadUserAgentsIntoRegistry } from '../src/routes/userAgents.js';
import type { UserAgentRecord } from '../src/types.js';

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

interface RawResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<RawResponse<T>> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as T };
}

/** DELETE answers 204 with no body on success, a JSON envelope otherwise. */
async function del(path: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  if (res.status === 204) return { status: 204 };
  return { status: res.status, error: ((await res.json()) as { error?: string }).error };
}

async function personasListed(persona: string): Promise<string[]> {
  const r = await jsonFetch<{ agents: Array<{ agentId: string; persona: string }> }>('/agents');
  expect(r.status).toBe(200);
  return r.body.agents.filter((a) => a.persona === persona).map((a) => a.agentId);
}

interface AgentEntry {
  agentId: string;
  persona: string;
  modelClass: string;
  packName: string;
}

describe('user-authored agents — POST /host/openwop-app/agents', () => {
  it('creates a valid agent and returns the projected record', async () => {
    const r = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Test Reviewer',
        description: 'Reviews diffs for correctness.',
        modelClass: 'coding',
        systemPrompt: 'You are a senior reviewer.',
        toolAllowlist: ['openwop:core.files.read'],
        memoryShape: { scratchpad: true },
        confidenceThreshold: 0.65,
      }),
    });
    expect(r.status).toBe(201);
    expect(r.body.persona).toBe('Test Reviewer');
    expect(r.body.modelClass).toBe('coding');
    // packName carries the synthetic `user:<tenant>` prefix per phase E1.
    expect(r.body.packName).toMatch(/^user:/);
    // agentId shape: `user.<persona-slug>` — persona-scoped since ADR 0379 P2
    // (the tenant lives in the ROW, not the id).
    expect(r.body.agentId).toMatch(/^user\.test-reviewer$/);
  });

  it('rejects missing persona (400)', async () => {
    const r = await jsonFetch<{ message: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        modelClass: 'chat',
        systemPrompt: 'You are helpful.',
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/persona/);
  });

  it('rejects unknown modelClass (400)', async () => {
    const r = await jsonFetch<{ message: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Bad',
        modelClass: 'made-up',
        systemPrompt: 'You are helpful.',
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/modelClass/);
  });

  it('rejects out-of-range confidenceThreshold (400)', async () => {
    const r = await jsonFetch<{ message: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Confident',
        modelClass: 'chat',
        systemPrompt: 'You are helpful.',
        confidenceThreshold: 1.5,
      }),
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/confidenceThreshold/);
  });

  it('returns 409 on duplicate persona', async () => {
    // First create succeeds.
    const r1 = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Dupe Test',
        modelClass: 'chat',
        systemPrompt: 'You are helpful.',
      }),
    });
    expect(r1.status).toBe(201);
    // Second create with the same persona → 409.
    const r2 = await jsonFetch<{ message: string }>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Dupe Test',
        modelClass: 'chat',
        systemPrompt: 'You are also helpful.',
      }),
    });
    expect(r2.status).toBe(409);
    expect(r2.body.message).toMatch(/already exists/);
  });

  it('Idempotency-Key replay returns cached body with marker header', async () => {
    const body = JSON.stringify({
      persona: 'Idem Test',
      modelClass: 'chat',
      systemPrompt: 'You are helpful.',
    });
    const r1 = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-test-key-1' },
      body,
    });
    expect(r1.status).toBe(201);
    const r2 = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-test-key-1' },
      body,
    });
    expect(r2.status).toBe(201);
    expect(r2.headers.get('openwop-Idempotent-Replay')).toBe('true');
    expect(r2.body.agentId).toBe(r1.body.agentId);
    // The replay wrote nothing: exactly ONE agent carries this persona.
    expect(await personasListed('Idem Test')).toEqual([r1.body.agentId]);
  });

  it('Idempotency-Key with mismatched body returns 409', async () => {
    await jsonFetch('/host/openwop-app/agents', {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-mismatch-key' },
      body: JSON.stringify({
        persona: 'Mismatch Test A',
        modelClass: 'chat',
        systemPrompt: 'You are helpful.',
      }),
    });
    const r2 = await jsonFetch<{ message: string }>('/host/openwop-app/agents', {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-mismatch-key' },
      body: JSON.stringify({
        persona: 'Mismatch Test B',
        modelClass: 'chat',
        systemPrompt: 'You are helpful.',
      }),
    });
    expect(r2.status).toBe(409);
    expect(r2.body.message).toMatch(/different request body/);
  });
});

describe('user-authored agents — DELETE /host/openwop-app/agents/{agentId}', () => {
  it('deletes a user-authored agent and returns 204', async () => {
    const created = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Delete Me',
        modelClass: 'chat',
        systemPrompt: 'Short-lived.',
      }),
    });
    expect(created.status).toBe(201);
    expect(await personasListed('Delete Me')).toEqual([created.body.agentId]);
    const path = `/host/openwop-app/agents/${encodeURIComponent(created.body.agentId)}`;
    expect((await del(path)).status).toBe(204);
    // Read back: the agent is GONE from the inventory, and a second delete is a
    // 404 — a 204 that removed nothing would leave it listed.
    expect(await personasListed('Delete Me')).toEqual([]);
    expect(await del(path)).toEqual({ status: 404, error: 'not_found' });
  });

  it('returns 404 for a non-existent agentId', async () => {
    expect(await del('/host/openwop-app/agents/user.default.does-not-exist')).toEqual({ status: 404, error: 'not_found' });
  });

  it('returns 404 for a pack-installed agentId', async () => {
    // Pack agents register in the AgentRegistry but have no row in
    // `user_agents` — the DELETE route gates on the storage row, so
    // it 404s rather than mistakenly removing a pack agent.
    expect(await del('/host/openwop-app/agents/core.openwop.agents.code-reviewer.default')).toEqual({ status: 404, error: 'not_found' });
  });
});

describe('user-authored agents — cross-tenant isolation in GET /v1/agents', () => {
  it('user-authored agents projected through GET /v1/agents', async () => {
    // Create an agent (lands under the bearer-shared default tenant).
    await jsonFetch('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Inventory Probe',
        modelClass: 'chat',
        systemPrompt: 'You appear in /v1/agents.',
      }),
    });
    // GET /v1/agents should include the user-authored row.
    const r = await jsonFetch<{ agents: Array<{ persona: string; packName: string }> }>(
      '/agents',
    );
    expect(r.status).toBe(200);
    const userAgent = r.body.agents.find((a) => a.persona === 'Inventory Probe');
    expect(userAgent).toBeDefined();
    expect(userAgent!.packName).toMatch(/^user:/);
  });

  it('does not expose user-authored agents across explicit tenant filters', async () => {
    await jsonFetch('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Tenant Scoped Probe',
        modelClass: 'chat',
        systemPrompt: 'You only appear in your tenant.',
      }),
    });

    const other = await jsonFetch<{ agents: Array<{ persona: string }> }>('/agents?tenantId=someone-else');
    expect(other.status).toBe(200);
    expect(other.body.agents.some((a) => a.persona === 'Tenant Scoped Probe')).toBe(false);

    const wildcard = await jsonFetch<{ agents: Array<{ persona: string }> }>('/agents?tenantId=*');
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.agents.some((a) => a.persona === 'Tenant Scoped Probe')).toBe(true);
  });
});

// AGENTRT-2 (CTI-1): the GET-by-id routes hide cross-tenant user agents, but the
// DISPATCH route must ALSO refuse to INVOKE another tenant's private agent by id
// — otherwise its manifest (system prompt, tool allowlist) is reachable cross-
// tenant. The refusal uses the same 404 as "absent" so existence never leaks.
describe('user-authored agents — cross-tenant dispatch gate (AGENTRT-2)', () => {
  it('refuses to dispatch another tenant\'s agent by id (404), but the owner can', async () => {
    const created = await jsonFetch<AgentEntry>('/host/openwop-app/agents', {
      method: 'POST',
      body: JSON.stringify({
        persona: 'Dispatch Gate Probe',
        modelClass: 'chat',
        systemPrompt: 'Private manifest — only my tenant may invoke me.',
      }),
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agentId;
    const dispatchBody = JSON.stringify({ task: {}, validateHandoff: false });

    // A different explicit tenant must NOT be able to invoke it — 404, same
    // message as an absent agent (no cross-tenant existence leak).
    const crossTenant = await jsonFetch<{ error: string }>(
      `/host/openwop-app/agents/${agentId}/dispatch?tenantId=someone-else`,
      { method: 'POST', body: dispatchBody },
    );
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error).toBe('not_found');

    // The owning tenant (bearer-shared default) CAN dispatch it.
    const owner = await jsonFetch<{ agentId: string; persona: string; status: string }>(
      `/host/openwop-app/agents/${agentId}/dispatch`,
      { method: 'POST', body: dispatchBody },
    );
    expect(owner.status).toBe(200);
    // It dispatched THIS agent (the deterministic seam echoes its identity).
    expect(owner.body.agentId).toBe(agentId);
    expect(owner.body.persona).toBe('Dispatch Gate Probe');
  });
});

describe('legacy `_anon` tenant migration — loadUserAgentsIntoRegistry', () => {
  it('rewrites a stored `_anon` record to the `default` tenant at boot (idempotent)', async () => {
    // Records created by bearer callers BEFORE the bearer-shared posture
    // rename were bucketed under `_anon`; without the boot migration they
    // orphan (invisible to the `default`-scoped list, undeletable). Uses an
    // isolated storage instance — this is the boot path, not the HTTP surface.
    const storage = await openStorage('memory://');
    try {
      const legacy: UserAgentRecord = {
        agentId: 'user._anon.legacy-probe',
        tenantId: '_anon',
        persona: 'Legacy Probe',
        modelClass: 'chat',
        systemPrompt: 'You predate the bearer-shared posture.',
        toolAllowlist: [],
        memoryShape: { scratchpad: true, conversation: true, longTerm: false },
        createdAt: new Date().toISOString(),
      };
      await storage.insertUserAgent(legacy);

      await loadUserAgentsIntoRegistry(storage);

      // Durable rewrite: tenant moves, the immutable agentId keeps its
      // legacy `user._anon.` prefix.
      const migrated = await storage.getUserAgent('default', 'user._anon.legacy-probe');
      expect(migrated?.tenantId).toBe('default');
      expect((await storage.listUserAgents('default')).some((r) => r.agentId === 'user._anon.legacy-probe')).toBe(true);
      expect((await storage.listUserAgents('_anon')).length).toBe(0);

      // Second boot: nothing left to migrate, registration still succeeds.
      await loadUserAgentsIntoRegistry(storage);
      expect((await storage.getUserAgent('default', 'user._anon.legacy-probe'))?.tenantId).toBe('default');
    } finally {
      await storage.close();
    }
  });
});
