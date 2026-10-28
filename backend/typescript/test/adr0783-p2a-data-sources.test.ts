/**
 * ADR 0783 phase 2a — `ctx.dataIntegration.fetchRest` / `fetchGraphql` over a
 * Connection acting as a data source. One describe per decision, each written so
 * removing its mechanism fails it:
 *   D1 the base URL is validated at write (route) AND at call time;
 *   D2 every "not usable by this run" is the SAME `source_unavailable`;
 *   D3 a workspace Connection is pinnable;
 *   D4 a request path cannot leave the base;
 *   D5/D6 `Link` pagination: aggregated, confined per hop, capped, fail-closed;
 *   D7 writes go through the egress ledger: sent once, a retry never repeats one;
 *   D8 GraphQL: subscriptions refused, mutations ledgered, `200 + errors` passed through;
 *   and the executor wires all of it onto a real run.
 * The broker is REAL (loopback provider, `OPENWOP_WEBHOOK_ALLOW_PRIVATE`, as in
 * `connector-invoker.test.ts`); only the provider's server is a stub.
 * Tracker: TST-BDI-6..14.
 *
 * Red when (sabotage-witnessed, wave 60): the base rule stops refusing
 * credentials, dot segments or off-pin hosts; a placeholder value is not encoded
 * or may be a dot segment; the first `rel` no longer wins; the base is not
 * re-validated at call time; the page, byte or wall-clock cap, the array check or
 * the per-hop confinement goes; pages are aggregated by argument spreading; a GET
 * may carry a body; the ledger stops refusing a duplicate, releasing a failed
 * write, keeping bodies out, or requiring a key; a read-only provider takes a
 * write or a mutation; a subscription is sent; a mutation skips the ledger; a
 * type-system definition rides beside an operation; `200 + errors` loses its
 * errors; the data-source route skips `workspace:write` or the base rule; a
 * re-consent drops the data source; the pack's idempotency key stops being
 * stable; the executor withholds the connector broker.
 *
 * Double guards (each named so a single-guard probe is read correctly):
 *   - terminal-page deadline: `assertDeadline()` after the call AND after
 *     `nextLink` (dataIntegrationAdapter.ts); either alone refuses `/final`;
 *   - D2 non-active row: the adapter's `c.status !== 'active'` AND the broker's
 *     pinned lane (`selectPinnedConnection`, connectionsService.ts:
 *     `refuse(status_…)`, witnessed by `crm-gmail-sync-pin.test.ts`). A REVOKED
 *     row is deleted, so it is refused as missing (`!c`), not by status;
 *   - a base whose host left the pins: call-time re-validation AND the broker's
 *     `apiHosts` pin;
 *   - `buildSourceUrl`'s final `isWithinBase` sits behind the `://`, dot-segment
 *     and `?#\\` checks: no literal path reaches it (defence in depth, a ceiling).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { registerProvider, getProvider } from '../src/features/connections/providerRegistry.js';
import {
  __setConnectionStatusForTests,
  createSecretConnection,
  getConnection,
  revokeConnection,
  setConnectionDataSource,
  upsertOAuthConnection,
} from '../src/features/connections/connectionsService.js';
import { makeConnectorsAdapter } from '../src/host/connectorsAdapter.js';
import { makeDataIntegrationAdapter, graphqlOperationKinds, PAGINATION_LIMITS } from '../src/host/dataIntegrationAdapter.js';
import { buildSourceUrl, nextLink, validateDataSourceBaseUrl } from '../src/host/dataSourceUrl.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { egressLedgerKey, priorSend } from '../src/host/egressSentLedger.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import type { RunRecord } from '../src/types.js';
import type { NodeModule, WorkflowDefinition } from '../src/executor/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}
function codeOfSync(f: () => unknown): string | undefined {
  try { f(); return undefined; } catch (e) { return (e as { code?: string }).code; }
}

/** Run `f` with private egress OFF (production posture), then restore. */
function production<T>(f: () => T): T {
  const prev = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  try { return f(); } finally { if (prev !== undefined) process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = prev; }
}

