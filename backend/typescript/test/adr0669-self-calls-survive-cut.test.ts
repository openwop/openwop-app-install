import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { dispatchSubRun } from '../src/subruns/subRunDispatcher.js';
import { createSelfHttpBridge } from '../src/messaging/bridge.js';
import type { ChatIngressEnvelope } from '../src/messaging/types.js';
import { openStorage } from '../src/storage/index.js';
import { advertisedPath, runLinks, newestServedVersion, selfCallHeaders, protocolVersions, VENDOR_ROOT } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0669 rehearsal: the host's calls TO ITSELF survive the cut.
 *
 * The retired host answers every inbound `/v1/...` with 410. The
 * sub-run dispatcher (an LLM tool call invoking a saved workflow) reaches this
 * same host over HTTP, and it used to address `/v1/runs`. So on retirement day
 * every sub-workflow would have failed with `sub_run_create_failed: 410`, while
 * every other rehearsal leg stayed green, because none of them went through a
 * self-call.
 *
 * The messaging bridge has the same shape: an inbound chat message starts a run
 * through `POST /runs` on this host.
 *
 * This drives the real dispatcher and the real bridge against a real booted
 * host. Each leg was paired with a pre-cut control until ADR 0812 P3c removed
 * major 1; the legs still assert the run's OUTPUT, not only that a call returned.
 *
 * Tracker TST-BGF-4. Red when: the sub-run dispatcher or the bridge addresses
 * `/v1/runs`; `selfCallHeaders` names a major the host does not serve;
 * `advertisedPath` stops returning null for an operation with no v2 address;
 * `runLinks` hands out a bare id.
 *
 * DOUBLE GUARD (vendor leg): `advertisedPath`'s `isVendorPath` early return is
 * shadowed by `isV2MountedPath`, because the v2 path manifest declares a `/host`
 * first segment, so `${VENDOR_ROOT}/mcp` is a mounted path too. Only a sabotage of
 * BOTH lines reds the vendor leg (probe `sc-vendor-both-r2`).
 *
 * CEILING (derivation leg): with one served major, `newestServedVersion()` and the
 * literal `'2.0'` are the same value, so "derived, not restated" cannot be
 * witnessed until a second major is served. The leg still reds when the self-call
 * header names a major the host does not serve.
 */
let server: Server;
let base = '';
const saved = { base: process.env.OPENWOP_INTERNAL_BASE_URL };
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  process.env.OPENWOP_INTERNAL_BASE_URL = base;
}, 120_000);
afterAll(async () => {
  if (saved.base === undefined) delete process.env.OPENWOP_INTERNAL_BASE_URL; else process.env.OPENWOP_INTERNAL_BASE_URL = saved.base;
  await new Promise<void>((r) => server.close(() => r()));
});

async function subRun() {
  // `conformance-identity` echoes input.payload to its outputs, so the leg also
  // proves the child's OUTPUT is read back off the v2 event log, not just a status.
  return dispatchSubRun({ workflowId: 'conformance-identity', inputs: { payload: { marker: 'adr0669-self-call' } }, budgetMs: 20_000, tenantId: 'default' });
}

describe('ADR 0669 — the host reaches itself after the cut', () => {
  it('RETIRED: a sub-run dispatched to this host completes, and its output comes back', async () => {
    const r = await subRun();
    expect(r, `RETIRED: ${JSON.stringify(r)}`).toMatchObject({ status: 'completed' });
    expect(r.runId).not.toBe('');
    expect(JSON.stringify(r.status === 'completed' ? r.output : null), 'RETIRED: the echoed payload').toContain('adr0669-self-call');
  }, 60_000);
});

describe('ADR 0669 — the messaging bridge starts runs after the cut', () => {
  it('RETIRED: an inbound message starts a run on this host, and no self-call names /v1', async () => {
    const calls: Array<{ path: string; status: number }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const res = await fetch(url, init);
      calls.push({ path: new URL(url).pathname, status: res.status });
      return res;
    };
    const bridge = createSelfHttpBridge({
      storage: await openStorage('memory://'), baseUrl: base, bearer: 'dev-token', defaultWorkflowId: 'conformance-noop', fetchImpl,
      pollIntervalMs: 10, timeoutMs: 5_000,
    });
    const envelope: ChatIngressEnvelope = {
      channel: 'signal', platformMessageId: 'm1', conversationId: 'c1', peerId: 'p', text: 'hi', timestamp: '2026-09-30T00:00:00Z',
    };
    const out = await bridge.onInbound({
      device: { relayId: 'rl', tenantId: 'default', channel: 'signal' },
      envelope,
      sessionKey: 'signal:c1',
    });
    expect(out ? out.runId : undefined, `RETIRED: calls ${JSON.stringify(calls)}`).toBeTruthy();
    // The detached reply poll makes its own self-calls (`GET /runs/<id>`); wait for
    // one so the "/v1" assertion covers the poll, not only the create.
    await vi.waitFor(() => expect(calls.some((c) => c.path.startsWith('/runs/'))).toBe(true), { timeout: 5_000, interval: 10 });
    expect(calls.filter((c) => c.path.startsWith('/v1')), 'RETIRED: self-calls on /v1').toEqual([]);
  }, 60_000);
});

describe('ADR 0669 — what a response ADVERTISES follows the cut (advertisedPath / runLinks)', () => {
  const RID = 'run-0123456789abcdef';
  it('no response hands out a /v1 address', () => {
    expect(advertisedPath('/runs/r1')).toBe('/runs/r1');
    // ...and its unversioned address names the run by its TENANT-BOUND id: a bare
    // id there is refused 400, so a bare link is a dead link. The id must be long
    // enough to bind (16+), or this would pass on a bare id.
    const bound = `https://h/runs/${encodeURIComponent(`acme/${RID}`)}`;
    expect(runLinks('https://h', RID, 'acme')).toEqual({ statusUrl: bound, eventsUrl: `${bound}/events` });
  });
  it('an operation with no v2 address is null, never advertised dead', () => {
    expect(advertisedPath('/packs')).toBeNull();
  });
  it('a host extension is always its unversioned vendor path', () => {
    expect(advertisedPath(`${VENDOR_ROOT}/mcp`)).toBe(`${VENDOR_ROOT}/mcp`);
  });
  it('the self-call version is DERIVED: the newest served, so the next major needs no edit', () => {
    expect(newestServedVersion()).toBe(protocolVersions().at(-1));
    expect(selfCallHeaders()['OpenWOP-Version']).toBe(newestServedVersion());
  });
});
