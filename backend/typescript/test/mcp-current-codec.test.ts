/**
 * ADR 0553 P2 — the `mcp-2026-07-28` codec, host-as-server.
 *
 * Drives the REAL mount (`POST /v1/host/openwop-app/mcp`) over HTTP, because
 * every rule RFC 0153 §B states is about the boundary between the headers and
 * the body — a test that called `dispatchCurrent` directly would be free to
 * make the two agree by construction and would prove nothing about the door.
 *
 * The legs, and what each would let through if it were missing:
 *   - stateless `tools/list` (no `initialize`, no session) — a host that still
 *     required a handshake would be a 2025-06-18 server wearing a header;
 *   - `server/discover` ⇔ `capabilities.mcp.protocolVersions` — two documents,
 *     one fact; a host that disagreed would be unreliable to any peer that read
 *     the other one;
 *   - header ≠ body ⇒ `-32020` at HTTP 400 — the whole point of the header is
 *     that a proxy or confused client cannot make the halves mean two things;
 *   - an unserved revision ⇒ `-32022` + `data.supported[]` — the fail-closed
 *     path ADR 0553 P1 deferred, and the one that must never degrade to "serve
 *     it as legacy";
 *   - `initialize` under the current revision ⇒ `-32601` at 404, LOUD;
 *   - `resultType` + `CacheableResult` on every list, `cacheScope: private`
 *     because this host's lists depend on the caller (§D);
 *   - unknown `_meta` extension keys ignored — opacity means ignored, not
 *     refused and not honoured (§D `mcp-extension-no-authority`);
 *   - MRTR: a suspending tool answers `input_required` with a bound
 *     `requestState`, the retry resolves it, and a FORGED state is refused (§C.2).
 *
 * @see spec/v1/mcp-integration.md §"MCP 2026-07-28 versioned composition"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { elicitationPlan, isFormSafeSchema } from '../src/host/mcpCurrentCodec.js';
import {
  MCP_CURRENT_VERSION,
  MCP_ERR_HEADER_MISMATCH,
  MCP_ERR_MISSING_CLIENT_CAPABILITY,
  MCP_ERR_UNSUPPORTED_VERSION,
  MCP_LEGACY_VERSION,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_SUPPORTED_VERSIONS,
} from '../src/host/mcpProfile.js';

let BASE: string;
let server: http.Server;

const MCP = '/v1/host/openwop-app/mcp';
const TOOL = `mrtr_probe_${Date.now()}`;
let rpcId = 0;
/**
 * The session cookie, carried across requests.
 *
 * NOT incidental. `requestState` is bound to the AUTHENTICATED PRINCIPAL
 * (§C.2), and this boot mints a fresh anonymous session per cookie-less
 * request — so a test that dropped the cookie would present a different
 * principal on the retry and be refused, correctly. Carrying it is what makes
 * the MRTR legs a test of the round trip rather than of the principal binding
 * (which has its own leg below).
 */
