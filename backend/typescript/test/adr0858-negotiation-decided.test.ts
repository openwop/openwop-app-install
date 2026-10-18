/**
 * ADR 0858 P4 — `negotiation.decided` on every negotiation outcome, and the
 * major-2-only A2A version rules (`spec/v2/core/interop.md` §"Negotiation is a
 * protocol", §"Legacy profiles are absent").
 *
 * Driven end to end the way the corpus drives it: the §22/§23 invoke seams make
 * the host's REAL A2A / MCP client negotiate with a peer this file owns, the seam
 * names the run that recorded the decision, and the event is read back on the
 * normative `GET /runs/{runId}/events/poll`. Every leg checks the payload
 * against the vendored closed schema and checks that the peer origin appears
 * NOWHERE in clear — only its SHA-256.
 *
 * Every host is major-2-only since ADR 0812 P3c, so there is no version between
 * the floor and `preferredVersion`: no downgrade can happen, and the overlap-host
 * downgrade leg went with major 1.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createApp } from '../src/index.js';
import { _resetMcpNegotiation } from '../src/host/mcpClient.js';
import { MCP_CURRENT_VERSION, MCP_LEGACY_VERSION, mcpMinimumRevision } from '../src/host/mcpProfile.js';
import { V2_PROJECT_A2A, _setV2ProjectA2aForTest } from '../src/host/a2aProfile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

let server: Server;
let base = '';

const ENV: Record<string, string> = {
  OPENWOP_STORAGE_DSN: 'memory://',
  OPENWOP_AUTH_DISABLE_COOKIES: 'true',
  OPENWOP_TEST_SEAM_ENABLED: 'true',
  OPENWOP_A2A_SERVER_ENABLED: 'true',
  OPENWOP_MCP_SERVER_ENABLED: 'true',
  OPENWOP_WEBHOOK_ALLOW_PRIVATE: 'true',
};
const saved = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved.set(k, process.env[k]); process.env[k] = v; }
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => { _resetMcpNegotiation(); _setV2ProjectA2aForTest(undefined); });

/** `v1Retired()` is read at call time, so a leg can choose the host it measures. */

const validatePayload = (() => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'schemas', 'v2', 'run-event-payloads.schema.json'), 'utf8')) as { $defs: Record<string, unknown> };
  const def = doc.$defs['negotiationDecided'];
  if (!def) throw new Error('negotiationDecided payload schema missing — every validation below would be vacuous');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  const fn = ajv.compile(def as Record<string, unknown>);
  return (p: unknown): string[] => (fn(p) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));
})();

// ── peers ───────────────────────────────────────────────────────────────────
interface Hit { method: string; path: string; version: string | undefined }