const TENANT = 'ten-ds-0783';
const RUN = 'run-ds-0783';
let storage: Storage;
let app: Awaited<ReturnType<typeof createApp>>;
let appServer: Server;
let BASE = '';
let api: Server;
let PORT = 0;
const hits: Array<{ method: string; url: string; body?: string; idempotencyKey?: string }> = [];
let flaky = 0;

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((r) => { appServer = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`; r(); }); });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));

  api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const ik = req.headers['idempotency-key'];
      hits.push({ method: req.method ?? '', url: req.url ?? '', ...(raw ? { body: raw } : {}), ...(typeof ik === 'string' ? { idempotencyKey: ik } : {}) });
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const page = Number(u.searchParams.get('p') ?? '1');
      if (u.pathname.startsWith('/api/items/')) return json(200, { path: u.pathname, query: Object.fromEntries(u.searchParams) });
      if (u.pathname === '/api/pages') {
        return json(200, [`row${page}`], page < 3 ? { link: `</api/pages?p=${page + 1}>; rel="next", </api/pages?p=1>; rel="first"` } : {});
      }
      if (u.pathname === '/api/malformed-link') return json(200, ['incomplete'], { link: '<http://[>; rel="next"' });
      if (u.pathname === '/api/malformed-header') return json(200, ['incomplete'], { link: 'not-a-link' });
      if (u.pathname === '/api/dense') return json(200, Array.from({ length: 200_000 }, () => 0));
      if (u.pathname === '/api/final') return json(200, ['late-final']);
      if (u.pathname === '/api/loop') return json(200, [page], { link: `</api/loop?p=${page + 1}>; rel="next"` });
      if (u.pathname === '/api/big') return json(200, ['x'.repeat(2_000_000)], { link: `</api/big?p=${page + 1}>; rel="next"` });
      if (u.pathname === '/api/obj') return json(200, { not: 'an array' }, { link: '</api/obj?p=2>; rel="next"' });
      if (u.pathname === '/api/escape') return json(200, [1], { link: `<http://localhost:${PORT}/api/escape?p=2>; rel="next"` });
      if (u.pathname === '/api/outside') return json(200, [1], { link: '</elsewhere?p=2>; rel="next"' });
      if (u.pathname === '/api/graphql') return json(200, { data: { x: 1 }, errors: [{ message: 'partial' }] });
      if (u.pathname === '/api/gql-500') return json(500, { errors: [{ message: 'boom' }] });
      if (u.pathname === '/api/fail') return json(404, { error: 'nope' });
      if (u.pathname === '/api/write') return json(201, { created: true, method: req.method });
      // Fails once, then accepts: a failed write must not block its retry.
      if (u.pathname === '/api/flaky') return (flaky++ === 0) ? json(503, { error: 'busy' }) : json(201, { created: true });
      return json(404, { error: 'unrouted' });
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  PORT = (api.address() as AddressInfo).port;
  registerProvider({
    id: 'dstest', label: 'Data source test', kind: 'api_key', authFlow: 'manual', reach: 'openapi',
    scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
  });
  registerProvider({
    id: 'dstest-ro', label: 'Read-only data source test', kind: 'api_key', authFlow: 'manual', reach: 'openapi', readOnly: true,
    scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'],
  });
  const seededAt = new Date().toISOString();
  const seeded: RunRecord = { runId: RUN, workflowId: 'w', tenantId: TENANT, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: seededAt, updatedAt: seededAt };
  await storage.insertRun(seeded);
});

afterAll(async () => {
  _resetKmsForTesting();
  await new Promise<void>((r) => api.close(() => r()));
  await new Promise<void>((r) => appServer.close(() => r()));
});

/** A workspace-scoped data source on the stub, rooted at `/api` (or `root`). */
async function source(root = '/api', tenantId = TENANT, provider = 'dstest'): Promise<string> {
  const c = await createSecretConnection({ tenantId, provider, kind: 'api_key', secret: 'ds-secret-key-1', scope: 'workspace' });
  await setConnectionDataSource(tenantId, c.connectionId, `http://127.0.0.1:${PORT}${root}`);
  return c.connectionId;
}
const di = () => makeDataIntegrationAdapter({ runId: RUN, tenantId: TENANT, connectors: makeConnectorsAdapter({ storage, tenantId: TENANT, runId: RUN }) });

describe('D1 — the base URL rule', () => {
  const PINS = ['service-now.com'];
  it('accepts an https base on a pinned host and normalises the trailing slash', () => {
    expect(production(() => validateDataSourceBaseUrl('https://acme.service-now.com/api/now/', PINS))).toBe('https://acme.service-now.com/api/now');
  });
  it('refuses http, credentials, a query, a fragment, dot segments, a private host and an off-pin host', () => {
    for (const bad of [
      'http://acme.service-now.com/api',
      'https://u:p@acme.service-now.com/api',
      'https://acme.service-now.com/api?x=1',
      'https://acme.service-now.com/api#f',
      'https://acme.service-now.com/a/../b',
      'https://acme.service-now.com/a/%2e%2e/b',
      'https://127.0.0.1/api',
      'https://service-now.com.evil.example/api',
      'https://evil.example/api',
    ]) expect(production(() => codeOfSync(() => validateDataSourceBaseUrl(bad, PINS))), bad).toBe('validation_error');
    expect(production(() => codeOfSync(() => validateDataSourceBaseUrl('https://acme.service-now.com', [])))).toBe('validation_error');
  });
});