let cookie = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  // The mount fails CLOSED without a principal (ADR 0553 P0). The named
  // single-tenant seam principal is the supported way to have one in a test.
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // The MRTR fixture: expose a tool whose backing node asks for input. Same
  // shape the conformance suite registers (`mcp-mrtr-roundtrip.test.ts`).
  const reg = await fetch(`${BASE}/v1/host/openwop-app/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflowId: `mcp.mrtr.${TOOL}`,
      nodes: [
        { nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: TOOL, description: 'MRTR probe', inputSchema: { type: 'object', properties: {} } } },
        { nodeId: 'ask', typeId: 'core.openwop.mcp.handle-elicitation', config: { message: 'What is your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
      ],
      // NOTE the edge shape. `mcp-mrtr-roundtrip.test.ts` (suite 1.113.0)
      // registers this same fixture with `{ from, to }` — the RFC 0013
      // workflow-CHAIN edge vocabulary — against the workflow-DEFINITION
      // endpoint, which takes `{ edgeId, sourceNodeId, targetNodeId }`. This
      // host answers that 400, so the suite's server half is blocked on a
      // fixture bug rather than on the codec. Reported upstream; recorded in
      // ADR 0553 § "P2 — implemented".
      edges: [{ edgeId: 'expose-to-ask', sourceNodeId: 'expose', targetNodeId: 'ask' }],
    }),
  });
  expect([200, 201], `workflow registration failed: ${await reg.clone().text()}`).toContain(reg.status);
});

afterAll(async () => {
  delete process.env.OPENWOP_MCP_SERVER_ENABLED;
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

interface RpcOpts {
  version?: string;
  bodyVersion?: string | null;
  mcpMethod?: string | null;
  mcpName?: string;
  clientCapabilities?: Record<string, unknown>;
  extraMeta?: Record<string, unknown>;
}

async function rpc(method: string, params: Record<string, unknown> = {}, opts: RpcOpts = {}): Promise<{
  status: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}> {
  const version = opts.version ?? MCP_CURRENT_VERSION;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'MCP-Protocol-Version': version };
  if (opts.mcpMethod !== null) headers['Mcp-Method'] = opts.mcpMethod ?? method;
  if (opts.mcpName !== undefined) headers['Mcp-Name'] = opts.mcpName;
  const meta: Record<string, unknown> = { ...(opts.extraMeta ?? {}) };
  if (opts.bodyVersion !== null) meta[MCP_META_PROTOCOL_VERSION] = opts.bodyVersion ?? version;
  meta[MCP_META_CLIENT_CAPABILITIES] = opts.clientCapabilities ?? {};
  const res = await fetch(`${BASE}${MCP}`, {
    method: 'POST',
    headers: { ...headers, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, _meta: meta } }),
  });
  for (const ck of getSetCookies(res.headers)) {
    const m = /(__session=[^;]+)/.exec(ck);
    if (m?.[1]) cookie = m[1];
  }
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } };
  return { status: res.status, ...body };
}

describe('RFC 0153 §B — stateless routing and discovery', () => {
  it('tools/list succeeds with NO initialize and NO session header', async () => {
    const r = await rpc('tools/list');
    expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(r.error).toBeUndefined();
    expect(r.result?.resultType).toBe('complete');
    expect(Array.isArray(r.result?.tools)).toBe(true);
    expect((r.result?.tools as Array<{ name: string }>).map((t) => t.name)).toContain(TOOL);
  });

  it('two independent requests from one caller agree — no per-connection state', async () => {
    const a = await rpc('tools/list');
    const b = await rpc('tools/list');
    expect(JSON.stringify(b.result?.tools)).toBe(JSON.stringify(a.result?.tools));
  });

  it('server/discover reports supportedVersions EQUAL to the advertised set, with cache hints', async () => {
    const r = await rpc('server/discover');
    expect(r.status).toBe(200);
    expect(r.result?.resultType).toBe('complete');
    expect(r.result?.supportedVersions).toEqual([...MCP_SUPPORTED_VERSIONS]);
    expect(typeof r.result?.ttlMs).toBe('number');
    expect(['public', 'private']).toContain(r.result?.cacheScope);
    expect((r.result?._meta as Record<string, unknown>)?.[MCP_META_SERVER_INFO]).toBeDefined();
  });

  it('a request with no _meta.protocolVersion is refused -32020 (400)', async () => {
    const r = await rpc('tools/list', {}, { bodyVersion: null });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_HEADER_MISMATCH);
  });

  it('a header/body revision mismatch is refused -32020 (400)', async () => {
    // A body naming a revision this host DOES serve, disagreeing with the
    // header. This is the pure mismatch: neither half is unsupported.
    const r = await rpc('tools/list', {}, { bodyVersion: MCP_LEGACY_VERSION });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_HEADER_MISMATCH);
  });

  it('a body naming an UNSERVED revision is -32020, not -32022 — agreement before selection', async () => {
    // The exact vector from `mcp-2026-07-28-discover.test.ts`: header
    // `2026-07-28` + body `2025-11-25`, which is BOTH a disagreement AND an
    // unsupported revision. This host answered `-32022` (support-first) and the
    // leg failed; openwop#1027 (suite 1.121.0) settled the order as
    // agreement-first and made the spec say so.
    //
    // The order is the better one on its own terms: when the two halves of one
    // request disagree, the host does not yet know what the peer was asking
    // for, so "I do not support X" asserts a reading the request does not have.
    const r = await rpc('tools/list', {}, { bodyVersion: '2025-11-25' });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_HEADER_MISMATCH);
  });

  it('Mcp-Method disagreeing with the JSON-RPC method is refused -32020', async () => {
    const r = await rpc('tools/list', {}, { mcpMethod: 'tools/call' });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_HEADER_MISMATCH);
  });

  it('Mcp-Name disagreeing with params.name is refused -32020', async () => {
    const r = await rpc('tools/call', { name: TOOL, arguments: {} }, { mcpName: 'something-else' });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_HEADER_MISMATCH);
  });

  it('an unserved revision is refused -32022 with data.supported[] and data.requested (400)', async () => {
    const r = await rpc('tools/list', {}, { version: '1999-01-01' });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_UNSUPPORTED_VERSION);
    expect(r.error?.data?.supported).toEqual([...MCP_SUPPORTED_VERSIONS]);
    expect(r.error?.data?.requested).toBe('1999-01-01');
  });

  it('a real upstream revision this host does not speak is ALSO refused, not served as legacy', async () => {
    // 2025-11-25 exists upstream and is explicitly NOT an OpenWOP composition
    // profile (`mcp-integration.md` §A). Serving it under legacy semantics is
    // the silent downgrade §B forbids, and it is the most tempting one because
    // the request would otherwise "work".
    const r = await rpc('tools/list', {}, { version: '2025-11-25' });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_UNSUPPORTED_VERSION);
  });

  it('initialize under the current revision is method-not-found (404) — the handshake does not exist', async () => {
    const r = await rpc('initialize', {});
    expect(r.status).toBe(404);
    expect(r.error?.code).toBe(-32601);
  });

  it('the legacy live callbacks are refused under the current revision — no silent fallback', async () => {
    for (const method of ['elicitation/create', 'sampling/createMessage']) {
      const r = await rpc(method, {});
      expect(r.status, method).toBe(404);
      expect(r.error?.code, method).toBe(-32601);
    }
  });

  it('a HEADER-LESS request still gets legacy semantics — the existing wire is untouched', async () => {
    const res = await fetch(`${BASE}${MCP}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_LEGACY_VERSION } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { protocolVersion?: string } };
    expect(body.result?.protocolVersion).toBe(MCP_LEGACY_VERSION);
  });
});

