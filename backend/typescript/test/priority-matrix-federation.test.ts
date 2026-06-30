/**
 * Priority Matrix federated portfolio (ADR 0061) — unit + route.
 *   - validateBaseUrl rejects SSRF / non-http; addPeer enforces it
 *   - peer CRUD (service) + peer-mutation RBAC (route: non-superadmin → 403)
 *   - buildFederatedPortfolio merges + tags source + ranks + is fail-soft (injected fetcher)
 *   - GET /portfolio/federated with no peers == local-only (all source 'local')
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  validateBaseUrl, addPeer, listPeers, deletePeer, buildFederatedPortfolio, readCapped,
  setPeerCredential, resolvePeerToken, resolvePeerCredential, cachedPeerFetch,
  __resetFederationStore, type FederatedPeer, type PeerFetcher, type PeerFetchResult,
} from '../src/features/priority-matrix/federationService.js';
import { __resetFanoutCache } from '../src/features/priority-matrix/federationCache.js';
import type { PortfolioItem } from '../src/features/priority-matrix/priorityMatrixService.js';

const item = (cardId: string, priority: number, listName = 'L'): PortfolioItem => ({
  listId: 'l1', listName, votingMode: 'single', scoringModel: 'weighted',
  cardId, title: cardId, status: 'New', computedPriority: priority, inListRank: 1,
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
}

describe('federation — readCapped (ADR 0061 #4 streaming cap)', () => {
  it('returns text under the cap and null over it', async () => {
    expect(await readCapped(streamOf('{"items":[]}'), 1000)).toBe('{"items":[]}');
    expect(await readCapped(streamOf('x'.repeat(5000)), 1000)).toBeNull(); // over cap → rejected
    expect(await readCapped(null, 1000)).toBe(''); // no body
  });
});

describe('federation — validateBaseUrl (SSRF)', () => {
  it('rejects loopback / private / non-http and accepts a public https origin', () => {
    expect(() => validateBaseUrl('http://localhost:3000')).toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1')).toThrow();
    expect(() => validateBaseUrl('http://10.0.0.5')).toThrow();
    expect(() => validateBaseUrl('ftp://peer.example.test')).toThrow();
    expect(() => validateBaseUrl('not a url')).toThrow();
    expect(validateBaseUrl('https://peer.example.test/some/path')).toBe('https://peer.example.test'); // origin only
  });
});

describe('federation — peer registry (service)', () => {
  beforeEach(async () => { await __resetFederationStore(); });

  it('adds, lists, and deletes a peer; rejects a private baseUrl', async () => {
    const t = 'tenant-fed-1';
    const peer = await addPeer(t, 'u1', { label: 'East', baseUrl: 'https://east.example.test' });
    expect(peer.baseUrl).toBe('https://east.example.test');
    expect(peer.label).toBe('East');
    expect((await listPeers(t)).map((p) => p.label)).toEqual(['East']);
    await expect(addPeer(t, 'u1', { label: 'Bad', baseUrl: 'http://169.254.169.254' })).rejects.toThrow();
    expect(await deletePeer(t, peer.id)).toBe(true);
    expect(await listPeers(t)).toHaveLength(0);
  });
});

describe('federation — buildFederatedPortfolio (injected fetcher)', () => {
  const peers: FederatedPeer[] = [
    { id: 'peer-a', tenantId: 't', label: 'East', baseUrl: 'https://east.example.test', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'peer-b', tenantId: 't', label: 'West', baseUrl: 'https://west.example.test', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z' },
  ];

  it('merges local + peer items, tags source, ranks by priority, and is fail-soft', async () => {
    const fetcher: PeerFetcher = async (peer) => {
      if (peer.id === 'peer-a') return { ok: true, items: [item('east-top', 9, 'East list')] };
      return { ok: false, error: 'HTTP 503' }; // peer-b is down → fail-soft
    };
    const local = [item('local-mid', 5), item('local-low', 2)];
    const out = await buildFederatedPortfolio(local, peers, 20, { tenantId: 't' }, fetcher);

    // Ranked by raw priority: east-top(9) > local-mid(5) > local-low(2).
    expect(out.items.map((i) => i.cardId)).toEqual(['east-top', 'local-mid', 'local-low']);
    // Sources tagged.
    expect(out.items.find((i) => i.cardId === 'east-top')?.source).toBe('East');
    expect(out.items.find((i) => i.cardId === 'local-mid')?.source).toBe('local');
    // Per-peer status: East ok (1), West failed (reported, not fatal).
    expect(out.peers).toEqual([
      { peerId: 'peer-a', label: 'East', ok: true, count: 1 },
      { peerId: 'peer-b', label: 'West', ok: false, count: 0, error: 'HTTP 503' },
    ]);
  });

  it('respects topN across the merged set', async () => {
    const fetcher: PeerFetcher = async () => ({ ok: true, items: [item('p1', 8), item('p2', 1)] });
    const out = await buildFederatedPortfolio([item('l1', 5)], [peers[0]], 2, { tenantId: 't' }, fetcher);
    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.cardId)).toEqual(['p1', 'l1']); // top-2 by priority
  });

  it('STRAT-3: fans out to peers CONCURRENTLY (bounded), not one-at-a-time, preserving status order', async () => {
    const many: FederatedPeer[] = Array.from({ length: 18 }, (_, i) => ({
      id: `p${i}`, tenantId: 't', label: `L${i}`, baseUrl: `https://p${i}.example.test`, createdBy: 'u', createdAt: '2026-01-01T00:00:00Z',
    }));
    let inFlight = 0;
    let peak = 0;
    const fetcher: PeerFetcher = async (peer) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
      inFlight -= 1;
      return { ok: true, items: [item(`${peer.id}-x`, 1)] };
    };
    const out = await buildFederatedPortfolio([item('l', 5)], many, 100, { tenantId: 't' }, fetcher);

    expect(peak).toBeGreaterThan(1);          // concurrent — a sequential loop would peak at 1 (was ~150s worst case)
    expect(peak).toBeLessThanOrEqual(6);      // bounded by PEER_FETCH_CONCURRENCY (no 18-way burst)
    expect(out.peers).toHaveLength(18);       // every peer attempted, fail-soft
    expect(out.peers.map((p) => p.peerId)).toEqual(many.map((p) => p.id)); // status stays in peer order
  });
});

// ── route: peer-mutation RBAC + federated read with no peers ──
let BASE: string;
let server: http.Server;
let n = 0;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true'; // in-memory per-tenant secret store (ADR 0062 credential tests)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('priority-matrix');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { delete process.env.OPENWOP_BYOK_EPHEMERAL; await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as any };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}

describe('federation — credential resolution precedence (ADR 0062)', () => {
  it('per-user > tenant-shared > env (BYOK-enveloped) + reports identity tier', async () => {
    await __resetFederationStore();
    const t = 'tenant-cred-1';
    process.env.OPENWOP_PM_PEER_TOKEN = 'env-tok';
    try {
      const peer = await addPeer(t, 'owner', { label: 'East', baseUrl: 'https://east.example.test' });
      expect(await resolvePeerToken(peer, { tenantId: t })).toBe('env-tok'); // env fallback
      expect(await resolvePeerCredential(peer, { tenantId: t })).toEqual({ token: 'env-tok', identity: 'env' });
      await setPeerCredential(t, peer.id, 'tenant-tok', 'tenant');
      expect(await resolvePeerToken(peer, { tenantId: t })).toBe('tenant-tok'); // tenant overrides env
      expect(await resolvePeerCredential(peer, { tenantId: t })).toEqual({ token: 'tenant-tok', identity: 'shared' });
      await setPeerCredential(t, peer.id, 'user-tok', 'user', 'u1');
      expect(await resolvePeerToken(peer, { tenantId: t, actingUserId: 'u1' })).toBe('user-tok'); // per-user wins for u1
      expect(await resolvePeerCredential(peer, { tenantId: t, actingUserId: 'u1' })).toEqual({ token: 'user-tok', identity: 'u:u1' });
      expect(await resolvePeerCredential(peer, { tenantId: t, actingUserId: 'u2' })).toEqual({ token: 'tenant-tok', identity: 'shared' }); // u2 → shared
    } finally { delete process.env.OPENWOP_PM_PEER_TOKEN; }
  });
});

describe('federation — fan-out cache (ADR 0061 #3)', () => {
  const peer: FederatedPeer = { id: 'peer-cache', tenantId: 'tc', label: 'East', baseUrl: 'https://east.example.test', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z' };
  beforeEach(() => { __resetFanoutCache(); });

  it('caches a successful peer fetch (single-flight TTL hit): inner runs once', async () => {
    let calls = 0;
    const inner = async (): Promise<PeerFetchResult> => { calls++; return { ok: true, items: [item('a', 9)] }; };
    const a = await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
    const b = await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
    expect(calls).toBe(1); // second call is a cache hit
    expect(a).toEqual(b);
  });

  it('keys on credential identity — one user’s slice is never served to another', async () => {
    await __resetFederationStore();
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    const t = 'tc-leak';
    const p = await addPeer(t, 'owner', { label: 'East', baseUrl: 'https://east.example.test' });
    await setPeerCredential(t, p.id, 'tok-u1', 'user', 'u1'); // u1 has a per-user cred; u2 has none

    // inner tags the slice by the token it actually received, so a leak would be observable.
    const innerFor = (calls: { n: number }) => async (token: string | undefined): Promise<PeerFetchResult> => {
      calls.n++; return { ok: true, items: [item(`slice-${token ?? 'anon'}`, 5)] };
    };
    const c1 = { n: 0 }, c2 = { n: 0 };
    const u1 = await cachedPeerFetch(p, 5, { tenantId: t, actingUserId: 'u1' }, innerFor(c1));
    const u2 = await cachedPeerFetch(p, 5, { tenantId: t, actingUserId: 'u2' }, innerFor(c2));
    // Distinct identities (`u:u1` vs `none`) ⇒ distinct keys ⇒ each inner ran, no cross-serve.
    expect(c1.n).toBe(1); expect(c2.n).toBe(1);
    expect(u1.ok && u1.items[0].cardId).toBe('slice-tok-u1');
    expect(u2.ok && u2.items[0].cardId).toBe('slice-anon');
    // u1 re-reads from cache (no new inner call); still its own slice.
    const u1again = await cachedPeerFetch(p, 5, { tenantId: t, actingUserId: 'u1' }, innerFor(c1));
    expect(c1.n).toBe(1);
    expect(u1again.ok && u1again.items[0].cardId).toBe('slice-tok-u1');
  });

  it('does NOT cache a fail-soft drop (transient peer error re-fetches)', async () => {
    let calls = 0;
    const inner = async (): Promise<PeerFetchResult> => { calls++; return { ok: false, error: 'HTTP 503' }; };
    await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
    await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
    expect(calls).toBe(2); // failures are never sticky
  });

  it('TTL ≤ 0 bypasses the cache entirely', async () => {
    process.env.OPENWOP_PM_FED_CACHE_TTL_MS = '0';
    try {
      let calls = 0;
      const inner = async (): Promise<PeerFetchResult> => { calls++; return { ok: true, items: [item('a', 9)] }; };
      await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
      await cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner);
      expect(calls).toBe(2); // no caching ⇒ every call hits inner
    } finally { delete process.env.OPENWOP_PM_FED_CACHE_TTL_MS; }
  });

  it('rotating a peer credential busts the cached slice (no ≤TTL stale-token serve)', async () => {
    await __resetFederationStore();
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    const t = 'tc-rotate';
    const p = await addPeer(t, 'owner', { label: 'East', baseUrl: 'https://east.example.test' });
    await setPeerCredential(t, p.id, 'tok-v1', 'tenant'); // identity stays 'shared' across the rotation
    let calls = 0;
    const inner = async (): Promise<PeerFetchResult> => { calls++; return { ok: true, items: [item('a', 9)] }; };
    await cachedPeerFetch(p, 5, { tenantId: t }, inner); // warm
    await cachedPeerFetch(p, 5, { tenantId: t }, inner); // cache hit
    expect(calls).toBe(1);
    await setPeerCredential(t, p.id, 'tok-v2', 'tenant'); // rotate ⇒ invalidate this peer's entries
    await cachedPeerFetch(p, 5, { tenantId: t }, inner);
    expect(calls).toBe(2); // re-fetched the rotated token's slice, not the stale 'shared' entry
  });

  it('single-flight coalesces concurrent callers into one inner run', async () => {
    let calls = 0;
    const inner = async (): Promise<PeerFetchResult> => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, items: [item('a', 9)] }; };
    const results = await Promise.all(Array.from({ length: 8 }, () => cachedPeerFetch(peer, 5, { tenantId: 'tc' }, inner)));
    expect(calls).toBe(1); // 8 concurrent callers, one upstream fetch
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('federation — route RBAC', () => {
  it('a plain member cannot add a peer (superadmin only); federated read with no peers is local-only', async () => {
    const c = client();
    const login = await c.post('/v1/host/openwop-app/test/login', { email: `fed-${Date.now()}-${n++}@acme.test` });
    expect(login.status).toBe(201);
    // Non-superadmin add → 403.
    const add = await c.post('/v1/host/openwop-app/priority-matrix/peers', { label: 'X', baseUrl: 'https://x.example.test' });
    expect(add.status).toBe(403);
    // Peer list is empty + readable.
    expect((await c.get('/v1/host/openwop-app/priority-matrix/peers')).body.peers).toEqual([]);
    // Federated portfolio with no peers == local-only (here: no lists ⇒ empty, no peer errors).
    const fed = await c.get('/v1/host/openwop-app/priority-matrix/portfolio/federated');
    expect(fed.status).toBe(200);
    expect(fed.body.peers).toEqual([]);
    expect(Array.isArray(fed.body.items)).toBe(true);
  });

  it('a member sets their OWN peer credential (204) but not the tenant-shared one (403, superadmin)', async () => {
    const tenantId = `org:cred-${Date.now()}-${n++}`;
    const c = client();
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `cred-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
    const peer = await addPeer(tenantId, 'admin', { label: 'East', baseUrl: 'https://east.example.test' });
    const url = `/v1/host/openwop-app/priority-matrix/peers/${encodeURIComponent(peer.id)}/credential`;
    expect((await c.put(url, { token: 'mine', scope: 'user' })).status).toBe(204);   // own cred (c1)
    expect((await c.put(url, { token: 'shared', scope: 'tenant' })).status).toBe(403); // tenant cred = superadmin
  });
});
