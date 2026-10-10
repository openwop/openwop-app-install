import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { dispatchSubRun } from '../src/subruns/subRunDispatcher.js';
import { createSelfHttpBridge } from '../src/messaging/bridge.js';
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
  {
    const side = 'RETIRED';
    it(`${side}: a sub-run dispatched to this host completes, and its output comes back`, async () => {
      const r = await subRun();
      expect(r, `${side}: ${JSON.stringify(r)}`).toMatchObject({ status: 'completed' });
      expect(r.runId).not.toBe('');
      expect(JSON.stringify(r.status === 'completed' ? r.output : null), `${side}: the echoed payload`).toContain('adr0669-self-call');
    }, 60_000);
  }
});

/** The bridge's own storage seams, stubbed: this leg is about its HTTP self-calls. */
function bridgeStorage() {
  return {
    listMessagingRoutingRules: async () => [],
    listMessagingTurns: async () => [],
    appendMessagingTurn: async () => {},
    listMessagingIdentities: async () => [],
    listMessagingSessions: async () => [],
    getRelayDevice: async () => null,
    enqueueRelayOutbound: async () => {},
    appendDeliveryLog: async () => {},
  } as never;
}

describe('ADR 0669 — the messaging bridge starts runs after the cut', () => {
  {
    const side = 'RETIRED';
    it(`${side}: an inbound message starts a run on this host, and no self-call names /v1`, async () => {
      const calls: Array<{ path: string; status: number }> = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const res = await fetch(url, init);
        calls.push({ path: new URL(url).pathname, status: res.status });
        return res;
      }) as typeof fetch;
      {
        const bridge = createSelfHttpBridge({
          storage: bridgeStorage(), baseUrl: base, bearer: 'dev-token', defaultWorkflowId: 'conformance-noop', fetchImpl,
          pollIntervalMs: 50, timeoutMs: 200,
        } as never);
        const out = await bridge.onInbound({
          device: { relayId: 'rl', tenantId: 'default', channel: 'signal' },
          envelope: { channel: 'signal', platformMessageId: 'm1', conversationId: 'c1', peerId: 'p', text: 'hi', timestamp: '2026-09-30T00:00:00Z' } as never,
          sessionKey: 'signal:c1',
        });
        expect(out && (out as { runId?: string }).runId, `${side}: calls ${JSON.stringify(calls)}`).toBeTruthy();
        expect(calls.filter((c) => c.path.startsWith('/v1')), `${side}: self-calls on /v1`).toEqual([]);
      }
    }, 60_000);
  }
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
