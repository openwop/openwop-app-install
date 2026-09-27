/**
 * Memory ledger read-side (RFC 0004 / app-ux §A3).
 *
 * Verifies the host-extension GET /v1/host/openwop-app/memory returns the
 * run-summary the executor writes on completion, tenant-scoped from the
 * caller's principal (not the query) per CTI-1.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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

async function jsonFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}
interface MemoryListBody {
  memoryRef: string;
  entries: MemoryEntry[];
}

describe('memory ledger read-side', () => {
  it('requires auth', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/memory`);
    expect(res.status).toBe(401);
  });

  it('returns the run-summary the host writes on completion', async () => {
    // Omit body.tenantId so the run resolves the same tenant the memory GET
    // does (`req.tenantId ?? 'default'`) — the api-key principal is wildcard,
    // so both land on 'default' and the ledger read sees the run's write.
    const create = await jsonFetch<{ runId: string; status: string }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'openwop-app.uppercase',
        inputs: { text: 'remember me' },
      }),
    });
    expect(create.status).toBe(201);
    const { runId } = create.body;

    // Poll for terminal status (the run-summary is written on completion).
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const snap = await jsonFetch<{ status: string }>(`/v1/runs/${runId}`);
      if (['completed', 'failed', 'cancelled'].includes(snap.body.status)) break;
    }

    const mem = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory');
    expect(mem.status).toBe(200);
    expect(mem.body.memoryRef).toBe('tenant-memory');
    const mine = mem.body.entries.filter((e) => e.tags.includes(`run-id:${runId}`));
    expect(mine.length).toBe(1);
    expect(mine[0]!.tags).toContain('run-summary');
    expect(mine[0]!.content).toContain(runId);
  });

  it('filters by tag', async () => {
    const mem = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory?tag=run-summary');
    expect(mem.status).toBe(200);
    for (const e of mem.body.entries) expect(e.tags).toContain('run-summary');
  });

  it('deletes a tenant-scoped entry (demo DELETE route)', async () => {
    // Grab an existing entry, delete it, and confirm it's gone.
    const before = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory');
    expect(before.body.entries.length).toBeGreaterThan(0);
    const target = before.body.entries[0]!;

    const del = await jsonFetch<{ memoryRef: string; memoryId: string; removed: boolean }>(
      `/v1/host/openwop-app/memory/${target.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
    expect(del.body.memoryId).toBe(target.id);

    const after = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory');
    expect(after.body.entries.find((e) => e.id === target.id)).toBeUndefined();
  });

  it('returns 404 deleting a missing entry', async () => {
    const del = await jsonFetch<{ error: string }>('/v1/host/openwop-app/memory/mem_does_not_exist', {
      method: 'DELETE',
    });
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('not_found');
  });

  it('requires auth to delete', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/memory/whatever`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

/**
 * AGMEM-1 (ADR 0587 §5) — SUBJECT authorization, not just tenant authorization.
 *
 * WHY THESE DID NOT EXIST. The suite above covers auth, the default ref, tag
 * filtering and delete — and NEVER passes a foreign `memoryRef` at all, so it
 * would have passed either way. The route's docblock said "tenant-scoped … never
 * the query" — true about the TENANT, silent about the SUBJECT — and the SPA
 * client repeated the reassurance. `subjectScope` is the totally-predictable
 * `${kind}:${id}`, so any authenticated tenant member could read or DELETE any
 * person's or any agent's memory by guessing an id.
 *
 * VERIFIED BY RUNNING THEM AGAINST THE PRE-FIX ROUTE: every case below returned
 * 200 before `assertMemoryRefAccess` was wired in.
 */
