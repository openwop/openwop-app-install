/**
 * H25 — `core.conformance.a2a-invoke`, the reserved A2A bridge the
 * `conformance-a2a-task-roundtrip` fixture declares.
 *
 * Black-box against a raw `node:http` A2A peer so the bridge exercises the real
 * `createA2aSurface` client (card discovery, version negotiation, JSON-RPC over
 * the RFC 0093 egress guard) rather than a stub. The thing under test is the
 * REVERSE projection of `spec/v1/a2a-integration.md` §"State projection":
 * a peer state has to become an openwop run disposition, and the two states the
 * corpus calls drift points (#3 `AUTH_REQUIRED`, #4 `REJECTED`) are the two the
 * host cannot express natively.
 *
 * Why this exists at host tier when the conformance suite already covers it:
 * the suite covers it only while the fake peer is running, and the peer being
 * unstarted for months is precisely how these two projections went unmeasured
 * (`conformance/run.ts` never set `OPENWOP_A2A_FAKE_PEER`). A leg that returns
 * early is not a leg that passes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NodeContext } from '../src/executor/types.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import {
  CONFORMANCE_A2A_INVOKE_TYPE_ID,
  registerConformanceA2aInvokeNode,
} from '../src/bootstrap/conformanceA2aInvokeNode.js';

/** The state the peer will report for the next `message/send`. */
let nextState = 'completed';

let server: Server;
let baseUrl: string;

async function readBody(req: IncomingMessage): Promise<{ method: string; id: unknown }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // 0.3-shaped card: the host's client asks for 1.0 first and falls back to
      // the highest mutually-spoken version, which is the negotiation path a
      // real legacy peer puts it on.
      res.end(JSON.stringify({ name: 'peer', version: '0.3.0', protocolVersion: '0.3.0', url: `${baseUrl}/rpc`, capabilities: {} }));
      return;
    }
    if (req.method === 'POST') {
      void readBody(req).then((body) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { id: 'peer-task-1', contextId: 'ctx-1', kind: 'task', status: { state: nextState } },
        }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The peer is on loopback, which the RFC 0093 egress guard refuses by default
  // — the same flag `conformance/run.ts` sets for exactly this reason.
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  registerConformanceA2aInvokeNode();
});

afterAll(async () => {
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  delete process.env.OPENWOP_ENABLE_CONFORMANCE_NODES;
  delete process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ctx = (): NodeContext =>
  ({
    runId: 'run-a2a-invoke',
    nodeId: 'a2a-invoke',
    tenantId: 'default',
    inputs: {},
    config: { skill: 'echo' },
    configurable: {},
    attempt: 1,
    secrets: {},
    // The bridge emits nothing of its own — the peer call and its projection are
    // the whole node — but `NodeContext` requires the emitter, so it is a real
    // (unused) function rather than a cast that hides the requirement.
    async emit() {
      return { eventId: 'e1', sequence: 1 };
    },
  } as NodeContext);

const invoke = (typeId = CONFORMANCE_A2A_INVOKE_TYPE_ID) => {
  const mod = getNodeRegistry().get(typeId);
  if (!mod) throw new Error(`${typeId} is not registered`);
  return mod.execute(ctx());
};

describe('core.conformance.a2a-invoke — registration', () => {
  it('is registered under the reserved spelling — and ONLY that one (H47)', () => {
    // History: the corpus renamed `core.a2a.invoke` → `core.conformance.a2a-invoke`
    // on 2026-08-16, and for a while the gate pinned a suite (and vendored a
    // fixture set) from before that rename, so the bridge answered to BOTH.
    // H47 moved the pin to ^1.136.0 and re-vendored the fixture, so the legacy
    // alias is deleted. Asserting its ABSENCE is the load-bearing half: a
    // registration that quietly comes back would make the deletion untestable.
    expect(getNodeRegistry().get(CONFORMANCE_A2A_INVOKE_TYPE_ID)).not.toBeNull();
    expect(getNodeRegistry().get('core.a2a.invoke'), 'the legacy alias is deleted').toBeNull();
  });

  it('is classified side-effecting so a replay serves the recorded outcome', () => {
    // ADR 0341: the call starts work on a REMOTE peer. Re-running it during a
    // replay-mode fork would double-dispatch to that peer.
    expect(getNodeRegistry().get(CONFORMANCE_A2A_INVOKE_TYPE_ID)?.sideEffecting).toBe(true);
  });
});

describe('core.conformance.a2a-invoke — reverse state projection', () => {
  it('drift point #3 — AUTH_REQUIRED suspends on an interrupt the executor reads as waiting-input', async () => {
    process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL = baseUrl;
    nextState = 'auth-required';
    const out = await invoke();
    expect(out.status).toBe('suspended');
    if (out.status !== 'suspended') return;
    // `clarification` is what `executor.ts inferWaitingKind` maps to
    // `waiting-input`; `approval` would land on `waiting-approval` and
    // `external-event` on `waiting-external`, neither of which is the
    // documented projection.
    expect(out.interrupt.kind).toBe('clarification');
    expect(out.interrupt.data).toMatchObject({ subkind: 'auth' });
  });

  it('drift point #4 — REJECTED fails with rejected_by_remote, attributing it to the peer', async () => {
    process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL = baseUrl;
    nextState = 'rejected';
    const out = await invoke();
    expect(out.status).toBe('failure');
    if (out.status !== 'failure') return;
    // The CODE is the assertion, not just the terminal status: a bare `failed`
    // leaves an observer unable to tell a peer refusal from a host defect.
    expect(out.error.code).toBe('rejected_by_remote');
  });

  it('a completed peer task succeeds, carrying the peer task id', async () => {
    process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL = baseUrl;
    nextState = 'completed';
    const out = await invoke();
    expect(out.status).toBe('success');
    if (out.status !== 'success') return;
    expect(out.outputs).toMatchObject({ state: 'COMPLETED', taskId: 'peer-task-1' });
  });

  it('with NO peer configured it fails TYPED — never success-with-empty', async () => {
    // The failure mode this whole item exists to remove: a leg that reports a
    // reverse projection no peer ever produced.
    delete process.env.OPENWOP_A2A_CONFORMANCE_PEER_URL;
    const out = await invoke();
    expect(out.status).toBe('failure');
    if (out.status !== 'failure') return;
    expect(out.error.code).toBe('a2a_peer_not_configured');
  });
});
