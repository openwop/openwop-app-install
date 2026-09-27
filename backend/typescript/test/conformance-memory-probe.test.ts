/**
 * H49 — the `config.memoryAction` seam, driven end-to-end through a real run.
 *
 * WHY THIS FILE EXISTS AT ALL. The five corpus scenarios are not, by themselves,
 * sufficient evidence that this seam works. H49 MEASURED each one against a
 * deliberately sabotaged probe rather than reasoning about them:
 *
 *   | scenario                          | pass-through host | `memoryList: []` |
 *   |-----------------------------------|-------------------|------------------|
 *   | agentMemoryRoundTrip              | RED               | —                |
 *   | agentMemoryRedactionContract      | RED               | —                |
 *   | memory-injection-budget           | RED               | —                |
 *   | agentMemoryTtlExpiry              | RED               | **GREEN**        |
 *   | agentMemoryCrossTenantIsolation   | **GREEN**         | GREEN            |
 *
 *   - `agentMemoryCrossTenantIsolation` is vacuous OUTRIGHT: it falls through to
 *     `expect(probe).toBeFalsy()` and `undefined` is falsy, so a host that
 *     surfaces nothing at all passes it.
 *   - `agentMemoryTtlExpiry` is vacuous NARROWLY: it does
 *     `expect(Array.isArray(memoryList)).toBe(true)` and then loops, so an unset
 *     variable fails but an EMPTY ARRAY passes — which is exactly what an
 *     over-aggressive TTL filter, or a write that silently did nothing, would
 *     produce.
 *
 * So this file carries the halves the corpus cannot express: for TTL, that the
 * fresh entry is PRESENT as well as the expired one absent; for CTI-1, a
 * positive control proving the foreign row really existed before its absence on
 * the caller side means anything.
 *
 * @see src/bootstrap/conformanceMemoryProbe.ts
 * @see spec/v1/agent-memory.md §CTI-1, §SR-1, §"TTL semantics", §"Injection budget"
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { MEMORY_PROBE_ACTIONS } from '../src/bootstrap/conformanceMemoryProbe.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // The SR-1 legs need the host-provisioned BYOK canary, which `src/index.ts`
  // only writes under the test seam.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
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
  // The canary is provisioned in a floating promise at boot; give it a tick.
  await new Promise((r) => setTimeout(r, 250));
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface RunSnapshot {
  status?: string;
  variables?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** Register + run a one-node `core.identity` workflow carrying `config`, and
 *  return the terminal snapshot. The node config is what the corpus fixtures
 *  carry; using the SAME typeId + config shape is the point. */
async function runProbe(
  workflowId: string,
  config: Record<string, unknown>,
  agent?: Record<string, unknown>,
): Promise<RunSnapshot> {
  const reg = await jsonFetch('/v1/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({
      workflowId,
      nodes: [{ nodeId: 'probe', typeId: 'core.identity', config, ...(agent ? { agent } : {}) }],
      edges: [],
    }),
  });
  expect([200, 201], `register ${workflowId}`).toContain(reg.status);

  const create = await jsonFetch<{ runId: string }>('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs: {} }),
  });
  expect(create.status, `create run for ${workflowId}`).toBe(201);

  let snap: RunSnapshot = {};
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    snap = (await jsonFetch<RunSnapshot>(`/v1/runs/${create.body.runId}`)).body;
    if (['completed', 'failed', 'cancelled'].includes(snap.status ?? '')) break;
  }
  return snap;
}

// ── the seam is wired at all ────────────────────────────────────────────────

describe('memoryAction seam — non-vacuity of the seam itself', () => {
  it('the handler map is non-empty and covers every action the vendored fixtures name', async () => {
    // Derived from the FIXTURE TREE, not from a literal list — a newly vendored
    // memory fixture is covered the day it lands. This is the assertion that
    // would have caught H48's bare-prefix hole one layer up.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), '..', '..', 'conformance-fixtures');
    const declared = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const nodes = (parsed as { nodes?: unknown }).nodes;
      if (!Array.isArray(nodes)) continue;
      for (const n of nodes) {
        const cfg = (n as { config?: Record<string, unknown> }).config;
        const action = cfg?.['memoryAction'];
        if (typeof action === 'string') declared.add(action);
      }
    }
    expect(declared.size, 'the vendored tree MUST declare memoryActions, else this whole gate is vacuous').toBeGreaterThanOrEqual(5);
    const missing = [...declared].filter((a) => !MEMORY_PROBE_ACTIONS.has(a)).sort();
    expect(missing, 'every memoryAction the vendored fixtures name MUST have a handler').toEqual([]);
  });

  it('an UNKNOWN memoryAction is a typed failure, never a silent pass-through', async () => {
    // The whole defect class in one assertion: a `core.identity` node that the
    // host cannot meaningfully execute MUST NOT reach `completed`.
    const snap = await runProbe('h49.unknown-action', { memoryAction: 'no-such-action' });
    expect(snap.status).toBe('failed');
  });
});

