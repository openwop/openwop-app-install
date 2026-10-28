/**
 * host.webResearch + host.launchStudio — the last two vendor surfaces
 * (FEATURES "vendor surfaces"; ADR 0101 web research, ADR 0056 launch studio).
 *
 * webResearch: fetchBatch really fetches (against a mock HTTP server) and
 * extracts title + readable text; search returns an honest demo result;
 * research composes the two. launchStudio: getStudio returns the seeded studio
 * (null for unknown ids); buildProjectContext/resolveLinkedArtifacts derive
 * context; a launch-studio.linkStep node runs end-to-end (ctx.variables +
 * ctx.userId wired) and reports success.
 *
 * NO PUBLIC NETWORK (grade-tests wave 63): keyless `research()` composes the
 * demo search (a `duckduckgo.com` URL) with a real fetch. That fetch is answered
 * at the product's own seam — `ssrfGuardedFetch` dials undici's `fetch` — by a
 * passthrough mock that stubs ONLY the demo host and records the request; every
 * loopback fetch (the page server below) still goes through the real undici.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';

const demoFetches = vi.hoisted(() => [] as string[]);
vi.mock('undici', async (importActual) => {
  const real = await importActual<typeof import('undici')>();
  return {
    ...real,
    fetch: async (input: Parameters<typeof real.fetch>[0], init?: Parameters<typeof real.fetch>[1]) => {
      const url = String(input);
      if (new URL(url).hostname === 'duckduckgo.com') {
        demoFetches.push(url);
        return new real.Response('<html><head><title>Demo SERP</title></head><body><p>stubbed demo page</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return real.fetch(input, init);
    },
  };
});

let server: http.Server;
let mock: http.Server;
let mockUrl: string;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  // web-research egress is now SSRF-guarded (denies loopback/private by
  // default); the mock page server below is on 127.0.0.1, so opt into
  // private egress for the test — same flag the webhook-egress tests use.
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  mock = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Test Page</title></head><body><script>ignore()</script><p>Hello readable world.</p></body></html>');
  });
  await new Promise<void>((res) => mock.listen(0, '127.0.0.1', res));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => mock.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as T };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

async function runNode(workflowId: string, typeId: string, config: Record<string, unknown>, inputs: Record<string, unknown>): Promise<Record<string, unknown> & { __variables?: Record<string, unknown> | null }> {
  await jsonFetch('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'op', typeId, config }], edges: [] }) });
  const create = await jsonFetch<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs, tenantId: 'default' }) });
  expect(create.status).toBe(201);
  const { runId } = create.body;
  let status = 'pending';
  let variables: Record<string, unknown> | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const snap = await jsonFetch<{ status: string; variables?: Record<string, unknown> | null }>(`/runs/${encodeURIComponent(runId)}`);
    status = snap.body.status;
    variables = snap.body.variables ?? null;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/runs/${encodeURIComponent(runId)}/debug-bundle`);
  const ev = (bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'op');
  return { __status: status, __variables: variables, ...((ev?.payload?.outputs as Record<string, unknown>) ?? {}) };
}

describe('host.webResearch', () => {
  it('fetchUrls node really fetches + extracts title and readable text', async () => {
    const out = await runNode('wr.fetch', 'data.transform.fetchUrls', {}, { urls: [mockUrl] });
    expect(out.__status).toBe('completed');
    const pages = out.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(1);
    expect(pages[0]!.status).toBe(200);
    expect(pages[0]!.title).toBe('Test Page');
    expect(String(pages[0]!.extractedText)).toContain('Hello readable world.');
    expect(String(pages[0]!.extractedText)).not.toContain('ignore()'); // script stripped
  });

  it('search returns an honest demo result; research composes search + fetch', async () => {
    const wr = buildHostSurfaceBundle({ tenantId: 'default' }).webResearch;
    const s = await wr.search({ query: 'openwop protocol' });
    expect(s.engine).toBe('demo');
    expect(s.results[0]!.url).toContain('duckduckgo.com');
    const r = await wr.research({ query: 'openwop protocol', maxResults: 1 });
    expect(r.citations).toHaveLength(1);
    // research fetched the demo result's OWN url (stubbed at the undici seam)…
    expect(demoFetches).toEqual([s.results[0]!.url]);
    // …and the citation carries what that page said, not an empty placeholder.
    expect(r.citations[0]!.url).toBe(s.results[0]!.url);
    expect(r.citations[0]!.title).toBe('Demo SERP');
    expect(r.citations[0]!.content).toBe('Demo SERP stubbed demo page');
  });
});

describe('host.launchStudio', () => {
  const ls = () => buildHostSurfaceBundle({ tenantId: 'default' }).launchStudio;

  it('getStudio returns the seeded studio and null for unknown ids', async () => {
    const studio = await ls().getStudio('demo-launch-studio');
    expect(studio).not.toBeNull();
    expect(studio!.steps.length).toBe(3);
    expect(await ls().getStudio('does-not-exist')).toBeNull();
  });

  it('buildProjectContext + resolveLinkedArtifacts derive context', async () => {
    const studio = (await ls().getStudio('demo-launch-studio'))!;
    const ctx = await ls().buildProjectContext({ studio, userId: 'u1', canvasTypeId: 'canvas.design' });
    expect(ctx.brandId).toBe('brand-acme');
    expect(ctx.userId).toBe('u1');
    const art = await ls().resolveLinkedArtifacts({ studio, sourceCanvasTypeId: 'canvas.design' });
    expect((art.sharedArtifacts as unknown[]).length).toBe(2);
    // canvas.design is step 2 → one inherited prior step (canvas.brief).
    expect((art.inheritedSteps as unknown[]).length).toBe(1);
  });

  it('linkStep node runs end-to-end (ctx.variables + ctx.userId wired)', async () => {
    const out = await runNode('ls.link', 'launch-studio.linkStep', {}, {
      studioId: 'demo-launch-studio', stepId: 'step-brief', projectId: 'proj-1', canvasTypeId: 'canvas.brief',
    });
    expect(out.__status).toBe('completed');
    expect(out.success).toBe(true);
    expect(out.studioId).toBe('demo-launch-studio');
    // ctx.variables is wired: the node wrote its step bindings into the run bag…
    const vars = out.__variables ?? {};
    expect(vars['step-brief_projectId']).toBe('proj-1');
    expect(vars['brandId']).toBe('brand-acme');
    // …and ctx.userId reached buildProjectContext (it is echoed into the context).
    const projectContext = vars['step-brief_projectContext'] as { userId?: unknown } | undefined;
    expect(typeof projectContext?.userId, 'ctx.userId must be wired into the project context').toBe('string');
  });
});
