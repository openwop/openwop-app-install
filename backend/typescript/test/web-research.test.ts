/**
 * Gap D-4 — core.openwop.web-search pack + openwop-app.web.research workflow.
 *
 * ADR 0101 / ADR 0190 Phase 5: `core.web.search` is the workflow leg of the
 * unified `host.webResearch` surface. Verifies:
 *   1. Through the real app (surface bundled, no search key configured) the
 *      node returns the surface's HONEST demo result — engine 'demo', a real
 *      search-engine query URL, never fabricated example.com content.
 *   2. The hardcoded `openwop-app.web.research` workflow runs end-to-end
 *      through search → summarize with no BYOK provider, reaching `completed`.
 *   3. The keyless demo result is deterministic across runs (replay safety —
 *      `exampleSearch` is pure per query).
 * The surface-ABSENT stub leg (engine 'stub', deterministic example.com
 * fixture) remains for bare-ctx conformance harnesses and is unreachable
 * through the app (inMemorySurfaces bundles webResearch into every run).
 *
 * `openwop-app.web.research` is a code-PINNED workflow (`host/index.ts`, one of
 * the ADR 0764 D6 pinned infrastructure ids), not the pattern to copy.
 *
 * Order-independent (8f W4): the one-node workflow is registered in beforeAll,
 * not by case 1. Network (round-2 ruling 7): every `fetch` the process makes is
 * recorded, and each case asserts none left 127.0.0.1 — the keyless leg must
 * never reach a real search provider.
 *
 * Witnessed: wre-engine, wre-nondeterministic, wre-snippet, wre-summarize-missing.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // Ensure the keyless (demo) leg: the test asserts honest-demo behavior.
  delete process.env.OPENWOP_WEBSEARCH_API_KEY;
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
  // Pass-through spy: records every URL the process fetches (the test's own
  // localhost calls and anything the product would send out).
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  });
  const reg = await jsonFetch('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({
      workflowId: 'openwop-app.web.search-only',
      nodes: [{ nodeId: 'search', typeId: 'core.web.search', config: { maxResults: 3 } }],
      edges: [],
      variables: [{ name: 'query', type: 'string', defaultValue: 'OpenWOP protocol' }],
    }),
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
});

const fetched: string[] = [];
const offHost = (): string[] => fetched.filter((u) => !u.startsWith('http://127.0.0.1:'));

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface RunSnap {
  status: string;
  variables?: Record<string, unknown>;
}
interface BundleBody {
  events?: { type?: string; nodeId?: string; payload?: Record<string, unknown> }[];
}

async function runToTerminal(workflowId: string, inputs: Record<string, unknown>): Promise<string> {
  const create = await jsonFetch<{ runId: string }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs }),
  });
  expect(create.status).toBe(201);
  const { runId } = create.body;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const snap = await jsonFetch<RunSnap>(`/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(snap.body.status)) return runId;
  }
  return runId;
}

describe('core.openwop.web-search — core.web.search node (unified on host.webResearch)', () => {
  it('runs as a one-node workflow and returns the honest keyless demo result', async () => {
    const runId = await runToTerminal('openwop-app.web.search-only', { query: 'OpenWOP protocol' });
    const snap = await jsonFetch<RunSnap>(`/runs/${runId}`);
    expect(snap.body.status).toBe('completed');

    const bundle = await jsonFetch<BundleBody>(`/runs/${runId}/debug-bundle`);
    const completed = (bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'search');
    expect(completed, 'search node should complete').toBeTruthy();
    const out = completed!.payload as Record<string, unknown>;
    // Output may be nested under an `outputs` envelope depending on event shape.
    const outputs = (out.outputs ?? out) as Record<string, unknown>;
    // No key configured → the surface's honest demo leg, never fabricated content.
    expect(outputs.engine).toBe('demo');
    expect(outputs.stub).toBeUndefined();
    expect(Array.isArray(outputs.results)).toBe(true);
    const results = outputs.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0]!;
    // A real search-engine query URL — not example.com fabrication.
    expect(String(first.url)).toContain('duckduckgo.com');
    expect(String(first.url)).not.toContain('example.com');
    expect(String(first.snippet ?? '')).toMatch(/configure a search provider/i);
    expect(offHost(), 'the keyless leg reached the network').toEqual([]);
  });

  it('is deterministic while keyless: the same query yields identical results across runs', async () => {
    const r1 = await runToTerminal('openwop-app.web.search-only', { query: 'determinism check' });
    const r2 = await runToTerminal('openwop-app.web.search-only', { query: 'determinism check' });
    const b1 = await jsonFetch<BundleBody>(`/runs/${r1}/debug-bundle`);
    const b2 = await jsonFetch<BundleBody>(`/runs/${r2}/debug-bundle`);
    const pick = (b: BundleBody) => {
      const ev = (b.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'search')!;
      const out = (ev.payload as Record<string, unknown>);
      return (out.outputs ?? out) as Record<string, unknown>;
    };
    expect(pick(b1.body).results).toEqual(pick(b2.body).results);
    expect(offHost(), 'the keyless leg reached the network').toEqual([]);
  });
});

describe('openwop-app.web.research workflow (gap D-4)', () => {
  it('runs search → summarize end-to-end with no BYOK provider', async () => {
    const runId = await runToTerminal('openwop-app.web.research', { query: 'workflow orchestration' });
    const snap = await jsonFetch<RunSnap>(`/runs/${runId}`);
    expect(snap.body.status, 'web-research sample should complete without a provider').toBe('completed');

    const bundle = await jsonFetch<BundleBody>(`/runs/${runId}/debug-bundle`);
    const events = bundle.body.events ?? [];
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'search')).toBe(true);
    expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'summarize')).toBe(true);
    expect(offHost(), 'the keyless leg reached the network').toEqual([]);
  });
});
