/**
 * ADR 0669 — the 2026-10-03 cut REHEARSAL (a 0%-traffic production revision
 * with OPENWOP_V1_RETIRED=true, certified at major 2 on suite 2.45.11) found
 * host defects that no pre-cut test could see, because each one only exists
 * once the flag is on:
 *
 *   1. `protocolVersion` stayed the v1 constant `1.1` while `preferredVersion`
 *      became `2.0` (`versioning.md` §1.1: on a single-major host they MUST be
 *      equal);
 *   2. `OpenWOP-Version: 1` on an unversioned path was silently served major 2
 *      instead of `406 protocol_version_unsupported` (§1.3: honoured or refused,
 *      never ignored) — the served-major set was the literal "1 or 2";
 *   3. a bare (unbound) run id in a major-2 path was still admitted (`200`)
 *      after the overlap, where `identity.md` §5 requires `400` — and a
 *      double-projected segment, which decodes to the same bare-looking form,
 *      answered `404` instead of `400`.
 *
 * Each leg was paired with its pre-cut control. ADR 0812 P3c removed the
 * pre-cut state (and `OPENWOP_V1_RETIRED`), so the controls went with it; leg 3
 * keeps a same-host control instead (the bound form IS served), so its 400
 * cannot pass for a reason unrelated to the id's form.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const AUTH = { Authorization: 'Bearer dev-token' };
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

describe('1. protocolVersion is preferredVersion\'s twin', () => {
  it('retired: 2.0 / 2.0, and preferredVersion is a member of protocolVersions[]', async () => {
    const d = (await get('/.well-known/openwop')).json;
    expect(d.protocolVersions).toEqual(['2.0']);
    expect(d.preferredVersion).toBe('2.0');
    expect(d.protocolVersion).toBe(d.preferredVersion);
  });
});

describe('2. OpenWOP-Version naming a major the host does not serve is refused 406', () => {
  it('retired: OpenWOP-Version: 1 is 406 protocol_version_unsupported, echoing protocolVersions[]', async () => {
    const r = await get('/.well-known/openwop', { 'OpenWOP-Version': '1' });
    expect(r.status).toBe(406);
    expect(r.json.error).toBe('protocol_version_unsupported');
    expect((r.json.details as { protocolVersions?: unknown } | undefined)?.protocolVersions).toEqual(['2.0']);
  });
  it('retired: OpenWOP-Version: 2 is still served', async () => {
    expect((await get('/.well-known/openwop', { 'OpenWOP-Version': '2' })).status).toBe(200);
  });
});

describe('3. a bare run id in a major-2 path is refused (the overlap is over)', () => {
  /** A run created over v2: its bound id `<tenant>/<opaque>` and the bare `<opaque>`. */
  async function createdRun(): Promise<{ bound: string; bare: string }> {
    const res = await fetch(`${base}/runs`, { method: 'POST', headers: { ...AUTH, 'OpenWOP-Version': '2', 'Content-Type': 'application/json' }, body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    expect(res.status).toBe(201);
    const bound = String(((await res.json()) as { runId: string }).runId);
    expect(bound).toContain('/');
    return { bound, bare: bound.slice(bound.lastIndexOf('/') + 1) };
  }
  it('control: the bound form of the same run is served', async () => {
    const { bound } = await createdRun();
    expect((await get(`/runs/${encodeURIComponent(bound)}`, { 'OpenWOP-Version': '2' })).status).toBe(200);
  });
  it('retired: the bare form is refused 400 validation_error', async () => {
    const { bare } = await createdRun();
    const r = await get(`/runs/${encodeURIComponent(bare)}`, { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('validation_error');
  });
  it('retired: a double-projected segment (decodes to the bare-looking form) is refused 400, not 404', async () => {
    const r = await get('/runs/conformance-prod~7E2Ff5cfaa43-65e2-4ac1-9f55-193e7b724c1a', { 'OpenWOP-Version': '2' });
    expect(r.status).toBe(400);
  });
});