/** A raw A2A peer speaking `versions` (a 1.0 card when it speaks 1.0, else a 0.3 card). */
async function a2aPeer(versions: readonly string[]): Promise<{ url: string; hits: Hit[]; stop(): Promise<void> }> {
  const hits: Hit[] = [];
  let url = '';
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', version: req.headers['a2a-version'] as string | undefined });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') {
        res.end(JSON.stringify(versions.includes('1.0')
          ? { name: 'peer', version: '1', supportedInterfaces: versions.map((v) => ({ url: `${url}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: v })), capabilities: {}, skills: [] }
          : { name: 'peer', version: '0.3.0', protocolVersion: '0.3', url: `${url}/rpc`, capabilities: {}, skills: [] }));
        return;
      }
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: unknown };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: { id: 't1', contextId: 'c1', kind: 'task', status: { state: 'completed' } } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, hits, stop: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A raw current-profile MCP peer: `-32022` naming `revisions` for anything else. */
async function mcpPeer(revisions: readonly string[]): Promise<{ url: string; hits: Hit[]; stop(): Promise<void> }> {
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: unknown; method?: string };
      const revision = req.headers['mcp-protocol-version'] as string | undefined;
      hits.push({ method: String(rpc.method), path: req.url ?? '', version: revision });
      res.setHeader('content-type', 'application/json');
      if (revision !== undefined && !revisions.includes(revision)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32022, message: 'unsupported', data: { supported: [...revisions], requested: revision } } }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], isError: false } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, hits, stop: () => new Promise<void>((r) => srv.close(() => r())) };
}

// ── helpers ─────────────────────────────────────────────────────────────────
async function invoke(protocol: 'a2a' | 'mcp', body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/conformance/seams/sample/${protocol}/invoke`, { method: 'POST', headers: V2, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function runIdOf(json: Record<string, unknown>): string {
  const id = json['runId'] ?? (json['details'] as Record<string, unknown> | undefined)?.['runId'];
  expect(typeof id, `the seam must name the run that recorded the decision: ${JSON.stringify(json)}`).toBe('string');
  return String(id);
}

async function decided(runId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2 });
  expect(res.status, `${runId}: ${await res.clone().text()}`).toBe(200);
  const events = ((await res.json()) as { events?: Array<{ type?: string; payload?: Record<string, unknown> }> }).events ?? [];
  return events.filter((e) => e.type === 'negotiation.decided').map((e) => e.payload ?? {});
}

/** Schema-valid, digested peer, and the clear origin NOWHERE in the event. */
function assertContentFree(payloads: Array<Record<string, unknown>>, peerUrl: string): void {
  expect(payloads.length, 'no negotiation.decided on the run').toBeGreaterThan(0);
  const origin = new URL(peerUrl).origin;
  for (const p of payloads) {
    expect(validatePayload(p)).toEqual([]);
    // RFC 0242 §A.2 — every exchange here names a version, so `requested` MUST be set.
    expect(typeof p['requested'], `RFC 0242 §A.2: requested missing on ${JSON.stringify(p)}`).toBe('string');
    expect(p['peerDigest']).toBe(createHash('sha256').update(origin, 'utf8').digest('hex'));
    const flat = JSON.stringify(p);
    expect(flat).not.toContain(new URL(peerUrl).host);
    expect(flat).not.toContain('127.0.0.1');
  }
}

// ── A2A ─────────────────────────────────────────────────────────────────────
describe('A2A — the client records every outcome (switch ON: the v2 floor binds)', () => {
  // The floor rule binds once the advert names a `minimumVersion`, i.e. with the
  // switch. The global afterEach restores the shipped (off) value.
  beforeEach(() => { _setV2ProjectA2aForTest(true); });

  it('accepted: the preferred version, recorded with the version used', async () => {
    const peer = await a2aPeer(['1.0', '0.3']);
    try {
      const r = await invoke('a2a', { peerUrl: peer.url, authenticated: true });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json['negotiatedVersion']).toBe('1.0');
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ protocol: 'a2a', outcome: 'accepted', version: '1.0', requested: '1.0', reason: 'ok', floor: '1.0' });
    } finally { await peer.stop(); }
  });

  it('refused: a peer offering only 0.3 is below the floor — fail closed, nothing sent below it', async () => {
    const peer = await a2aPeer(['0.3']);
    try {
      const r = await invoke('a2a', { peerUrl: peer.url, authenticated: true, peerOffersOnly: '0.3' });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json['code'] ?? r.json['error']).toBe('interop_version_unsupported');
      expect(peer.hits.filter((h) => h.method !== 'GET'), 'no RPC may reach a below-floor peer').toEqual([]);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      const last = events.at(-1)!;
      expect(last).toMatchObject({ protocol: 'a2a', outcome: 'refused', reason: 'below-floor', floor: '1.0' });
      expect(last['version'], 'a refusal decides no version').toBeUndefined();
    } finally { await peer.stop(); }
  });

  it('refused: an UNAUTHENTICATED exchange is not lowered either', async () => {
    const peer = await a2aPeer(['0.3']);
    try {
      const r = await invoke('a2a', { peerUrl: peer.url, authenticated: false, peerOffersOnly: '0.3' });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ outcome: 'refused' });
    } finally { await peer.stop(); }
  });

});

/** The v2 discovery document's `a2a` record, if any. */
async function v2A2a(): Promise<unknown> {
  const res = await fetch(`${base}/.well-known/openwop`, { headers: V2 });
  return ((await res.json()) as Record<string, unknown>)['a2a'];
}

async function cardGet(headers: Record<string, string> = {}): Promise<{ status: number; card: Record<string, unknown> }> {
  const res = await fetch(`${base}/.well-known/agent-card.json`, { headers });
  return { status: res.status, card: (await res.json()) as Record<string, unknown> };
}

async function rpc(version?: string): Promise<{ error?: { code?: number } }> {
  const res = await fetch(`${base}/host/openwop-app/a2a`, {
    method: 'POST',
    headers: { ...AUTH, ...(version ? { 'A2A-Version': version } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'message/send', params: {} }),
  });
  return (await res.json()) as { error?: { code?: number } };
}

describe('A2A client, switch OFF (as shipped) — a 0.3-only peer is still reached, and still recorded', () => {
  // The control the ADR 0812 P3c rebase exposed: the outbound refusal first keyed
  // on "v1 retired", which the fold made always true, silently ending 0.3 support.
  it('an UNAUTHENTICATED exchange is accepted at 0.3, recorded with the version used — never silent', async () => {
    // (An AUTHENTICATED one is never lowered: the pre-existing RFC 0152 rule.)
    const peer = await a2aPeer(['0.3']);
    try {
      const r = await invoke('a2a', { peerUrl: peer.url, peerOffersOnly: '0.3' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json['negotiatedVersion']).toBe('0.3');
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ protocol: 'a2a', outcome: 'accepted', version: '0.3' });
    } finally { await peer.stop(); }
  });
});