describe('D4 — a request path cannot leave the base', () => {
  const B = 'https://acme.service-now.com/api';
  it('placeholder values are encoded as ONE segment, whatever they contain', () => {
    // `encodeURIComponent` leaves dots alone, so a value of `.`/`..` would BE a dot
    // segment: refused, never resolved.
    for (const v of ['.', '..']) expect(codeOfSync(() => buildSourceUrl(B, '/items/{{id}}', { id: v })), v).toBe('validation_error');
    for (const v of ['../x', '%2e%2e', '//evil', 'http://evil', 'a/b', 'a\\b']) {
      const url = new URL(buildSourceUrl(B, '/items/{{id}}', { id: v }));
      expect(url.origin, v).toBe('https://acme.service-now.com');
      expect(url.pathname.startsWith('/api/items/'), `${v} → ${url.pathname}`).toBe(true);
      expect(url.pathname.slice('/api/items/'.length).includes('/'), v).toBe(false);
    }
  });
  it('a literal path that escapes is refused before any request', () => {
    for (const p of ['//evil.example/x', 'http://evil.example/x', '/a/../../x', '/a/%2e%2e/x', '/a\\b', '/a?q=1', '/a#f']) {
      expect(codeOfSync(() => buildSourceUrl(B, p, {})), p).toBe('validation_error');
    }
  });
  it('unconsumed params become the query; a missing placeholder or an object param is refused', () => {
    const url = new URL(buildSourceUrl(B, '/items/{{id}}', { id: 7, limit: 5, tag: ['a', 'b'] }));
    expect(url.pathname).toBe('/api/items/7');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.getAll('tag')).toEqual(['a', 'b']);
    expect(codeOfSync(() => buildSourceUrl(B, '/items/{{id}}', {}))).toBe('validation_error');
    expect(codeOfSync(() => buildSourceUrl(B, '/x', { q: { nested: 1 } }))).toBe('validation_error');
  });
  it('nextLink reads rel="next" among several links, and resolves it against the page', () => {
    expect(nextLink('<https://h/a?p=2>; rel="next", <https://h/a?p=1>; rel="first"', 'https://h/a')).toBe('https://h/a?p=2');
    expect(nextLink('</a?p=3>; rel="prev next"', 'https://h/a?p=2')).toBe('https://h/a?p=3');
    expect(nextLink('<https://h/a?p=1>; rel="first"', 'https://h/a')).toBeNull();
    expect(nextLink(undefined, 'https://h/a')).toBeNull();
  });
});

describe('fetchRest over the real broker', () => {
  it('GET: fills the path, sends the query, returns the source status and body', async () => {
    const id = await source();
    hits.length = 0;
    // `/` must be encoded INTO the segment: the URL parser alone would keep it a separator.
    const r = await di().fetchRest({ sourceId: id, path: '/items/{{id}}', params: { id: 'a b/c', limit: 2 } });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ path: '/api/items/a%20b%2Fc', query: { limit: '2' } });
    expect(typeof r.fetchedAt).toBe('string');
    expect(hits).toHaveLength(1);
  });

  it('an HTTP error status is the source\'s answer, passed through', async () => {
    const id = await source();
    const r = await di().fetchRest({ sourceId: id, path: '/fail' });
    expect(r.status).toBe(404);
    expect(r.data).toEqual({ error: 'nope' });
  });

  it('an unknown verb, a GET with a body and a paginated write are refused before any request', async () => {
    const id = await source();
    hits.length = 0;
    expect(await codeOf(di().fetchRest({ sourceId: id, method: 'TRACE', path: '/write' }))).toBe('unsupported_operation');
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/write', body: { a: 1 } }))).toBe('validation_error');
    expect(await codeOf(di().fetchRest({ sourceId: id, method: 'POST', path: '/write', paginate: true, idempotencyKey: 'k-pg' }))).toBe('validation_error');
    expect(hits).toHaveLength(0);
  });
});

