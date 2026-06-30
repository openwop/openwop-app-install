/**
 * Workflow-chain templates — list + "Use template" (ADR 0163 Phase 2).
 *
 * GET /workflow-chains lists installed RFC 0013 chains; POST /workflows/from-chain
 * expands one into a fresh, owned, editable workflow (appears in the caller's
 * tenant-scoped list). Unresolved node typeIds surface as warnings, not failures
 * (R6). Each instantiation mints a distinct workflowId (R2, non-idempotent).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const url = (p: string) => `http://127.0.0.1:${PORT}/v1/host/openwop-app${p}`;

async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

describe('workflow-chain templates (ADR 0163 Phase 2)', () => {
  it('GET /workflow-chains lists the installed market-intel chain', async () => {
    const r = await fetch(url('/workflow-chains'), { headers: { cookie: await cookie() } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { chains: { chainId: string; label: string; parameters: unknown }[] };
    const mi = body.chains.find((c) => c.chainId === 'market-intel.digest');
    expect(mi, 'market-intel.digest should be installed').toBeTruthy();
    expect(mi!.label.length).toBeGreaterThan(0);
    expect(mi!.parameters).toBeTruthy(); // the param schema (topic required)
  });

  it('POST /workflows/from-chain instantiates a fresh owned workflow that appears in the scoped list', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'AI ops tooling' } }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { workflowId: string; nodeCount: number; warnings?: string[] };
    expect(body.workflowId).toMatch(/^wf\.market-intel-digest\.[0-9a-f]{8}$/);
    expect(body.nodeCount).toBe(4);
    // the workflow now appears in the caller's tenant-scoped list (a real owned workflow)
    const list = (await (await fetch(url('/workflows'), { headers: { cookie: c } })).json()) as { workflows: { workflowId: string }[] };
    expect(list.workflows.map((w) => w.workflowId)).toContain(body.workflowId);
    // R6 — instantiate SUCCEEDS regardless of node availability (invitation, not
    // breakage); `warnings` is omitted when every typeId resolves (as here, the
    // market-intel node packs are present) or a string[] of unresolved typeIds.
    expect(body.warnings === undefined || Array.isArray(body.warnings)).toBe(true);
  });

  it('missing required param → 400; unknown chainId → 404', async () => {
    const c = await cookie();
    const noParam = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: {} }),
    });
    expect(noParam.status).toBe(400); // chain_parameter_invalid (topic required)
    const unknown = await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'nope.missing', params: { topic: 'x' } }),
    });
    expect(unknown.status).toBe(404);
  });

  it('each instantiation mints a distinct workflowId (non-idempotent "use template")', async () => {
    const c = await cookie();
    const mk = async () => ((await (await fetch(url('/workflows/from-chain'), {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'same topic' } }),
    })).json()) as { workflowId: string }).workflowId;
    const [a, b] = [await mk(), await mk()];
    expect(a).not.toBe(b);
  });
});
