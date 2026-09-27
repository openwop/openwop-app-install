/**
 * RFC 0170 errors.md + versioning.md §1.4 — A MALFORMED BODY IS A 400 IN THE
 * ENVELOPE, WITH THE VERSION HEADER, UNDER BOTH MAJORS.
 *
 * MEASURED 2026-09-05 (corpus steward, crosstalk `32ad`; rc.40 scenario
 * `v2-malformed-body-envelope`): `POST /runs` with body `{` on this host's
 * production service → `500 internal_error`, no `OpenWOP-Version`. Express's
 * JSON parsers were mounted BEFORE the negotiator, so the parse error left the
 * chain before the version header existed and before any envelope mapping
 * knew what `entity.parse.failed` was. The peer host had the identical gap.
 *
 * Legs are disjoint: leg 1 fails without the mapping (500); leg 2 fails if the
 * header is set after the parsers (no version on the error); leg 3 guards the
 * v1 mount; leg 4 proves the handler does not swallow a good body; leg 5 is
 * the size polarity (413, not 400 — a different type, a different code).
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

async function post(path: string, raw: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: raw });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, ver: res.headers.get('openwop-version'), type: res.headers.get('content-type') ?? '', json, text };
}

describe('a malformed JSON body answers in the error envelope with the version header', () => {
  it('1. POST /runs `{` under major 2 → 400 validation_error, JSON', async () => {
    const r = await post('/runs', '{', { 'OpenWOP-Version': '2' });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect(r.type).toContain('application/json');
    expect(r.json?.error).toBe('validation_error');
  });
  it('2. …and the response names the contract it used (OpenWOP-Version: 2.0)', async () => {
    const r = await post('/runs', '{', { 'OpenWOP-Version': '2' });
    expect(r.ver).toBe('2.0');
  });
  it('3. the /v1 mount answers the same shape under 1.x', async () => {
    const r = await post('/v1/runs', '{');
    expect(r.status).toBe(400);
    expect(r.json?.error).toBe('validation_error');
    expect(r.ver).toMatch(/^1\./);
  });
  it('4. a well-formed body is untouched by the handler (201 on the same route)', async () => {
    const r = await post('/runs', JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }), { 'OpenWOP-Version': '2' });
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    expect(String(r.json?.runId)).toMatch(/^default\//);
  });
  it('5. an oversize body is 413 payload_too_large, not a 400 in disguise', async () => {
    const r = await post('/runs', JSON.stringify({ workflowId: 'conformance-noop', inputs: { pad: 'x'.repeat(3 * 1024 * 1024) } }), { 'OpenWOP-Version': '2' });
    expect(r.status, r.text.slice(0, 120)).toBe(413);
    // rc.43 REGISTERED `payload_too_large` (and `unsupported_media_type`) —
    // 96 codes — after both hosts had to invent them the same night. On rc.41
    // this asserted the host-prefixed `openwop-app.payload_too_large`, which was
    // the honest answer under the closed registry; on rc.43 the bare form IS
    // the registered code, so the negotiator's registry rule must emit it bare.
    // A prefixed answer now would be a vendor spelling of a protocol code.
    expect(r.json?.error).toBe('payload_too_large');
    expect(r.ver).toBe('2.0');
  });
});