describe('D5/D6 — Link pagination', () => {
  it('aggregates every page in order, following rel="next" only', async () => {
    const id = await source();
    const r = await di().fetchRest({ sourceId: id, path: '/pages', paginate: true });
    expect(r.data).toEqual(['row1', 'row2', 'row3']);
    expect(r.pages).toBe(3);
  });
  it('stops at the page cap with a typed error, never a silent partial list', async () => {
    const id = await source();
    hits.length = 0;
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/loop', paginate: true }))).toBe('pagination_limit_exceeded');
    expect(hits).toHaveLength(PAGINATION_LIMITS.maxPages);
  });
  it('stops at the byte cap: three 2 MB pages exceed 5 MB on the third', async () => {
    const id = await source();
    hits.length = 0;
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/big', paginate: true }))).toBe('pagination_limit_exceeded');
    expect(hits).toHaveLength(3);
  });
  it('stops at the wall-clock cap before the next page', async () => {
    const id = await source();
    hits.length = 0;
    const real = Date.now.bind(Date);
    // Time passes the cap once the source has served its first page.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => real() + (hits.length > 0 ? PAGINATION_LIMITS.maxWallMs + 1 : 0));
    try {
      expect(await codeOf(di().fetchRest({ sourceId: id, path: '/loop', paginate: true }))).toBe('pagination_limit_exceeded');
    } finally { spy.mockRestore(); }
    expect(hits).toHaveLength(1);
  });
  it('a next link to another origin, or outside the base path, is refused', async () => {
    const id = await source();
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/escape', paginate: true }))).toBe('validation_error');
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/outside', paginate: true }))).toBe('validation_error');
  });
  it('a page that is not an array cannot be aggregated', async () => {
    const id = await source();
    expect(await codeOf(di().fetchRest({ sourceId: id, path: '/obj', paginate: true }))).toBe('pagination_unsupported_shape');
  });
});