describe('A2A inbound, switch OFF (as shipped) — today\'s behaviour, exactly, for live 0.3 clients', () => {
  it('ships OFF', () => {
    expect(V2_PROJECT_A2A, 'flipping V2_PROJECT_A2A is a deliberate, announced change (ADR 0858 P4)').toBe(false);
  });

  it('no v2 a2a advert, a header-less card GET is the 0.3 card, and an explicit 0.3 card is served', async () => {
    expect(await v2A2a(), 'the claim stays off while the behaviour does').toBeUndefined();
    const headerless = await cardGet();
    expect(headerless.status).toBe(200);
    expect(headerless.card['protocolVersion'], 'header-less = 0.3 (RFC 0152 receiver rule)').toBe('0.3');
    expect(typeof headerless.card['url']).toBe('string');
    const explicit = await cardGet({ 'A2A-Version': '0.3' });
    expect(explicit.status).toBe(200);
    expect(explicit.card['protocolVersion']).toBe('0.3');
  });

  it('an explicit or absent 0.3 JSON-RPC request is NOT refused as a version', async () => {
    expect((await rpc('0.3')).error?.code).not.toBe(-32009);
    expect((await rpc()).error?.code).not.toBe(-32009);
  });
});

describe('A2A inbound, switch ON — the v2 rules (steward ruling, openwop-5e), together with the advert', () => {
  it('the advert appears with the switch, and names 1.0 only', async () => {
    _setV2ProjectA2aForTest(true);
    const a2a = (await v2A2a()) as Record<string, unknown> | undefined;
    expect(a2a, 'switch on ⇒ the a2a record is projected').toBeTruthy();
    expect(a2a!['versions']).toEqual(['1.0']);
    expect(a2a!['minimumVersion']).toBe('1.0');
  });

  it('a header-less card GET is the preferredVersion (1.0) card, with no 0.3 interface', async () => {
    _setV2ProjectA2aForTest(true);
    const { status, card } = await cardGet();
    expect(status).toBe(200);
    expect(card['url'], 'the 0.3 top-level shape').toBeUndefined();
    expect(card['protocolVersion']).toBeUndefined();
    expect(((card['supportedInterfaces'] ?? []) as Array<{ protocolVersion?: string }>).map((i) => i.protocolVersion)).toEqual(['1.0']);
  });

  it('an explicit A2A-Version: 0.3 card GET is refused interop_version_unsupported, not downgraded', async () => {
    _setV2ProjectA2aForTest(true);
    const { status, card } = await cardGet({ 'A2A-Version': '0.3' });
    expect(status).toBe(400);
    expect(JSON.stringify(card)).toContain('interop_version_unsupported');
  });

  it('an explicit A2A-Version: 0.3 JSON-RPC request is refused VersionNotSupportedError', async () => {
    _setV2ProjectA2aForTest(true);
    const body = await rpc('0.3');
    expect(body.error?.code, JSON.stringify(body)).toBe(-32009);
  });
});

// ── MCP ─────────────────────────────────────────────────────────────────────
describe('MCP — the client records every outcome', () => {
  it('accepted: the current revision', async () => {
    const peer = await mcpPeer([MCP_CURRENT_VERSION, MCP_LEGACY_VERSION]);
    try {
      const r = await invoke('mcp', { serverUrl: peer.url });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ protocol: 'mcp', outcome: 'accepted', version: MCP_CURRENT_VERSION, requested: MCP_CURRENT_VERSION, reason: 'ok', floor: mcpMinimumRevision() });
    } finally { await peer.stop(); }
  });

  it('downgraded (authenticated): recorded as accepted at the LOWER revision actually used', async () => {
    const peer = await mcpPeer([MCP_LEGACY_VERSION]);
    try {
      const r = await invoke('mcp', { serverUrl: peer.url });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json['negotiatedVersion']).toBe(MCP_LEGACY_VERSION);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      // RFC 0242 §A.3 — the downgrade is VISIBLE: accepted, with version ≠ requested.
      expect(events.at(-1)).toMatchObject({ outcome: 'accepted', version: MCP_LEGACY_VERSION, requested: MCP_CURRENT_VERSION });
    } finally { await peer.stop(); }
  });

  it('refused: an UNAUTHENTICATED exchange is not lowered below preferredVersion', async () => {
    const peer = await mcpPeer([MCP_LEGACY_VERSION]);
    try {
      const r = await invoke('mcp', { serverUrl: peer.url, authenticated: false });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(peer.hits.map((h) => h.version), 'nothing may be sent at the lower revision').not.toContain(MCP_LEGACY_VERSION);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ outcome: 'refused', reason: 'unauthenticated' });
    } finally { await peer.stop(); }
  });

  it('refused: a server offering only a revision under the floor', async () => {
    const peer = await mcpPeer(['2024-11-05']);
    try {
      const r = await invoke('mcp', { serverUrl: peer.url });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      const events = await decided(runIdOf(r.json));
      assertContentFree(events, peer.url);
      expect(events.at(-1)).toMatchObject({ outcome: 'refused', reason: 'below-floor' });
    } finally { await peer.stop(); }
  });
});
