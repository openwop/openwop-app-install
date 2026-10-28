/**
 * ADR 0826 D5 — revocation is a kill switch that works WITHOUT a restart, on both
 * dispatch placements, for agents, and across instances.
 *
 * Before this ADR a revocation (ADR 0555) was evaluated only when a pack was
 * IMPORTED: a node pack already loaded kept dispatching after `revokePack`, and
 * another instance never even saw the row (its cache reloaded only on writes made
 * by itself). /architect A1 also caught the first draft's placement: a check in
 * the loader's `execute` wrapper is never reached on the ISOLATED lane, which goes
 * straight to the adapter — so this file runs the revoked node in BOTH placements.
 * The cross-instance case drives the product's own refresh `setInterval` with
 * fake timers (no wall-clock wait); the run-settle polls in `runEcho` remain an
 * honest ceiling (no hook to await a run's terminal state).
 *
 * Tracker TST-BMK-3. Sabotage-witnessed (w62): red when dispatch ignores a
 * revoked origin, the agent registry or chain gallery keeps a revoked pack, the
 * refresh tick stops reloading, or a reload stops notifying the trust cache.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import { classifyPackDir, __resetPackTrustCachesForTests } from '../src/host/packTrust.js';
import {
  revokePack, unrevokePack, isPackRevoked, loadPackRevocations, startPackRevocationRefresh,
  __stopPackRevocationRefresh, __resetPackRevocationCacheForTests, __clearPackRevocations,
} from '../src/host/packRevocations.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getChain, listChains } from '../src/host/workflowChainPackLoader.js';

const PACK = 'community.test.revoke0826';
const ECHO = `${PACK}.echo`;
// Unversioned protocol paths + `OpenWOP-Version: 2` (ADR 0642: no new /v1 call sites).
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'openwop-version': '2' };

let server: http.Server;
let BASE: string;
let root: string;
let packDir: string;

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function runEcho(workflowId: string, mode: 'fake' | 'off'): Promise<{ status: string; errorCode?: string }> {
  const prev = process.env.OPENWOP_PACK_ISOLATION;
  if (mode === 'fake') process.env.OPENWOP_PACK_ISOLATION = 'fake';
  else delete process.env.OPENWOP_PACK_ISOLATION;
  try {
    await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n1', typeId: ECHO }], edges: [] }) });
    const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: '_anon' }) });
    expect(create.status).toBe(201);
    let status = 'pending';
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 25));
      status = (await api<{ status: string }>(`/runs/${create.body.runId}`)).body.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) break;
    }
    const events = (await api<{ events?: Array<{ type?: string; payload?: { error?: { code?: string } } }> }>(`/runs/${create.body.runId}/debug-bundle`)).body.events ?? [];
    const failed = events.find((e) => e.type === 'node.failed');
    return { status, ...(failed?.payload?.error?.code ? { errorCode: failed.payload.error.code } : {}) };
  } finally {
    if (prev === undefined) delete process.env.OPENWOP_PACK_ISOLATION;
    else process.env.OPENWOP_PACK_ISOLATION = prev;
  }
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_PACK_ISOLATION;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

  // A REAL operator-trusted pack (marked the way the installer marks one), loaded
  // through the real loader — so the module carries a real `packOrigin`.
  root = mkdtempSync(join(tmpdir(), 'owp-0826-'));
  packDir = join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'pack.json'), JSON.stringify({ name: PACK, version: '1.0.0', nodes: [{ typeId: ECHO, version: '1.0.0' }], runtime: { format: 'esm', entry: './index.mjs' } }));
  writeFileSync(join(packDir, 'index.mjs'), `export const nodes = { ${JSON.stringify(ECHO)}: async () => ({ status: 'success', outputs: { ran: true } }) };\n`);
  const hash = (f: string) => createHash('sha256').update(readFileSync(join(packDir, f))).digest('hex');
  writeFileSync(join(packDir, '.openwop-installed.json'), JSON.stringify({
    name: PACK, version: '1.0.0', integrity: 'sha256-fixture', publicKeyRef: 'fixture', registry: 'https://packs.example.test',
    installedAt: new Date(0).toISOString(), contentHashes: { 'pack.json': hash('pack.json'), 'index.mjs': hash('index.mjs') },
  }));
  __resetPackTrustCachesForTests();
  await loadPackFromManifest(packDir);
}, 60_000);

afterAll(async () => {
  __stopPackRevocationRefresh();
  await __clearPackRevocations();
  await new Promise<void>((res) => server.close(() => res()));
  rmSync(root, { recursive: true, force: true });
});

describe('ADR 0826 D5 — a revocation stops a LOADED pack at dispatch, in both placements', () => {
  it('CONTROL: the loaded pack runs, in-process and isolated', async () => {
    expect((await runEcho('rv0826.ctl.in', 'off')).status).toBe('completed');
    expect((await runEcho('rv0826.ctl.iso', 'fake')).status).toBe('completed');
  }, 30_000);

  it('revoked ⇒ the node fails `pack_revoked` with NO restart — in-process AND isolated (/architect A1)', async () => {
    await revokePack({ packName: PACK, version: '1.0.0', by: 'test', reason: 'fixture compromise' });
    try {
      for (const mode of ['off', 'fake'] as const) {
        const r = await runEcho(`rv0826.revoked.${mode}`, mode);
        expect(r.status, mode).toBe('failed');
        // Major 2 namespaces a host-specific code (`openwop-app.pack_revoked`).
        expect(r.errorCode, mode).toMatch(/(^|\.)pack_revoked$/);
      }
    } finally {
      await unrevokePack(PACK, '1.0.0');
    }
    // Un-revoking restores dispatch — the kill switch is reversible.
    expect((await runEcho('rv0826.restored', 'off')).status).toBe('completed');
  }, 60_000);
});

describe('ADR 0826 D5 — a revoked pack AGENT is absent from every lookup', () => {
  it('get / has / resolve / list all stop seeing it; un-revoke restores it', async () => {
    const reg = getAgentRegistry();
    reg.register({ agentId: 'community.test.revoke0826-agents.a', persona: 'A', modelClass: 'general', systemPrompt: 'x', packName: 'community.test.revoke0826-agents', packVersion: '2.0.0', toolAllowlist: [] });
    expect(reg.get('community.test.revoke0826-agents.a')).not.toBeNull();
    await revokePack({ packName: 'community.test.revoke0826-agents', version: '2.0.0', by: 'test', reason: 'kill' });
    try {
      expect(reg.get('community.test.revoke0826-agents.a')).toBeNull();
      expect(reg.has('community.test.revoke0826-agents.a')).toBe(false);
      expect(await reg.resolve('community.test.revoke0826-agents.a')).toBeNull();
      expect(reg.list().map((a) => a.agentId)).not.toContain('community.test.revoke0826-agents.a');
    } finally {
      await unrevokePack('community.test.revoke0826-agents', '2.0.0');
    }
    expect(reg.get('community.test.revoke0826-agents.a')).not.toBeNull();
  });
});

describe('ADR 0826 D5 — a revocation written ELSEWHERE reaches this instance within one tick', () => {
  it('another instance’s write (simulated: this cache never saw it) arrives via the refresh, and clears the trust verdict cache', async () => {
    expect(classifyPackDir(packDir).tier).toBe('operator-trusted'); // cached verdict
    await revokePack({ packName: PACK, version: '1.0.0', by: 'instance-b', reason: 'kill from elsewhere' });
    __resetPackRevocationCacheForTests(); // THIS instance never saw the write
    expect(isPackRevoked(PACK, '1.0.0')).toBe(false);
    __stopPackRevocationRefresh();
    process.env.OPENWOP_PACK_REVOCATION_REFRESH_MS = '1000';
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      startPackRevocationRefresh();
      expect(isPackRevoked(PACK, '1.0.0'), 'nothing before the first tick').toBe(false);
      await vi.advanceTimersByTimeAsync(1000); // one refresh tick
      await vi.waitFor(() => expect(isPackRevoked(PACK, '1.0.0'), 'the poll delivered the other instance’s revocation').toBe(true));
      expect(classifyPackDir(packDir).tier, 'no cached verdict outlived the change').toBe('revoked');
    } finally {
      __stopPackRevocationRefresh();
      vi.useRealTimers();
      delete process.env.OPENWOP_PACK_REVOCATION_REFRESH_MS;
      await unrevokePack(PACK, '1.0.0');
      await loadPackRevocations();
    }
  }, 15_000);
});

describe('ADR 0826 D5 (/architect A10, grade-code correction) — a revoked CHAIN pack leaves the gallery at read time', () => {
  it('getChain / listChains stop seeing its chains without a reload; un-revoke restores them', async () => {
    const some = listChains()[0];
    expect(some, 'the boot loaded at least one chain pack').toBeTruthy();
    const { packName, packVersion, chain } = some!;
    await revokePack({ packName, version: packVersion, by: 'test', reason: 'chain kill' });
    try {
      expect(getChain(chain.chainId)).toBeNull();
      expect(listChains().some((c) => c.packName === packName)).toBe(false);
    } finally {
      await unrevokePack(packName, packVersion);
    }
    expect(getChain(chain.chainId)?.packName).toBe(packName);
  });
});