describe('D6 — pagination completion is fail-closed at the HTTP boundary', () => {
  it('only actual relation parameters drive pagination (quoted-pair decoding and first duplicate wins)', () => {
    const current = 'https://api.example/api/pages';
    expect(nextLink('</api/pages?p=2>; title="x; rel=next ignored"; rel="first"', current)).toBeNull();
    expect(nextLink(String.raw`</api/pages?p=2>; title="comma, semicolon; text"; rel="n\ext"`, current)).toBe('https://api.example/api/pages?p=2');
    expect(nextLink('</api/pages?p=2>; rel="first"; rel="next"', current)).toBeNull();
    expect(nextLink('</api/pages>; rel="urn:example:other"', current)).toBeNull();
    for (const header of ['</api/pages>', '</api/pages>; rel=""', '</api/pages>; rel', '</api/pages>; rel="   "', '</api/pages>; rel=""; rel="next"']) {
      expect(codeOfSync(() => nextLink(header, current))).toBe('source_invalid_response');
    }
  });

  it('aggregates a real HTTP page with 200000 entries below the byte cap without argument spreading', async () => {
    const id = await source();
    const expected = Array.from({ length: 200_000 }, () => 0);
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBeLessThan(PAGINATION_LIMITS.maxBytes);
    hits.length = 0;
    const result = await di().fetchRest({ sourceId: id, path: '/dense', paginate: true });
    expect(result).toMatchObject({ status: 200, pages: 1 });
    expect(result.data).toEqual(expected);
    expect(hits).toHaveLength(1);
  });

  it('preserves commas in URI/quoted parameters and refuses malformed trailing link-values', () => {
    expect(nextLink('</api/pages?cursor=a,b>; title="two, pages"; rel="next", </api/pages>; rel="first"', 'https://api.example/api/pages')).toBe('https://api.example/api/pages?cursor=a,b');
    expect(nextLink('</api/pages>; rel="first"', 'https://api.example/api/pages')).toBeNull();
    for (const header of ['<http://[>; rel="next"', 'not-a-link', '</api/pages>; rel="next", garbage', '</api/pages>; title="unfinished']) {
      expect(codeOfSync(() => nextLink(header, 'https://api.example/api/pages'))).toBe('source_invalid_response');
    }
  });

  it.each(['/malformed-link', '/malformed-header'])('refuses %s without returning a partial list', async (path) => {
    const id = await source();
    hits.length = 0;
    await expect(di().fetchRest({ sourceId: id, path, paginate: true })).rejects.toMatchObject({ code: 'source_invalid_response' });
    expect(hits).toHaveLength(1);
  });

  it('refuses a terminal page that completes after the deadline (not only a next hop)', async () => {
    const id = await source();
    hits.length = 0;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now + (hits.length ? PAGINATION_LIMITS.maxWallMs + 1 : 0));
    try {
      await expect(di().fetchRest({ sourceId: id, path: '/final', paginate: true })).rejects.toMatchObject({ code: 'pagination_limit_exceeded' });
      expect(hits).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});

describe('D2 — one non-probing refusal', () => {
  it('unknown, foreign-tenant, unconfigured, revoked and another user\'s connection all answer source_unavailable', async () => {
    const foreign = await source('/api', 'ten-ds-other');
    const plain = await createSecretConnection({ tenantId: TENANT, provider: 'dstest', kind: 'api_key', secret: 'ds-secret-key-2', scope: 'workspace' });
    // A revoke DELETES the row, so this leg is the missing-row refusal (`!c`).
    const revoked = await source();
    await revokeConnection(TENANT, revoked);
    // A row that still exists but is not `active` (double guard: the adapter's
    // status check AND the broker's pinned lane; see the header).
    const stale = await source();
    await __setConnectionStatusForTests(stale, 'needs-reconsent');
    expect((await getConnection(TENANT, stale))?.status, 'the stale row still exists').toBe('needs-reconsent');
    // A USER-scoped row of someone else: the broker's pin refuses it (not_owner).
    const theirs = await createSecretConnection({ tenantId: TENANT, provider: 'dstest', kind: 'api_key', secret: 'ds-secret-key-3', scope: 'user', userId: 'user:someone-else' });
    await setConnectionDataSource(TENANT, theirs.connectionId, `http://127.0.0.1:${PORT}/api`);
    hits.length = 0;
    for (const id of ['conn:does-not-exist', foreign, plain.connectionId, revoked, stale, theirs.connectionId]) {
      expect(await codeOf(di().fetchRest({ sourceId: id, path: '/items/1' })), id).toBe('source_unavailable');
    }
    expect(hits, 'none of them reached the source').toHaveLength(0);
  });

  it('D1 at CALL time: a stored base that breaks the rule is never used, even where the broker would allow it', async () => {
    // The broker pins HOSTS; it would happily call this base. Only the call-time
    // re-validation refuses a query-carrying or credential-carrying base that
    // reached storage some other way (an older write path, a restore, a bug).
    const id = await source();
    for (const stored of [`http://127.0.0.1:${PORT}/api?token=x`, `http://u:p@127.0.0.1:${PORT}/api`]) {
      await setConnectionDataSource(TENANT, id, stored);
      hits.length = 0;
      expect(await codeOf(di().fetchRest({ sourceId: id, path: '/items/1' })), stored).toBe('source_unavailable');
      expect(hits, stored).toHaveLength(0);
    }
  });

  it('...and a base whose host left the provider\'s pins is refused too (here the broker agrees)', async () => {
    const id = await source();
    const original = getProvider('dstest')!;
    registerProvider({ ...original, apiHosts: ['example.com'] });
    try {
      expect(await codeOf(di().fetchRest({ sourceId: id, path: '/items/1' }))).toBe('source_unavailable');
    } finally {
      registerProvider(original);
    }
  });
});

describe('D3 — a workspace Connection is pinnable', () => {
  it('the exact workspace row is used (every call above rides one); an un-pinned call is not involved', async () => {
    const id = await source();
    const c = await getConnection(TENANT, id);
    expect(c && !c.userId && !c.orgId, 'the source is a WORKSPACE row').toBe(true);
    expect((await di().fetchRest({ sourceId: id, path: '/items/1' })).status).toBe(200);
  });
});

describe('D8 — GraphQL', () => {
  it('reads the operation type past strings, block strings and comments', () => {
    expect([...graphqlOperationKinds('{ a }')]).toEqual(['query']);
    expect([...graphqlOperationKinds('query Q { a }')]).toEqual(['query']);
    expect(graphqlOperationKinds('# mutation\nquery Q { a(s: "mutation") }').has('mutation')).toBe(false);
    expect(graphqlOperationKinds('query Q { a(s: """\nmutation X { b }\n""") }').has('mutation')).toBe(false);
    expect(graphqlOperationKinds('fragment F on T { a } mutation M { b }').has('mutation')).toBe(true);
    expect(graphqlOperationKinds('subscription S { a }').has('subscription')).toBe(true);
  });

  it('a query is POSTed to the base; 200 + errors passes through as partial success', async () => {
    const id = await source('/api/graphql');
    hits.length = 0;
    const r = await di().fetchGraphql({ sourceId: id, operation: 'query Q { x }', operationName: 'Q', variables: { a: 1 } });
    expect(r.data).toEqual({ x: 1 });
    expect(r.errors).toEqual([{ message: 'partial' }]);
    expect(hits[0]?.method).toBe('POST');
    expect(hits[0]?.url).toBe('/api/graphql');
    expect(JSON.parse(hits[0]!.body!)).toEqual({ query: 'query Q { x }', operationName: 'Q', variables: { a: 1 } });
  });

  it('a subscription is refused and never sent; a non-2xx is source_http_error', async () => {
    const id = await source('/api/graphql');
    hits.length = 0;
    expect(await codeOf(di().fetchGraphql({ sourceId: id, operation: 'subscription S { x }' }))).toBe('unsupported_operation');
    expect(hits).toHaveLength(0);
    const bad = await source('/api/gql-500');
    expect(await codeOf(di().fetchGraphql({ sourceId: bad, operation: '{ x }' }))).toBe('source_http_error');
  });
});

describe('D8 — canonical AST read-only enforcement at the HTTP boundary', () => {
  // Phase 2b: a hidden mutation makes the whole document a WRITE, so without an
  // idempotencyKey it is refused before dialing; a subscription is never served.
  it.each([['mutation', 'validation_error'], ['subscription', 'unsupported_operation']] as const)('classes an escaped-block-string-hidden %s before any provider call (%s)', async (kind, code) => {
    const id = await source('/api/graphql');
    const operation = String.raw`query Read($arg: String = """aaa \""" bbb""") { read(arg: $arg) } ${kind} Write { doWrite }`;
    expect(graphqlOperationKinds(operation).has(kind)).toBe(true);
    hits.length = 0;
    await expect(di().fetchGraphql({ sourceId: id, operation, operationName: 'Write' })).rejects.toMatchObject({ code });
    expect(hits).toHaveLength(0);
  });

  it('accepts an escaped triple quote inside a query block string through the real broker', async () => {
    const id = await source('/api/graphql');
    const operation = String.raw`query Read($arg: String = """aaa \""" bbb""") { read(arg: $arg) }`;
    hits.length = 0;
    expect((await di().fetchGraphql({ sourceId: id, operation, operationName: 'Read' })).data).toEqual({ x: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe('POST');
    expect(JSON.parse(hits[0]!.body!).query).toBe(operation);
  });

  // The last document carries a real operation, so only the executable-definitions
  // check (not the empty-operation check) can refuse it.
  it.each(['query Read {', 'fragment F on T { a }', 'type Query { a: String }', 'type Query { a: String } query Q { a }'])('refuses non-executable/malformed documents before dialing: %s', async (operation) => {
    const id = await source('/api/graphql');
    hits.length = 0;
    await expect(di().fetchGraphql({ sourceId: id, operation })).rejects.toMatchObject({ code: 'validation_error' });
    expect(hits).toHaveLength(0);
  });
});

describe('D7 — writes go through the egress ledger', () => {
  const key = (): string => `openwop-${randomBytes(8).toString('hex')}`;

  it('a POST is sent once with its body and Idempotency-Key; the same key again is never re-sent', async () => {
    const id = await source();
    const k = key();
    hits.length = 0;
    const r = await di().fetchRest({ sourceId: id, method: 'POST', path: '/write', body: { name: 'a' }, idempotencyKey: k });
    expect(r.status).toBe(201);
    expect(r.data).toEqual({ created: true, method: 'POST' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'POST', url: '/api/write', idempotencyKey: k });
    expect(JSON.parse(hits[0]!.body!)).toEqual({ name: 'a' });
    expect(await codeOf(di().fetchRest({ sourceId: id, method: 'POST', path: '/write', body: { name: 'a' }, idempotencyKey: k }))).toBe('duplicate_result_unavailable');
    expect(hits).toHaveLength(1);
  });

  it('the ledger keeps the status, never a body', async () => {
    const id = await source();
    const k = key();
    await di().fetchRest({ sourceId: id, method: 'PUT', path: '/write', body: { secret: 'subject-data' }, idempotencyKey: k });
    const row = await priorSend(egressLedgerKey(TENANT, 'data', k));
    expect(row).toMatchObject({ channel: 'data', provider: 'dstest', status: 201 });
    expect(JSON.stringify(row)).not.toContain('subject-data');
    expect(JSON.stringify(row)).not.toContain('"created":true'); // the response body's own field
  });

  it('two concurrent writes with one key send exactly once', async () => {
    const id = await source();
    const k = key();
    hits.length = 0;
    const both = await Promise.allSettled([1, 2].map(() => di().fetchRest({ sourceId: id, method: 'POST', path: '/write', idempotencyKey: k })));
    expect(hits).toHaveLength(1);
    expect(both.filter((b) => b.status === 'fulfilled')).toHaveLength(1);
  });

  it('a failed write is released, so its retry is sent; the source status passes through', async () => {
    const id = await source();
    const k = key();
    flaky = 0;
    hits.length = 0;
    const first = await di().fetchRest({ sourceId: id, method: 'POST', path: '/flaky', idempotencyKey: k });
    expect(first.status).toBe(503);
    const retry = await di().fetchRest({ sourceId: id, method: 'POST', path: '/flaky', idempotencyKey: k });
    expect(retry.status).toBe(201);
    expect(hits).toHaveLength(2);
  });

  it('a write without an idempotencyKey is refused; a GET is never ledgered', async () => {
    const id = await source();
    hits.length = 0;
    expect(await codeOf(di().fetchRest({ sourceId: id, method: 'DELETE', path: '/write' }))).toBe('validation_error');
    expect(hits).toHaveLength(0);
    const k = key();
    await di().fetchRest({ sourceId: id, path: '/items/1', idempotencyKey: k });
    await di().fetchRest({ sourceId: id, path: '/items/1', idempotencyKey: k });
    expect(hits).toHaveLength(2);
    expect(await priorSend(egressLedgerKey(TENANT, 'data', k))).toBeNull();
  });

  it('a read-only provider refuses every REST write and a mutation before sending, while a GraphQL query still reads', async () => {
    const ro = await source('/api', TENANT, 'dstest-ro');
    const roGql = await source('/api/graphql', TENANT, 'dstest-ro');
    hits.length = 0;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await codeOf(di().fetchRest({ sourceId: ro, method, path: '/write', idempotencyKey: key() }))).toBe('connector_read_only');
    }
    expect(await codeOf(di().fetchGraphql({ sourceId: roGql, operation: 'mutation M { x }', idempotencyKey: key() }))).toBe('connector_read_only');
    expect(hits).toHaveLength(0);
    // ...while a query on the same read-only source still reads.
    expect((await di().fetchGraphql({ sourceId: roGql, operation: '{ x }' })).data).toEqual({ x: 1 });
  });

  it('a GraphQL mutation is sent once with its Idempotency-Key, and never repeated', async () => {
    const id = await source('/api/graphql');
    const k = key();
    hits.length = 0;
    const r = await di().fetchGraphql({ sourceId: id, operation: 'mutation M { x }', idempotencyKey: k });
    expect(r.data).toEqual({ x: 1 });
    expect(hits[0]).toMatchObject({ method: 'POST', idempotencyKey: k });
    expect(await codeOf(di().fetchGraphql({ sourceId: id, operation: 'mutation M { x }', idempotencyKey: k }))).toBe('duplicate_result_unavailable');
    expect(await codeOf(di().fetchGraphql({ sourceId: id, operation: 'mutation M { x }' }))).toBe('validation_error');
    expect(hits).toHaveLength(1);
  });
});

describe('D1 — the data-source route', () => {
  const C = '/host/openwop-app/connections';
  let WS = '';
  const EDITOR = 'oidc:d0783-editor';
  const VIEWER = 'oidc:d0783-viewer';
  async function login(subject: string): Promise<string> {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }
  /** The data-source route's answer, or this host's flat error envelope. */
  interface DataSourceBody { dataSource?: { baseUrl: string; updatedAt: string } | null; error?: string; message?: string }
  async function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<{ status: number; body: DataSourceBody | undefined }> {
    const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: res.status === 204 ? undefined : ((await res.json().catch(() => undefined)) as DataSourceBody | undefined) };
  }
  beforeAll(async () => {
    const ws = await createWorkspace({ name: 'ADR 0783 p2a', ownerSubject: 'oidc:d0783-owner' });
    WS = ws.orgId ?? ws.tenantId;
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: userIdFor(WS, VIEWER), roles: ['viewer'] });
  });

  it('an editor sets, reads and clears their connection\'s base; an invalid base is 400', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-editor-key-0783', scope: 'user', userId: userIdFor(WS, EDITOR) });
    const editor = await login(EDITOR);
    const path = `${C}/${encodeURIComponent(row.connectionId)}/data-source`;
    const bad = await production(() => call(path, editor, 'PUT', { baseUrl: 'https://evil.example/api' }));
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    const ok = await production(() => call(path, editor, 'PUT', { baseUrl: 'https://acme.service-now.com/api/now/' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body?.dataSource?.baseUrl).toBe('https://acme.service-now.com/api/now');
    expect((await call(path, editor)).body?.dataSource?.baseUrl).toBe('https://acme.service-now.com/api/now');
    expect((await call(path, editor, 'DELETE')).status).toBe(204);
    expect((await call(path, editor)).body?.dataSource).toBeNull();
  });

  it('a Viewer who owns a connection cannot make it a data source (a workspace write)', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-viewer-key-0783', scope: 'user', userId: userIdFor(WS, VIEWER) });
    const viewer = await login(VIEWER);
    const res = await production(() => call(`${C}/${encodeURIComponent(row.connectionId)}/data-source`, viewer, 'PUT', { baseUrl: 'https://acme.service-now.com/api' }));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // The WRITE gate's refusal, not the owner check's (the Viewer owns the row).
    expect(res.body).toMatchObject({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' });
    expect((await getConnection(WS, row.connectionId))?.dataSource).toBeUndefined();
  });

  it('a re-consent keeps the data source (the oauth row is rebuilt, the operator config is not the grant\'s)', async () => {
    const tokens = { accessToken: 'at-1', refreshToken: 'rt-1', tokenType: 'Bearer', scopes: ['a'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const first = await upsertOAuthConnection({ tenantId: TENANT, provider: 'slack', userId: 'user:reconsent-0783', tokens });
    await setConnectionDataSource(TENANT, first.connectionId, 'https://slack.com/api');
    const again = await upsertOAuthConnection({ tenantId: TENANT, provider: 'slack', userId: 'user:reconsent-0783', tokens: { ...tokens, accessToken: 'at-2' } });
    expect(again.connectionId).toBe(first.connectionId);
    expect((await getConnection(TENANT, first.connectionId))?.dataSource?.baseUrl).toBe('https://slack.com/api');
  });
});

describe('the pack\'s own nodes, through the real adapter and broker', () => {
  type NodeFn = (ctx: Record<string, unknown>) => Promise<{ status: string; outputs: Record<string, unknown> }>;
  let pack: { sourceRest: NodeFn; sourceGraphql: NodeFn };
  beforeAll(async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    pack = (await import(pathToFileURL(join(here, '..', '..', '..', 'packs', 'vendor.myndhyve.data-integration', 'index.mjs')).href)) as typeof pack;
  });

  it('data.source.rest: config + inputs as the pack sends them → the output schema\'s data/status/pages/fetchedAt', async () => {
    const id = await source();
    const base = { runId: RUN, nodeId: 'rest-1', dataIntegration: di() };
    const one = await pack.sourceRest({ ...base, config: { sourceId: id, method: 'GET', path: '/items/{{id}}' }, inputs: { params: { id: 42 } } });
    expect(one.outputs.status).toBe(200);
    expect(one.outputs.data).toEqual({ path: '/api/items/42', query: {} });
    const paged = await pack.sourceRest({ ...base, config: { sourceId: id, path: '/pages', paginate: true }, inputs: {} });
    expect(paged.outputs).toMatchObject({ data: ['row1', 'row2', 'row3'], status: 200, pages: 3 });
  });

  it('data.source.rest POST: a retried node derives the same key, so the write is sent once', async () => {
    const id = await source();
    hits.length = 0;
    const node = { runId: RUN, nodeId: `rest-write-${randomBytes(4).toString('hex')}`, dataIntegration: di(), config: { sourceId: id, method: 'POST', path: '/write' }, inputs: { body: { n: 1 } } };
    expect((await pack.sourceRest(node)).outputs.status).toBe(201);
    expect(await codeOf(pack.sourceRest(node))).toBe('duplicate_result_unavailable');
    expect(hits).toHaveLength(1);
  });

  it('data.source.graphql: operation + operationName + variables → data and errors', async () => {
    const id = await source('/api/graphql');
    const out = await pack.sourceGraphql({ runId: RUN, nodeId: 'gql-1', dataIntegration: di(), config: { sourceId: id, operation: 'query Q { x }', operationName: 'Q' }, inputs: { variables: { a: 1 } } });
    expect(out.outputs.data).toEqual({ x: 1 });
    expect(out.outputs.errors).toEqual([{ message: 'partial' }]);
  });
});

describe('the executor wires data sources onto a real run', () => {
  it('a node in a real run reads a data source through its own ctx', async () => {
    const { executeRun } = await import('../src/executor/executor.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const id = await source();
    const typeId = 'test.adr0783.p2a-probe';
    const probeNode: NodeModule = {
      typeId, version: '1.0.0',
      async execute(ctx) {
        const di = ctx.dataIntegration;
        if (!di) return { status: 'failure', error: { code: 'no_surface', message: 'ctx.dataIntegration absent' } };
        try {
          const r = await di.fetchRest({ sourceId: id, path: '/items/{{id}}', params: { id: 'run' } });
          return r.status === 200 ? { status: 'success', outputs: { data: r.data } } : { status: 'failure', error: { code: 'status', message: String(r.status) } };
        } catch (e) {
          return { status: 'failure', error: { code: (e as { code?: string }).code ?? 'x', message: String(e) } };
        }
      },
    };
    getNodeRegistry().register(probeNode);
    const now = new Date().toISOString();
    const run: RunRecord = { runId: 'run-0783p2a-exec', workflowId: 'wf.test.0783.p2a', tenantId: TENANT, status: 'pending', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
    await storage.insertRun(run);
    const definition: WorkflowDefinition = { workflowId: 'wf.test.0783.p2a', nodes: [{ nodeId: 'p', typeId }] };
    const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
    const result = await executeRun(storage, run, definition, { policyResolver });
    expect(result.status, JSON.stringify(result)).toBe('completed');
  });
});
