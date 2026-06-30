/**
 * RFC 0112 — Compact tool projection. Reference-host conformance for
 * `GET /v1/tools?view=compact` + `GET /v1/tools/{toolId}?view=compact` and the
 * `toolCatalog.compactView` advert. Rides the same MCP-catalog harness as
 * notebooks-mcp.test.ts (the notebook tools are the projected `mcp` source).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { compactInputSchema, toCompactDescriptor, type FullToolDescriptor } from '../src/host/compactToolDescriptor.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true'; // mount the catalog
  process.env.OPENWOP_TOOLCATALOG_COMPACTVIEW = 'true'; // RFC 0112 advert ON for this suite
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}
/** Authenticated owner with an org (mirrors notebooks-mcp.test.ts ownerWithOrg). */
async function owner(who: string): Promise<Client> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return c;
}

const DROPPED = ['auth', 'egress', 'approval', 'replayPolicy', 'outputSchema', 'costHint', 'latencyHint'];

describe('RFC 0112 — compactView advert', () => {
  it('advertises toolCatalog.compactView when enabled', async () => {
    const c = client();
    const disc = (await c.get('/.well-known/openwop')).body as { capabilities: { toolCatalog?: { compactView?: boolean; sources?: string[] } } };
    expect(disc.capabilities.toolCatalog?.compactView).toBe(true);
    expect(disc.capabilities.toolCatalog?.sources).toContain('mcp');
  });
});

describe('RFC 0112 — GET /v1/tools?view=compact', () => {
  it('returns { tools: CompactToolDescriptor[] } dropping non-compact fields; required fields present', async () => {
    const c = await owner('compact-list');
    const res = await c.get('/v1/tools?view=compact');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(false);
    const tools = res.body.tools as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    for (const d of tools) {
      expect(typeof d.toolId).toBe('string');
      expect(d.source).toBe('mcp');
      expect(['read', 'write']).toContain(d.safetyTier);
      for (const k of DROPPED) expect(d[k], `${k} must be dropped`).toBeUndefined();
      // any present inputSchema is the self-contained subset — no $ref/oneOf/etc.
      if (d.inputSchema) expect(JSON.stringify(d.inputSchema)).not.toMatch(/"\$ref"|"oneOf"|"allOf"|"anyOf"|"patternProperties"/);
    }
  });

  it('compact toolId set EQUALS the standard view for the same principal (RFC 0074)', async () => {
    const c = await owner('compact-parity');
    const std = (await c.get('/v1/tools')).body as Array<{ toolId: string }>;
    const cmp = (await c.get('/v1/tools?view=compact')).body.tools as Array<{ toolId: string }>;
    expect(new Set(cmp.map((d) => d.toolId))).toEqual(new Set(std.map((d) => d.toolId)));
  });

  it('serves a single compact descriptor by id (bare, not enveloped) and 404s unknown', async () => {
    const c = await owner('compact-byid');
    const one = await c.get('/v1/tools/mcp:notebook-search?view=compact');
    expect(one.status).toBe(200);
    expect(one.body.toolId).toBe('mcp:notebook-search');
    expect(one.body.tools).toBeUndefined(); // bare, not enveloped
    for (const k of DROPPED) expect(one.body[k]).toBeUndefined();
    const unknown = await c.get('/v1/tools/mcp:does-not-exist?view=compact');
    expect(unknown.status).toBe(404);
  });
});

describe('RFC 0112 — compactInputSchema / toCompactDescriptor unit', () => {
  it('keeps a self-contained object schema (annotations stripped)', () => {
    const out = compactInputSchema({ $schema: 'x', title: 'T', type: 'object', properties: { a: { type: 'string', description: 'keep' } }, required: ['a'] });
    expect(out).toEqual({ type: 'object', properties: { a: { type: 'string', description: 'keep' } }, required: ['a'] });
  });
  it('OMITS a schema that uses $ref/oneOf (not losslessly representable in the subset)', () => {
    expect(compactInputSchema({ type: 'object', properties: { a: { $ref: '#/$defs/x' } }, $defs: { x: { type: 'string' } } })).toBeUndefined();
    expect(compactInputSchema({ type: 'object', properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } } })).toBeUndefined();
    expect(compactInputSchema({ type: 'string' })).toBeUndefined(); // not a top-level object
  });
  it('toCompactDescriptor drops fields + omits an irreducible inputSchema', () => {
    const full: FullToolDescriptor = {
      toolId: 'mcp:x', source: 'mcp', safetyTier: 'write', title: 'X', description: 'd',
      auth: { scopes: ['workspace:write'] }, egress: 'none', approval: 'always', replayPolicy: 'idempotent',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/y' } } },
    };
    expect(toCompactDescriptor(full)).toEqual({ toolId: 'mcp:x', source: 'mcp', safetyTier: 'write', title: 'X', description: 'd' });
  });
});