describe('RFC 0153 §D — cacheable lists and extension opacity', () => {
  it('every list carries resultType + ttlMs + cacheScope, and the scope is private', async () => {
    for (const method of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']) {
      const r = await rpc(method);
      expect(r.result?.resultType, method).toBe('complete');
      expect(typeof r.result?.ttlMs, method).toBe('number');
      // §D: `cacheScope` follows the TENANT boundary. This host derives lists
      // from `listToolsForPrincipal` and the caller's tenant, so `public` would
      // be a licence for a cache to serve one tenant's list to another.
      expect(r.result?.cacheScope, method).toBe('private');
    }
  });

  it('an unknown _meta extension key is IGNORED — not refused, not honoured', async () => {
    const r = await rpc('tools/list', {}, {
      clientCapabilities: { extensions: { 'io.example/authority': { admin: true } } },
      extraMeta: { 'io.example/authority': { grantScopes: ['*'] } },
    });
    expect(r.status).toBe(200);
    expect(r.error).toBeUndefined();
    expect(r.result?.resultType).toBe('complete');
  });
});

describe('RFC 0153 §C.2 — MRTR, host as server', () => {
  const HDR = { clientCapabilities: { elicitation: {} }, mcpName: TOOL };

  it('a client that did NOT declare elicitation gets -32021, not an elicitation it cannot answer', async () => {
    const r = await rpc('tools/call', { name: TOOL, arguments: {} }, { mcpName: TOOL });
    expect(r.status).toBe(400);
    expect(r.error?.code).toBe(MCP_ERR_MISSING_CLIENT_CAPABILITY);
    expect(r.error?.data?.requiredCapabilities).toEqual(['elicitation']);
  });

  it('a suspending tool answers input_required with an elicitation and a requestState; the retry resolves it', async () => {
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.result?.resultType).toBe('input_required');
    const requests = first.result?.inputRequests as Record<string, { method: string; params: { mode: string; message: string; requestedSchema: Record<string, unknown> } }>;
    const key = Object.keys(requests)[0]!;
    expect(requests[key]?.method).toBe('elicitation/create');
    expect(requests[key]?.params.mode).toBe('form');
    expect(requests[key]?.params.message).toBe('What is your name?');
    expect(requests[key]?.params.requestedSchema).toMatchObject({ type: 'object' });
    const state = first.result?.requestState;
    expect(typeof state).toBe('string');
    // An interim MRTR result MUST NOT be cacheable (§C.1/§D).
    expect(first.result?.ttlMs).toBeUndefined();
    expect(first.result?.cacheScope).toBeUndefined();

    const retry = await rpc('tools/call', {
      name: TOOL,
      arguments: {},
      requestState: state,
      inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } },
    }, HDR);
    expect(retry.status, JSON.stringify(retry.error)).toBe(200);
    expect(retry.error).toBeUndefined();
    expect(retry.result?.resultType).toBe('complete');
  });

  it('a FORGED requestState is refused', async () => {
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const forged = await rpc('tools/call', {
      name: TOOL,
      arguments: {},
      requestState: 'forged',
      inputResponses: { [key]: { action: 'accept', content: { name: 'Eve' } } },
    }, HDR);
    expect(forged.error?.code ?? 0, 'a state that fails integrity verification MUST be refused').toBe(-32602);
  });

  it('a requestState is SINGLE USE — a replay of a verifying state is refused', async () => {
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const state = first.result?.requestState;
    const params = { name: TOOL, arguments: {}, requestState: state, inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } } };
    const ok = await rpc('tools/call', params, HDR);
    expect(ok.result?.resultType).toBe('complete');
    // §C.2: "Single use is enforced by consuming the interrupt token — a second
    // retry with the same `requestState` MUST fail." The HMAC still verifies;
    // what is gone is the interrupt.
    const replay = await rpc('tools/call', params, HDR);
    expect(replay.error?.code).toBe(-32602);
  });

  it('two retries of one requestState issued together still resolve the gate exactly ONCE', async () => {
    // WHAT THIS DOES AND DOES NOT WITNESS — measured, not assumed.
    //
    // It was written to exercise the storage CAS in `resumeInterrupt`
    // (`resolveInterrupt` flips resolved_at NULL→set and returns `won` to
    // exactly one caller). It does NOT: sabotaging that CAS leaves this leg
    // GREEN. Two `fetch`es issued together against one origin ride a keep-alive
    // connection and are served in order, so the second retry always finds
    // `resolvedAt` already set and is refused by the codec's fence — a
    // read-then-check, which only rejects a write it has already SEEN.
    //
    // Kept anyway, with the honest title: it pins the end-to-end single-use
    // property at the wire, which is the peer-visible contract. The CAS's
    // genuinely-concurrent path is witnessed where it can be driven directly —
    // `eng1-approval-gate-atomicity.test.ts` and `rfc0093-approval-gate.test.ts`
    // race two callers at the storage layer. Recorded in ADR 0553 § P2 rather
    // than left as a green test implying coverage it does not have.
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const state = first.result?.requestState;
    const params = { name: TOOL, arguments: {}, requestState: state, inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } } };
    const [a, b] = await Promise.all([rpc('tools/call', params, HDR), rpc('tools/call', params, HDR)]);
    const completed = [a, b].filter((r) => r.result?.resultType === 'complete');
    const refused = [a, b].filter((r) => r.error?.code === -32602);
    expect(completed.length, `exactly one retry may resolve the gate; got ${JSON.stringify([a, b])}`).toBe(1);
    expect(refused.length).toBe(1);
  });

  it('a requestState minted for ANOTHER principal is refused', async () => {
    // The binding that stops an authenticated tenant advancing another
    // tenant's gate by observing one `requestState`. Same tool, same digest,
    // different caller.
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const state = first.result?.requestState;
    const mine = cookie;
    cookie = ''; // a cookie-less request mints a DIFFERENT session principal
    const theirs = await rpc('tools/call', {
      name: TOOL,
      arguments: {},
      requestState: state,
      inputResponses: { [key]: { action: 'accept', content: { name: 'Mallory' } } },
    }, HDR);
    cookie = mine;
    expect(theirs.error?.code).toBe(-32602);
    // And the gate is still open for its rightful owner — the refusal did not
    // consume the interrupt, which would have been a denial-of-service dressed
    // as a security check.
    const ok = await rpc('tools/call', {
      name: TOOL,
      arguments: {},
      requestState: state,
      inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } },
    }, HDR);
    expect(ok.result?.resultType).toBe('complete');
  });

  it('a requestState minted for ANOTHER request digest is refused', async () => {
    // The binding that stops a state issued for a harmless tool from resolving
    // the gate of an effectful one. Same principal, same run, different args.
    const first = await rpc('tools/call', { name: TOOL, arguments: {} }, HDR);
    const key = Object.keys(first.result?.inputRequests as Record<string, unknown>)[0]!;
    const state = first.result?.requestState;
    const wrong = await rpc('tools/call', {
      name: TOOL,
      arguments: { unexpected: 'argument' },
      requestState: state,
      inputResponses: { [key]: { action: 'accept', content: { name: 'Ada' } } },
    }, HDR);
    expect(wrong.error?.code).toBe(-32602);
  });
});

