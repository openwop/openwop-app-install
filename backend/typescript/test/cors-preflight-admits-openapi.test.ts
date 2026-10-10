/**
 * `openwop.requirement.headers.cors-preflight-admits` (openwop#1763, suite
 * 2.45.0): a host that grants an origin in preflight MUST admit the operation's
 * method, every request header the OpenAPI declares for that operation, and
 * `Authorization` + `Content-Type`.
 *
 * Derived from the pinned `@openwop/spec-artifacts` OpenAPI of BOTH served
 * majors, so the next spec header reds this test on the pin bump rather than a
 * certify cut. Three arms:
 *   1. every operation's preflight, through the real app, admits its method and
 *      declared headers (the leg's own shape);
 *   2. the generated half equals what the pinned spec declares (drift);
 *   3. the served list is exactly HOST ∪ SPEC — never a reflected request list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { createApp } from '../src/index.js';
import { ALLOWED_REQUEST_HEADERS, HOST_REQUEST_HEADERS } from '../src/middleware/cors.js';
import { SPEC_REQUEST_HEADERS } from '../src/middleware/corsRequestHeaders.generated.js';

const ORIGIN = 'https://spa.example';
const require = createRequire(import.meta.url);
const ARTIFACTS = dirname(require.resolve('@openwop/spec-artifacts/package.json'));
const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

type Param = { in?: string; name?: string; $ref?: string };
type Op = { major: 1 | 2; operationId?: string; method: string; path: string; headers: string[] };
function operations(major: 1 | 2, rel: string): Op[] {
  const doc = parse(readFileSync(join(ARTIFACTS, rel), 'utf8')) as { paths: Record<string, Record<string, { operationId?: string; parameters?: Param[] }> & { parameters?: Param[] }> };
  const deref = (p: Param): Param => (p.$ref
    ? p.$ref.slice(2).split('/').reduce<Record<string, unknown>>((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')] as Record<string, unknown>, doc as unknown as Record<string, unknown>) as Param
    : p);
  const out: Op[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const headers = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref).filter((p) => p.in === 'header').map((p) => p.name!);
      out.push({ major, ...(op.operationId ? { operationId: op.operationId } : {}), method: m.toUpperCase(), path: path.replace(/\{[^}]+\}/g, 'x'), headers });
    }
  }
  return out;
}
const OPS = [...operations(1, 'api/openapi.yaml'), ...operations(2, 'api/v2/openapi.yaml')];
const lower = (xs: readonly string[]) => new Set(xs.map((h) => h.toLowerCase()));

let server: http.Server;
let BASE = '';
let prevOrigins: string | undefined;
beforeAll(async () => {
  prevOrigins = process.env.OPENWOP_CORS_ORIGINS;
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (prevOrigins === undefined) delete process.env.OPENWOP_CORS_ORIGINS;
  else process.env.OPENWOP_CORS_ORIGINS = prevOrigins;
});

describe('cors-preflight-admits — the preflight admits what the OpenAPI declares', () => {
  it('fixture guard: the pinned OpenAPI has operations with declared headers', () => {
    expect(OPS.length).toBeGreaterThan(50);
    expect(OPS.filter((o) => o.headers.length > 0).length).toBeGreaterThan(20);
  });

  it('every operation\'s preflight admits its method, its declared headers, Authorization and Content-Type', async () => {
    const refused: string[] = [];
    // ADR 0812 — the major-1 operations (`/v1/…`) are no longer served once v1
    // retires, so only the served major's operations are preflighted. The v1 half
    // still feeds the drift leg below (the generated list is derived from both specs).
    for (const op of OPS.filter((o) => o.major === 2)) {
      const want = [...op.headers, 'Authorization', 'Content-Type'];
      const res = await fetch(`${BASE}${op.path}`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': op.method, 'access-control-request-headers': want.join(',').toLowerCase() },
      });
      if (res.headers.get('access-control-allow-origin') !== ORIGIN) { refused.push(`${op.method} ${op.path}: origin not granted`); continue; }
      const methods = lower((res.headers.get('access-control-allow-methods') ?? '').split(',').map((s) => s.trim()));
      if (!methods.has(op.method.toLowerCase())) refused.push(`${op.method} ${op.path}: method`);
      const admitted = lower((res.headers.get('access-control-allow-headers') ?? '').split(',').map((s) => s.trim()));
      for (const h of want) if (!admitted.has(h.toLowerCase())) refused.push(`${op.method} ${op.path}: ${h}`);
    }
    expect(refused, 'a granted preflight refused a declared method/header (blocked in the browser, no server trace)').toEqual([]);
  });

  it('the generated half equals every header the pinned OpenAPI declares (re-run gen-cors-request-headers.mjs)', () => {
    const declared = [...new Set(OPS.flatMap((o) => o.headers))].sort((a, b) => a.localeCompare(b));
    expect([...SPEC_REQUEST_HEADERS]).toEqual(declared);
  });

  it('the served list is exactly HOST ∪ SPEC, never the reflected request list', async () => {
    const res = await fetch(`${BASE}/runs`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-hostile-header' },
    });
    const served = lower((res.headers.get('access-control-allow-headers') ?? '').split(',').map((s) => s.trim()));
    expect(served.has('x-hostile-header'), 'the preflight reflected an arbitrary requested header').toBe(false);
    expect([...served].sort()).toEqual([...lower([...HOST_REQUEST_HEADERS, ...SPEC_REQUEST_HEADERS])].sort());
    expect([...served].sort()).toEqual([...lower(ALLOWED_REQUEST_HEADERS)].sort());
  });

  // The four major-2 operations the 2.45.0 leg failed against the hand list
  // (close-front-page's measurement: 4 of 55). Named so a regression names the
  // op. Safelisted headers count too: the rule is "every declared header".
  it.each([
    ['getCapabilities', 'If-None-Match'],
    ['getRun', 'If-None-Match'],
    ['createRun', 'OpenWOP-Force-Engine-Version'],
    ['getContentPage', 'Accept-Language'],
  ])('v2 %s: the preflight admits its declared %s', async (operationId, header) => {
    const op = OPS.find((o) => o.major === 2 && o.operationId === operationId);
    expect(op, `${operationId} is not in the pinned v2 OpenAPI`).toBeDefined();
    expect(op!.headers, `the pinned spec no longer declares ${header} on ${operationId}`).toContain(header);
    const res = await fetch(`${BASE}${op!.path}`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': op!.method, 'access-control-request-headers': header.toLowerCase() },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const admitted = lower((res.headers.get('access-control-allow-headers') ?? '').split(',').map((x) => x.trim()));
    expect(admitted.has(header.toLowerCase()), `${op!.method} ${op!.path} (${operationId}) refuses ${header}`).toBe(true);
  });

  it('keeps the SDK-sent headers #4204 admitted', () => {
    const allowed = lower(ALLOWED_REQUEST_HEADERS);
    for (const h of ['OpenWOP-Client-Version', 'OpenWOP-Dedup', 'OpenWOP-Version', 'Accept-Language']) expect(allowed.has(h.toLowerCase()), h).toBe(true);
  });
});