describe('AGMEM-1 — a foreign memoryRef is refused', () => {
  it('a foreign `user:` scope is 404, not a read of that person\'s memory', async () => {
    const res = await jsonFetch<{ error?: string }>('/v1/host/openwop-app/memory?memoryRef=user:someone-else');
    expect(res.status).toBe(404);
  });

  it('DELETE against a foreign `user:` scope is refused BEFORE the store is touched', async () => {
    // NON-VACUITY: a 404 on a MISSING entry proves nothing — the pre-fix route
    // 404'd here too, for the wrong reason. So seed a REAL row in the victim's
    // scope first (the app runs in-process, so this is the same store the route
    // reads) and assert both the refusal AND that the row survived.
    const { writeMemoryEntry, listMemoryEntries } = await import('../src/host/inMemorySurfaces.js');
    const row = await writeMemoryEntry('default', 'user:someone-else', { content: 'victim private fact', tags: [] });

    const res = await jsonFetch<{ error?: string }>(`/v1/host/openwop-app/memory/${row.id}?memoryRef=user:someone-else`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect(await listMemoryEntries('default', 'user:someone-else')).toHaveLength(1);
  });

  it('an `agent:` scope for a non-existent agent is 404 (no existence leak)', async () => {
    const res = await jsonFetch<{ error?: string }>('/v1/host/openwop-app/memory?memoryRef=agent:no-such-agent');
    expect(res.status).toBe(404);
  });

  it('an arbitrary non-demo namespace is refused', async () => {
    const res = await jsonFetch<{ error?: string }>('/v1/host/openwop-app/memory?memoryRef=project:some-project');
    expect(res.status).toBe(404);
  });

  it('the single-entry GET is gated too (the third handler, not just the two obvious ones)', async () => {
    // Same non-vacuity concern: seed a real row so a pass cannot come from absence.
    const { writeMemoryEntry } = await import('../src/host/inMemorySurfaces.js');
    const row = await writeMemoryEntry('default', 'user:someone-else-2', { content: 'victim private fact', tags: [] });
    const res = await jsonFetch<{ error?: string; entry?: { content: string } }>(
      `/v1/host/openwop-app/memory/${row.id}?memoryRef=user:someone-else-2`,
    );
    expect(res.status).toBe(404);
    expect(res.body.entry).toBeUndefined();
  });

  it('ANTI-ROT: the tenant\'s OWN demo namespace still reads 200 — this is not "refuse everything"', async () => {
    const explicit = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory?memoryRef=tenant-memory');
    expect(explicit.status).toBe(200);
    const defaulted = await jsonFetch<MemoryListBody>('/v1/host/openwop-app/memory');
    expect(defaulted.status).toBe(200);
  });
});

/**
 * F3(c) (review of ADR 0587 §5) — the SUCCESS path, which the six cases above do
 * not witness.
 *
 * Every AGMEM-1 case asserts a REFUSAL, plus one demo-namespace 200. A gate that
 * refused every `user:` and every `agent:` ref unconditionally would pass all of
 * them. That is not hypothetical: the first cut of `assertMemoryRefAccess` called
 * `resolveEffectiveAccess(tenantId, { subject })` for the `agent:` arm, under
 * which the wildcard operator principal this whole suite authenticates as has no
 * member row and therefore no scopes — so a legitimate `agent:` read 403'd with
 * `Missing required scope: workspace:read`, a scope it can never obtain. A gate
 * with no exit, shipped invisibly because nothing asserted an allow.
 *
 * This file witnesses the WILDCARD-OPERATOR exit (`principal.tenants` includes
 * `*` — what `Bearer dev-token` resolves to). The personal-workspace exit and the
 * caller's-own-`user:` allow need a real signed-in cookie session, which this
 * suite disables; they live in `test/memory-ref-access-allow.test.ts`. Two exits,
 * two harnesses, because one harness cannot produce both principals.
 */
describe('F3(c) — the legitimate `agent:` read a wildcard operator must still get', () => {
  it('is 200, with the row it asked for — not a 403 on an unobtainable scope', async () => {
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const { writeMemoryEntry } = await import('../src/host/inMemorySurfaces.js');
    // `createRosterEntry` mints a DETERMINISTIC `host:<slug>` id from the persona
    // (ADR 0379 P2) — take the id it returns rather than reconstructing the slug.
    const entry = await createRosterEntry({
      tenantId: 'default',
      persona: 'F3c Memory Reader',
      agentRef: { agentId: 'core.openwop.agents/assistant' },
    });
    // Seed a row so a 200 cannot come from an empty list the gate never reached.
    await writeMemoryEntry('default', `agent:${entry.rosterId}`, { content: 'agent private fact', tags: [] });

    const res = await jsonFetch<MemoryListBody>(
      `/v1/host/openwop-app/memory?memoryRef=agent:${encodeURIComponent(entry.rosterId)}`,
    );
    expect(res.status, 'a legitimate agent read must not 403 on a scope it can never obtain').toBe(200);
    expect(res.body.entries.map((e) => e.content)).toContain('agent private fact');
  });
});