// ── TTL: the half the corpus scenario cannot check ──────────────────────────

describe('ttl-probe — §"TTL semantics" (non-vacuous)', () => {
  it('surfaces the FRESH entry and omits the expired one — an empty list is NOT a pass', async () => {
    const snap = await runProbe('h49.ttl', { memoryAction: 'ttl-probe' }, {
      agentId: 'core.conformance.ttl-agent',
      memoryRef: 'conformance/h49-ttl',
    });
    expect(snap.status, JSON.stringify(snap.error ?? {})).toBe('completed');

    const listed = snap.variables?.['memoryList'];
    expect(Array.isArray(listed)).toBe(true);
    const rows = listed as Array<{ id?: string; expiresAt?: string }>;

    // Suite 1.136.1 (corpus S35) landed `freshId` / `expiredId` so the list can
    // be checked on BOTH sides. Assert exactly those names — this file and the
    // corpus scenario must agree on the contract, not merely both be green.
    const freshId = snap.variables?.['freshId'];
    const expiredId = snap.variables?.['expiredId'];
    expect(typeof freshId === 'string' && freshId.length > 0, 'the host MUST land freshId').toBe(true);
    expect(typeof expiredId === 'string' && expiredId.length > 0, 'the host MUST land expiredId').toBe(true);
    expect(freshId).not.toBe(expiredId);

    // THE assertion that was missing before S35. Without it, `[]` passes.
    expect(rows.length, 'an empty list would have satisfied the pre-S35 scenario while proving nothing').toBeGreaterThan(0);
    expect(
      rows.some((r) => r.id === freshId),
      'the future-dated entry MUST surface — otherwise "no expired entries" is true only because nothing surfaced',
    ).toBe(true);
    expect(
      rows.some((r) => r.id === expiredId),
      'the past-dated entry MUST NOT surface',
    ).toBe(false);
    // And the original predicate holds too.
    for (const r of rows) {
      if (r.expiresAt) expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
  });
});

// ── CTI-1: the positive control the corpus scenario cannot express ──────────

describe('cross-tenant-probe — CTI-1 (non-vacuous, two independent positive controls)', () => {
  it('lands ownerEntryId / ownerProbe / crossTenantProbe exactly as fixture v1.1 requires', async () => {
    const snap = await runProbe('h49.cross-tenant', {
      memoryAction: 'cross-tenant-probe',
      probeMemoryRef: 'conformance/another-tenant/agent-memory',
    }, {
      agentId: 'core.conformance.cti-agent',
      memoryRef: 'conformance/h49-cti',
    });
    expect(snap.status, JSON.stringify(snap.error ?? {})).toBe('completed');
    const v = snap.variables ?? {};

    // ── OWNER side (suite 1.136.1 / corpus S35) ─────────────────────────────
    // Proves the adapter is genuinely exercised, so an empty cross-tenant read
    // is not merely "this host's reads return nothing".
    const ownerEntryId = v['ownerEntryId'];
    expect(typeof ownerEntryId === 'string' && ownerEntryId.length > 0, 'ownerEntryId MUST be set').toBe(true);
    const ownerProbe = v['ownerProbe'];
    expect(Array.isArray(ownerProbe), 'ownerProbe MUST be an array').toBe(true);
    expect((ownerProbe as unknown[]).length, 'ownerProbe MUST be NON-EMPTY').toBeGreaterThan(0);
    expect(
      (ownerProbe as Array<{ id?: unknown }>).some((e) => e.id === ownerEntryId),
      'ownerProbe MUST contain the entry the host reports writing',
    ).toBe(true);

    // ── THE INVARIANT ───────────────────────────────────────────────────────
    // Pre-S35 the scenario passed on an UNSET variable. Require it set AND [].
    const probe = v['crossTenantProbe'];
    expect(probe, 'crossTenantProbe MUST be set — an unset variable proves nothing').toBeDefined();
    expect(Array.isArray(probe)).toBe(true);
    expect((probe as unknown[]).length).toBe(0);

    // ── FOREIGN side (this host's stronger control) ─────────────────────────
    // The corpus's owner control proves reads work; THIS proves the row the
    // caller must not see actually existed, so the empty read is a refusal
    // rather than an empty store.
    expect(
      v['foreignSeedVisibleToItsOwnTenant'],
      'the foreign row MUST have been readable by the tenant that owns it, else the empty cross-tenant read is unattributable',
    ).toBe(true);
  });
});

// ── SR-1 + RFC 0113 spot-checks (the corpus assertions here are real) ───────

describe('write-then-read + redaction-probe', () => {
  it('write-then-read surfaces a MemoryEntry-shaped readback resolved through the adapter', async () => {
    const snap = await runProbe('h49.roundtrip', { memoryAction: 'write-then-read' }, {
      agentId: 'core.conformance.memory-agent',
      memoryRef: 'conformance/h49-roundtrip',
      modelClass: 'chat',
    });
    expect(snap.status, JSON.stringify(snap.error ?? {})).toBe('completed');
    const rb = snap.variables?.['memoryReadback'] as Record<string, unknown> | undefined;
    expect(rb).toBeDefined();
    expect(typeof rb!['id']).toBe('string');
    expect(typeof rb!['content']).toBe('string');
    expect(Array.isArray(rb!['tags'])).toBe(true);
    expect(typeof rb!['createdAt']).toBe('string');
  });

  it('redaction-probe persists [REDACTED:<secretId>] and never the plaintext (SR-1)', async () => {
    const snap = await runProbe('h49.redaction', {
      memoryAction: 'redaction-probe',
      byokSecretId: 'conformance-test-secret',
    }, {
      agentId: 'core.conformance.byok-agent',
      memoryRef: 'conformance/h49-redaction',
    });
    expect(snap.status, JSON.stringify(snap.error ?? {})).toBe('completed');
    const rb = snap.variables?.['memoryReadback'] as { content?: string } | undefined;
    expect(rb?.content).toMatch(/\[REDACTED:[^\]]+\]/);
    // The canary's literal prefix must not survive anywhere in the persisted
    // content — the marker being present is necessary but not sufficient.
    expect(rb!.content!).not.toContain('canary-value-CANARY-openwop');
  });
});