// ─────────────────────────────────────────────────────────────────
// RFC 0199 §D.2 (ADR 0753 P2) — form mode refuses what MCP forbids. Binds every
// host with an MCP mount (RFC §C6): a nested schema is invalid MCP, and a
// password/writeOnly field is a secret that MUST NOT be collected in form mode.
// ─────────────────────────────────────────────────────────────────
describe('RFC 0199 §D.2(d) — no form mode for a nested or sensitive schema', () => {
  const NESTED = `mrtr_nested_${Date.now()}`;
  const SECRET = `mrtr_secret_${Date.now()}`;

  async function registerAsk(tool: string, requestedSchema: Record<string, unknown>): Promise<void> {
    const reg = await fetch(`${BASE}/v1/host/openwop-app/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: `mcp.mrtr.${tool}`,
        nodes: [
          { nodeId: 'expose', typeId: 'core.openwop.mcp.expose-tool', config: { name: tool, description: 'form-mode probe', inputSchema: { type: 'object', properties: {} } } },
          { nodeId: 'ask', typeId: 'core.openwop.mcp.handle-elicitation', config: { message: 'Tell me', requestedSchema } },
        ],
        edges: [{ edgeId: 'expose-to-ask', sourceNodeId: 'expose', targetNodeId: 'ask' }],
      }),
    });
    expect([200, 201], `workflow registration failed: ${await reg.clone().text()}`).toContain(reg.status);
  }

  beforeAll(async () => {
    await registerAsk(NESTED, { type: 'object', properties: { address: { type: 'object', properties: { street: { type: 'string' } } } } });
    await registerAsk(SECRET, { type: 'object', properties: { apiKey: { type: 'string', format: 'password' } } });
  });

  for (const [label, tool] of [['nested', () => NESTED], ['format: password', () => SECRET]] as const) {
    it(`a ${label} schema is answered isError, never an elicitation in form mode`, async () => {
      const r = await rpc('tools/call', { name: tool(), arguments: {} }, { clientCapabilities: { elicitation: { form: {}, url: {} } }, mcpName: tool() });
      expect(r.status, JSON.stringify(r.error)).toBe(200);
      expect(r.result?.inputRequests).toBeUndefined();
      expect(r.result?.resultType).toBe('complete');
      expect(r.result?.isError).toBe(true);
      expect(JSON.stringify(r.result)).not.toContain('"mode":"form"');
    });
  }
});

describe('RFC 0199 §D.2 — elicitationPlan (the one decision every answer path takes)', () => {
  const base = { interruptId: 'i', runId: 'r', nodeId: 'n', token: 't', createdAt: '2026-09-26T00:00:00Z' };
  const cred = { ...base, kind: 'credential' as const, data: { provider: 'slack', scopes: ['chat:write'], reason: 'missing', connectUrl: 'https://host.example/c/r/n' } };

  it('credential + client declared URL mode → URL mode carrying connectUrl', () => {
    expect(elicitationPlan(cred, { elicitation: { url: {} } })).toEqual({ mode: 'url', message: 'Authorize slack', url: 'https://host.example/c/r/n' });
  });

  it('credential + form-only (or no) elicitation → isError, NEVER form (§D.2(b))', () => {
    expect(elicitationPlan(cred, { elicitation: {} }).mode).toBe('refuse');
    expect(elicitationPlan(cred, { elicitation: { form: {} } }).mode).toBe('refuse');
    expect(elicitationPlan(cred, {}).mode).toBe('refuse');
  });

  it('credential with a non-https connectUrl is refused even to a URL-capable client', () => {
    expect(elicitationPlan({ ...cred, data: { ...cred.data, connectUrl: 'http://host.example/c' } }, { elicitation: { url: {} } }).mode).toBe('refuse');
  });

  it('isFormSafeSchema: flat primitives, enums and string multi-selects pass; nesting, arrays of objects and secrets fail', () => {
    expect(isFormSafeSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' }, c: { type: 'boolean' }, d: { type: 'string', enum: ['x', 'y'] } } })).toBe(true);
    expect(isFormSafeSchema({ type: 'object', properties: { m: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } } } })).toBe(true);
    expect(isFormSafeSchema({ type: 'object', properties: {} })).toBe(true);
    expect(isFormSafeSchema({ type: 'object', properties: { o: { type: 'object', properties: {} } } })).toBe(false);
    expect(isFormSafeSchema({ type: 'object', properties: { l: { type: 'array', items: { type: 'object' } } } })).toBe(false);
    expect(isFormSafeSchema({ type: 'object', properties: { p: { type: 'string', format: 'password' } } })).toBe(false);
    expect(isFormSafeSchema({ type: 'object', properties: { w: { type: 'string', writeOnly: true } } })).toBe(false);
    expect(isFormSafeSchema({ type: 'string' })).toBe(false);
  });
});
