/**
 * ADR 0475 P2a — the debug loop, driven through the real HTTP app: pin CRUD
 * (caps + node validation + 404 posture), from-run prefill, execute-from-step
 * (missing-pin 422 naming nodes; from-here running only the target subgraph
 * with pinned data flowing downstream; 'only' skipping descendants; the
 * ordinary-run discipline — ADR 0474 revision pin + draft launch), production
 * runs never reading pins, and bulk redrive (as-run revision, terminal-only,
 * fresh identity).
 *
 * Every case seeds the pins it relies on (a `beforeEach` clears them), so the file
 * passes shuffled: "ordinary run", "'only'" and "production NEVER reads pins" used
 * to lean on a pin an earlier case left behind. The 404 posture is proven against
 * a workflow that EXISTS in the registry but is not owned by the caller's tenant
 * (a nonexistent id never reaches the ownership half, 8fw5g6-dl-owner-404); the
 * as-run claim changes the head between the source run and the redrive.
 * Sabotages witnessed (/grade-tests 8f W5, 8fw5g6-dl-*): the size cap, the secret
 * redaction, node validation, the ownership check, the missing-pin list, 'only',
 * the pinned tag, the redrive's provenance shedding and terminal-only rule, and
 * the as-run revision.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { bareRunId } from './support/bareRunId.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';

interface RunEvent { type: string; nodeId?: string; payload?: unknown }

describe('workflow debug loop routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/host/openwop-app/workflows';
  // a → b → c, plus b → d ('from-here' at b runs {b,c,d}; 'only' skips {c,d}).
  const WF = 'debug-loop-wf-1';
  // A deterministically failing workflow for the redrive lane.
  const WF_FAIL = 'debug-loop-wf-fail';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

    const mk = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>, edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }>) =>
      call('POST', API, { workflowId, nodes, edges, metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });
    expect((await mk(WF, [
      { nodeId: 'a', typeId: 'core.noop' },
      { nodeId: 'b', typeId: 'core.noop' },
      { nodeId: 'c', typeId: 'core.noop' },
      { nodeId: 'd', typeId: 'core.noop' },
    ], [
      { edgeId: 'e-ab', sourceNodeId: 'a', targetNodeId: 'b' },
      { edgeId: 'e-bc', sourceNodeId: 'b', targetNodeId: 'c' },
      { edgeId: 'e-bd', sourceNodeId: 'b', targetNodeId: 'd' },
    ])).status).toBe(201);
    expect((await mk(WF_FAIL, [{ nodeId: 'boom', typeId: 'core.fail' }], [])).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
  beforeEach(async () => {
    // No case inherits another's pins (shuffle-safe): each seeds what it needs.
    expect((await call('DELETE', `${API}/${WF}/pins`)).status).toBe(200);
  });
  const pinA = async (marker = 'PINNED-A'): Promise<void> => {
    expect((await call('PUT', `${API}/${WF}/pins/a`, { output: { marker } })).status).toBe(200);
  };

  async function call<T = unknown>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }

  // ADR 0812 P3c-0 — the debug-run / redrive host routes hand back a BARE run
  // id; a protocol read binds it to the caller's tenant (`default` for the
  // wildcard dev-token), as the SPA's v2Wire does, and names major 2.
  const runPath = (runId: string): string => `/runs/${encodeURIComponent(toWireRunId(runId, 'default'))}`;
  const V2 = { 'OpenWOP-Version': '2' };

  /** The settled status; THROWS (naming the run and the poll count) if it never settles. */
  async function settle(runId: string): Promise<string> {
    const POLLS = 200;
    let last = '';
    for (let i = 0; i < POLLS; i += 1) {
      const r = await call<{ status: string }>('GET', runPath(runId), undefined, V2);
      last = r.body.status;
      if (r.body.status && !['pending', 'running'].includes(r.body.status)) return r.body.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`run ${runId} did not settle after ${POLLS} polls (last status: ${last})`);
  }

  async function runEvents(runId: string): Promise<RunEvent[]> {
    // The HOST representation: `pinned`/`pinnedFrom` are host fields the closed v2
    // `node.completed` payload drops, so this debugging tool reads the vendor-twin bundle.
    const r = await call<{ events: RunEvent[] }>('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`);
    return r.body.events ?? [];
  }

  describe('pin CRUD', () => {
    it('pin → list → unpin round-trips; unknown node and non-object output are 400s', async () => {
      const put = await call('PUT', `${API}/${WF}/pins/a`, { output: { marker: 'PINNED-A' } });
      expect(put.status).toBe(200);
      const list = await call<{ items: Array<{ nodeId: string; output: Record<string, unknown> }> }>('GET', `${API}/${WF}/pins`);
      expect(list.status).toBe(200);
      expect(list.body.items.length).toBe(1);
      expect(list.body.items[0]!.nodeId).toBe('a');
      expect(list.body.items[0]!.output).toEqual({ marker: 'PINNED-A' });

      const unknownNode = await call<{ message?: string }>('PUT', `${API}/${WF}/pins/not-a-node`, { output: { x: 1 } });
      expect(unknownNode.status).toBe(400);
      expect(unknownNode.body.message).toBe("'not-a-node' is not a node of this workflow.");
      const notObject = await call<{ message?: string }>('PUT', `${API}/${WF}/pins/a`, { output: 'not-an-object' });
      expect(notObject.status).toBe(400);
      expect(notObject.body.message).toBe('output must be an object (the node.completed outputs shape).');

      const del = await call<{ removed: boolean }>('DELETE', `${API}/${WF}/pins/a`);
      expect(del.body.removed).toBe(true);
      expect((await call<{ items: unknown[] }>('GET', `${API}/${WF}/pins`)).body.items.length).toBe(0);
    });

    it('an oversized pin is refused (size cap)', async () => {
      // Spaced text (an unbroken run could be refused as secret-shaped first), past the 64 KiB cap.
      const big = 'lorem ipsum '.repeat(6000);
      const r = await call<{ message?: string }>('PUT', `${API}/${WF}/pins/a`, { output: { big } });
      expect(r.status).toBe(400);
      expect(r.body.message).toMatch(/^Pinned output too large \(\d+ bytes; max \d+\)\.$/);
      expect((await call<{ items: unknown[] }>('GET', `${API}/${WF}/pins`)).body.items).toEqual([]);
    });

    it('a pinned value passes the event-log redaction discipline (pasted keys never persist)', async () => {
      const put = await call('PUT', `${API}/${WF}/pins/a`, {
        output: { note: `use sk-${'A'.repeat(24)} for this call` },
      });
      expect(put.status).toBe(200);
      const list = await call<{ items: Array<{ nodeId: string; output: { note?: string } }> }>('GET', `${API}/${WF}/pins`);
      const note = list.body.items.find((p) => p.nodeId === 'a')!.output.note!;
      // The invariant is that the key never persists — the exact redaction
      // marker ('sk-***' vs '<<redacted:credential-shape>>') is the redactor's.
      expect(note).not.toContain(`sk-${'A'.repeat(24)}`);
      expect(note).not.toContain('A'.repeat(24));
      await call('DELETE', `${API}/${WF}/pins/a`);
    });

    it('unknown workflow is a 404 (no existence leak) on every pin verb', async () => {
      // A workflow that EXISTS in the registry but that this tenant does not own
      // answers exactly like one that does not exist (the ownership half of
      // `loadOwnedHead`; a nonexistent id alone also misses the registry).
      const FOREIGN = 'debug-loop-wf-foreign';
      registerWorkflow({ workflowId: FOREIGN, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [], metadata: { name: FOREIGN } });
      for (const id of ['does-not-exist', FOREIGN]) {
        for (const r of [
          await call<{ message?: string }>('GET', `${API}/${id}/pins`),
          await call<{ message?: string }>('PUT', `${API}/${id}/pins/a`, { output: { x: 1 } }),
          await call<{ message?: string }>('DELETE', `${API}/${id}/pins`),
          await call<{ message?: string }>('POST', `${API}/${id}/debug-run`, { fromNodeId: 'a' }),
        ]) {
          expect(r.status, id).toBe(404);
          expect(r.body.message, id).toBe('Workflow not found in this catalog.');
        }
      }
    });
  });

  describe('execute-from-step', () => {
    it('missing pins are a 422 that NAMES the nodes', async () => {
      const r = await call<{ details?: { missingPins?: string[] }; message?: string }>(
        'POST', `${API}/${WF}/debug-run`, { fromNodeId: 'b', mode: 'from-here' },
      );
      expect(r.status).toBe(422);
      expect(r.body.details?.missingPins).toEqual(['a']);
      expect(r.body.message).toContain('a');
    });

    it("'from-here' runs only the target subgraph, with the pinned output flowing downstream", async () => {
      await pinA();
      const r = await call<{ runId: string; pinnedNodes: string[]; executing: string[]; skipped: string[] }>(
        'POST', `${API}/${WF}/debug-run`, { fromNodeId: 'b', mode: 'from-here' },
      );
      expect(r.status).toBe(201);
      expect(r.body.pinnedNodes).toEqual(['a']);
      expect(r.body.executing.sort()).toEqual(['b', 'c', 'd']);
      expect(r.body.skipped).toEqual([]);

      expect(await settle(r.body.runId)).toBe('completed');
      const events = await runEvents(r.body.runId);
      // The synthetic prefix: a's completion is recorded AND honestly tagged.
      const aDone = events.find((e) => e.type === 'node.completed' && e.nodeId === 'a');
      expect(aDone).toBeTruthy();
      expect((aDone!.payload as { pinned?: boolean }).pinned).toBe(true);
      expect((aDone!.payload as { outputs?: { marker?: string } }).outputs?.marker).toBe('PINNED-A');
      // b executed LIVE (no pinned tag) and consumed the pinned data.
      const bDone = events.find((e) => e.type === 'node.completed' && e.nodeId === 'b');
      expect(bDone).toBeTruthy();
      expect((bDone!.payload as { pinned?: boolean }).pinned).toBeUndefined();
      expect(JSON.stringify(bDone!.payload)).toContain('PINNED-A');
      // The whole subgraph ran.
      for (const id of ['c', 'd']) {
        expect(events.some((e) => e.type === 'node.completed' && e.nodeId === id)).toBe(true);
      }
    });

    it("'only' runs the single node and skips its descendants", async () => {
      await pinA(); // b's direct upstream must be pinned
      const r = await call<{ runId: string; executing: string[]; skipped: string[] }>(
        'POST', `${API}/${WF}/debug-run`, { fromNodeId: 'b', mode: 'only' },
      );
      expect(r.status).toBe(201);
      expect(r.body.executing).toEqual(['b']);
      expect(r.body.skipped.sort()).toEqual(['c', 'd']);

      expect(await settle(r.body.runId)).toBe('completed');
      const events = await runEvents(r.body.runId);
      expect(events.some((e) => e.type === 'node.completed' && e.nodeId === 'b')).toBe(true);
      for (const id of ['c', 'd']) {
        expect(events.some((e) => e.type === 'node.completed' && e.nodeId === id)).toBe(false);
      }
    });

    it('a debug run is an ORDINARY run: draft launch, debug metadata, ADR 0474 revision pin', async () => {
      await pinA();
      const r = await call<{ runId: string }>('POST', `${API}/${WF}/debug-run`, { fromNodeId: 'b' });
      expect(r.status).toBe(201);
      expect(await settle(r.body.runId)).toBe('completed');
      // The host-ext provenance surface (the RunSnapshot wire type omits
      // run.metadata by design — the launch/debug stamps read from here).
      const rev = await call<{ definitionRevision?: string; launch?: string; launchResolved?: string; debug?: { fromNodeId?: string; mode?: string; pinnedNodes?: string[] } }>(
        'GET', `/host/openwop-app/runs/${bareRunId(r.body.runId)}/revision`,
      );
      expect(rev.body.definitionRevision).toBeTruthy();
      expect(rev.body.launch).toBe('draft');
      expect(rev.body.launchResolved).toBe('head');
      expect(rev.body.debug?.fromNodeId).toBe('b');
      expect(rev.body.debug?.pinnedNodes).toEqual(['a']);
    });

    it('unknown fromNodeId is a 400; a bad mode is a 400', async () => {
      const unknown = await call<{ message?: string }>('POST', `${API}/${WF}/debug-run`, { fromNodeId: 'nope' });
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toBe("fromNodeId 'nope' is not a node of this workflow.");
      const badMode = await call<{ message?: string }>('POST', `${API}/${WF}/debug-run`, { fromNodeId: 'b', mode: 'sideways' });
      expect(badMode.status).toBe(400);
      expect(badMode.body.message).toBe("mode must be 'from-here' or 'only'.");
    });

    it('a production run NEVER reads pins — every node executes live', async () => {
      // A pin for a EXISTS (seeded here); an ordinary POST /v1/runs must ignore it.
      await pinA();
      expect((await call<{ items: unknown[] }>('GET', `${API}/${WF}/pins`)).body.items).toHaveLength(1);
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF, inputs: { marker: 'LIVE' } });
      expect(run.status).toBe(201);
      expect(await settle(run.body.runId)).toBe('completed');
      const events = await runEvents(run.body.runId);
      const aDone = events.find((e) => e.type === 'node.completed' && e.nodeId === 'a');
      expect(aDone).toBeTruthy();
      expect((aDone!.payload as { pinned?: boolean }).pinned).toBeUndefined();
      expect(JSON.stringify(aDone!.payload)).not.toContain('PINNED-A');
    });
  });

  describe('pins/from-run prefill', () => {
    it('prefills pins from a settled run\'s real outputs, tagged with the source run', async () => {
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF, inputs: { marker: 'REAL' } });
      expect(await settle(run.body.runId)).toBe('completed');

      const prefill = await call<{ pinned: string[]; unmatched?: string[] }>(
        'POST', `${API}/${WF}/pins/from-run`, { runId: bareRunId(run.body.runId) },
      );
      expect(prefill.status).toBe(200);
      expect(prefill.body.pinned.sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(prefill.body.unmatched).toBeUndefined();

      const list = await call<{ items: Array<{ nodeId: string; sourceRunId?: string; output: Record<string, unknown> }> }>('GET', `${API}/${WF}/pins`);
      expect(list.body.items.length).toBe(4);
      expect(list.body.items.every((p) => p.sourceRunId === bareRunId(run.body.runId))).toBe(true);
      expect(JSON.stringify(list.body.items.find((p) => p.nodeId === 'a')!.output)).toContain('REAL');
    });

    it('one oversized output is skipped-with-reason; the rest still pin (review M3)', async () => {
      // core.noop echoes inputs → node a's output carries the >64KB payload;
      // downstream nodes carry it too, so expect a to pin nothing... instead
      // drive a SMALL marker plus one huge field: every node's echo exceeds
      // the cap, so all four report skipped and none pin — the request still
      // succeeds and NAMES them (the honest-partial contract).
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF, inputs: { big: 'x'.repeat(70 * 1024) } });
      expect(run.status).toBe(201);
      expect(await settle(run.body.runId)).toBe('completed');
      const prefill = await call<{ pinned: string[]; skipped?: Array<{ nodeId: string; reason: string }> }>(
        'POST', `${API}/${WF}/pins/from-run`, { runId: bareRunId(run.body.runId) },
      );
      expect(prefill.status).toBe(200);
      expect(prefill.body.skipped?.length).toBeGreaterThan(0);
      expect(prefill.body.skipped!.every((r) => r.reason === 'validation_error')).toBe(true);
      await call('DELETE', `${API}/${WF}/pins`);
    });

    it('a run of a DIFFERENT workflow is a 400; an unknown run is a 404', async () => {
      const other = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_FAIL, inputs: {} });
      await settle(other.body.runId);
      expect((await call('POST', `${API}/${WF}/pins/from-run`, { runId: bareRunId(other.body.runId) })).status).toBe(400);
      expect((await call('POST', `${API}/${WF}/pins/from-run`, { runId: 'no-such-run' })).status).toBe(404);
      expect((await call('POST', `${API}/${WF}/pins/from-run`, {})).status).toBe(400);
    });
  });

  describe('bulk redrive', () => {
    it('redrives a failed run as a FRESH run pinned to the as-run revision', async () => {
      // Its own failing workflow, so changing the head below touches no other case.
      const WF_ASRUN = 'debug-loop-wf-asrun';
      const save = (marker: string) => call('POST', API, {
        workflowId: WF_ASRUN, nodes: [{ nodeId: 'boom', typeId: 'core.fail', config: { note: marker } }], edges: [],
        metadata: { name: WF_ASRUN, lifecycle: { transient: true, generatedBy: 'test' } },
      });
      expect((await save('v1')).status).toBe(201);
      const src = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_ASRUN, inputs: { seed: 42 } });
      expect(await settle(src.body.runId)).toBe('failed');
      const srcRev = await call<{ definitionRevision?: string }>('GET', `/host/openwop-app/runs/${bareRunId(src.body.runId)}/revision`);
      expect(srcRev.body.definitionRevision).toBeTruthy();
      // The head MOVES after the source run: an as-run redrive must not follow it.
      expect([200, 201]).toContain((await save('v2')).status);
      const headRun = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_ASRUN, inputs: {} });
      await settle(headRun.body.runId);
      const headRev = await call<{ definitionRevision?: string }>('GET', `/host/openwop-app/runs/${bareRunId(headRun.body.runId)}/revision`);
      expect(headRev.body.definitionRevision, 'the head did not move — the as-run claim would be untestable').not.toBe(srcRev.body.definitionRevision);

      const rd = await call<{ results: Array<{ runId: string; redriveRunId?: string; error?: string }> }>(
        'POST', '/host/openwop-app/runs/redrive', { runIds: [bareRunId(src.body.runId)] },
      );
      expect(rd.status).toBe(200);
      const redriveRunId = rd.body.results[0]!.redriveRunId!;
      expect(redriveRunId).toBeTruthy();
      expect(redriveRunId).not.toBe(bareRunId(src.body.runId));

      expect(await settle(redriveRunId)).toBe('failed'); // same definition, same deterministic failure
      const run = await call<{ inputs?: unknown }>('GET', runPath(redriveRunId), undefined, V2);
      expect((run.body.inputs as { seed?: number })?.seed).toBe(42);
      const rev = await call<{ definitionRevision?: string; definitionResolvedFrom?: string; redriveOf?: string }>('GET', `/host/openwop-app/runs/${bareRunId(redriveRunId)}/revision`);
      expect(rev.body.redriveOf).toBe(bareRunId(src.body.runId));
      expect(rev.body.definitionRevision).toBe(srcRev.body.definitionRevision); // the AS-RUN content, not the moved head
      expect(rev.body.definitionResolvedFrom).toBe('revision');
    });

    it('a non-terminal/completed run reports not_redrivable; partial success is per-run', async () => {
      const ok = await call<{ runId: string }>('POST', '/runs', { workflowId: WF, inputs: {} });
      expect(await settle(ok.body.runId)).toBe('completed');
      const failed = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_FAIL, inputs: {} });
      expect(await settle(failed.body.runId)).toBe('failed');

      const rd = await call<{ results: Array<{ runId: string; redriveRunId?: string; error?: string }> }>(
        'POST', '/host/openwop-app/runs/redrive', { runIds: [bareRunId(ok.body.runId), bareRunId(failed.body.runId), 'no-such-run'] },
      );
      expect(rd.status).toBe(200);
      expect(rd.body.results.length).toBe(3);
      expect(rd.body.results[0]!.error).toBe('not_redrivable');
      expect(rd.body.results[1]!.redriveRunId).toBeTruthy();
      expect(rd.body.results[2]!.error).toBe('run_not_found');
    });

    it('a redrive of a failed DEBUG run sheds the debug/draft provenance (review M1)', async () => {
      // WF_FAIL's single node needs no pins; a debug run of it fails deterministically.
      const dbg = await call<{ runId: string }>('POST', `${API}/${WF_FAIL}/debug-run`, { fromNodeId: 'boom', mode: 'only' });
      expect(dbg.status).toBe(201);
      expect(await settle(dbg.body.runId)).toBe('failed');
      const dbgProv = await call<{ debug?: unknown; launch?: string }>('GET', `/host/openwop-app/runs/${bareRunId(dbg.body.runId)}/revision`);
      expect(dbgProv.body.debug).toBeTruthy(); // the source IS a debug run

      const rd = await call<{ results: Array<{ redriveRunId?: string }> }>(
        'POST', '/host/openwop-app/runs/redrive', { runIds: [dbg.body.runId] },
      );
      expect(rd.status).toBe(200);
      const redriveRunId = rd.body.results[0]!.redriveRunId!;
      expect(redriveRunId).toBeTruthy();
      expect(await settle(redriveRunId)).toBe('failed');
      const prov = await call<{ debug?: unknown; launch?: string; redriveOf?: string }>(
        'GET', `/host/openwop-app/runs/${bareRunId(redriveRunId)}/revision`,
      );
      expect(prov.body.redriveOf).toBe(dbg.body.runId);
      expect(prov.body.debug).toBeUndefined();   // the redrive ran the FULL definition, unpinned
      expect(prov.body.launch).toBeUndefined();  // and is not a draft-launch run
    });

    it('validates the batch shape: empty and oversized lists are 400s', async () => {
      expect((await call('POST', '/host/openwop-app/runs/redrive', { runIds: [] })).status).toBe(400);
      expect((await call('POST', '/host/openwop-app/runs/redrive', { runIds: Array.from({ length: 26 }, (_, i) => `r${i}`) })).status).toBe(400);
      expect((await call('POST', '/host/openwop-app/runs/redrive', {})).status).toBe(400);
    });
  });
});
