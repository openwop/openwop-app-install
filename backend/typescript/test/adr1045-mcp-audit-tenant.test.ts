/**
 * ADR 1045 D5 (CHAN-P6-4) — the MCP mount's version-refusal audit row is stamped with the tenant
 * the request's decisions are made in (`mcpCallerFor` → `tenantOf(req)`), not
 * `principal.tenants[0]`.
 *
 * The two differ for exactly one lane, and it is the one the conformance harness
 * and every operator integration use: a WILDCARD operator key
 * (`OPENWOP_API_KEYS=<token>:*`) has `principal.tenants = ['*']` and acts in
 * `default`. Before D5 a version refusal from that caller was written to an
 * audit chain named `*`, which no workspace's audit view reads. This drives the
 * real mount with that key and reads both chains.
 *
 * Sabotage-witnessed 2026-11-03: restoring `tenantId: principal.tenants[0] ??
 * 'unknown'` on the version-refusal row turns both assertions red (the row lands
 * in `*`, and `default` has none). Re-witnessed w86 (2026-11-05) by that edit and
 * by resolving `mcpCallerFor`'s tenant from `principal.tenants[0]`.
 *
 * Scope: only the version-refusal row is driven. The anonymous-refusal row
 * (also D5) is not covered here. The principal on the row is asserted only as
 * a real, non-wildcard id: its env-key format is not pinned (w86 ruling).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { listChain } from '../src/host/auditChainService.js';
import { AUDIT_KIND_MCP_DECIDED } from '../src/host/mcpAudit.js';

const OP = 'adr1045-mcp-operator-token';
const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_MCP_SERVER_ENABLED', 'OPENWOP_API_KEYS', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED'];
const saved: Record<string, string | undefined> = {};
let server: http.Server;
let BASE = '';

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = `${OP}:*`;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const refusals = async (tenantId: string) =>
  (await listChain(tenantId)).filter((e) => e.kind === AUDIT_KIND_MCP_DECIDED && e.payload['outcome'] === 'version_refused');

describe('ADR 1045 D5 — MCP audit rows carry the resolved tenant', () => {
  it('a wildcard operator key\'s version refusal is audited in `default`, never in `*`', async () => {
    const before = (await refusals('default')).length;
    const r = await fetch(`${BASE}/host/openwop-app/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OP}`, 'content-type': 'application/json', 'MCP-Protocol-Version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(r.status).toBe(400);
    const body = await r.json() as { error?: { code?: number; data?: { requested?: string } } };
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.requested).toBe('1999-01-01');

    const rows = await refusals('default');
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1]!.payload;
    expect(row['direction']).toBe('inbound');
    expect(row['method']).toBe('tools/list');
    expect(row['reason']).toBe('unsupported_revision');
    expect(typeof row['principal']).toBe('string');
    expect(row['principal']).not.toBe('');
    expect(row['principal']).not.toBe('*');
    expect(await refusals('*')).toEqual([]);
  });
});