describe('list-budgeted — RFC 0113 (non-vacuous)', () => {
  it('bounds the slice, omits the lone over-budget entry, and re-asserts SR-1 + CTI-1', async () => {
    const budget = 800;
    const snap = await runProbe('h49.budget', {
      memoryAction: 'list-budgeted',
      tokenBudget: budget,
      rank: 'recency',
    }, {
      agentId: 'core.conformance.memory-agent',
      memoryRef: 'conformance/h49-budget',
      modelClass: 'chat',
    });
    expect(snap.status, JSON.stringify(snap.error ?? {})).toBe('completed');
    const v = snap.variables ?? {};

    expect(v['tokenBudget']).toBe(budget);
    expect(v['tokenCounter']).toBe('chars');
    const total = v['budgetedTokenTotal'];
    expect(typeof total).toBe('number');
    expect(total as number).toBeLessThanOrEqual(budget);
    // Non-vacuity: an EMPTY slice would also satisfy "≤ budget".
    const entries = v['budgetedEntries'];
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as unknown[]).length, 'an empty slice satisfies the budget vacuously').toBeGreaterThan(0);

    expect(v['overBudgetEntryOmitted']).toBe(true);
    const overId = v['overBudgetEntryId'];
    expect(typeof overId).toBe('string');
    expect((entries as Array<{ id?: string }>).map((e) => e.id)).not.toContain(overId);

    expect(v['redactedContentSample']).toMatch(/\[REDACTED:[^\]]+\]/);
    expect(Array.isArray(v['crossTenantBudgetedProbe'])).toBe(true);
    expect((v['crossTenantBudgetedProbe'] as unknown[]).length).toBe(0);

    // RFC 0113 clause 3 — this host does NOT advertise `memory.search` semantic,
    // so it MUST NOT fabricate a relevance ranking. Absent, not empty, not echoed.
    expect(v['relevanceOrder'], 'a host without memory.search semantic MUST NOT surface a relevance ordering').toBeUndefined();
  });
});
