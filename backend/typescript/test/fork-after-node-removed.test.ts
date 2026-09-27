/**
 * ADR 0440 P2 — what ACTUALLY happens when a workflow is edited after it has
 * run, and the edit removes a node the run recorded.
 *
 * This test exists to falsify (or confirm) the premise P2 was written on. The
 * ADR proposed refusing such an overwrite with a 409, by analogy to the DELETE
 * route's `workflow_referenced` guard. That analogy only holds if an edit does
 * comparable damage to a delete.
 *
 * The architecture review read `executor.ts` as degrading PER NODE — a
 * side-effecting node whose recorded outcome is missing yields a typed
 * `replay_source_missing` failure ("a replay never fires a new side effect"),
 * not a corrupt or aborted fork. If that is right, an edit is nothing like a
 * delete (which loses the definition for EVERY run, with no recourse), and
 * refusing the write would break ordinary authoring — deleting a node from a
 * workflow that has ever run — with an unsatisfiable async 409.
 *
 * Result determines the design:
 *   - fork still resolves + runs the NEW shape  → refusal is wrong; disclose instead
 *   - fork 404s / corrupts / aborts wholesale   → refusal is justified
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('ADR 0440 P2 — fork after an edit removed a recorded node', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const WF = 'adr0440.fork.probe';

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
  };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('the edit is ACCEPTED and the fork still resolves the new shape', async () => {
    // 1. A two-node workflow.
    const created = await api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: WF,
        metadata: { name: 'Fork probe' },
        nodes: [
          { nodeId: 'first', typeId: 'core.noop', config: {} },
          { nodeId: 'second', typeId: 'core.noop', config: {} },
        ],
        edges: [{ edgeId: 'e1', sourceNodeId: 'first', targetNodeId: 'second' }],
      }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // 2. Run it, so the definition is REFERENCED and events record both nodes.
    const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: WF, inputs: {} }) });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = (run.body?.runId ?? (run.body?.run as { runId?: string } | undefined)?.runId) as string;
    expect(runId).toBeTruthy();

    // 3. Edit it the way the builder would: drop `second`. THIS is the write
    //    P2 proposed to refuse.
    const edited = await api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: WF,
        metadata: { name: 'Fork probe' },
        nodes: [{ nodeId: 'first', typeId: 'core.noop', config: {} }],
        edges: [],
      }),
    });
    expect(
      edited.status,
      `Removing a node from a workflow that has runs must stay ALLOWED — refusing it would make ordinary editing impossible (${JSON.stringify(edited.body)})`,
    ).toBe(201);

    // 4. The definition still resolves, in its new shape.
    const def = await api(`/v1/workflows/${WF}`);
    expect(def.status).toBe(200);
    expect((def.body?.nodes as Array<{ nodeId: string }>).map((n) => n.nodeId)).toEqual(['first']);

    // 5. And the historical run is still readable — the edit did not orphan it.
    const readBack = await api(`/v1/runs/${runId}`);
    expect(readBack.status).toBe(200);
    expect(readBack.body?.workflowId).toBe(WF);

    // 6. ADR 0440 P2 — the write is allowed, and the author is TOLD which
    //    recorded step it dropped, so the builder can surface a notice.
    expect(edited.body?.removedReferencedNodeIds).toEqual(['second']);
  });

  it('says NOTHING when the edit removes no node (the common autosave path)', async () => {
    const WF2 = 'adr0440.fork.probe.norm';
    const body = {
      workflowId: WF2,
      metadata: { name: 'No removal' },
      nodes: [{ nodeId: 'only', typeId: 'core.noop', config: {} }],
      edges: [],
    };
    expect((await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(body) })).status).toBe(201);
    const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: WF2, inputs: {} }) });
    expect(run.status).toBe(201);

    // A rename — the overwhelmingly common autosave. No node dropped, so no
    // disclosure AND no run probe (the probe is gated on the id set shrinking).
    const renamed = await api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ ...body, metadata: { name: 'Renamed' } }),
    });
    expect(renamed.status).toBe(201);
    expect(renamed.body?.removedReferencedNodeIds).toBeUndefined();
  });

  it('says nothing about a node NO run recorded — the disclosure must be truthful', async () => {
    // Grade-pass: the first implementation gated on `hasRunForWorkflow`, which
    // proves only that A run exists. A node added and deleted AFTER the run —
    // recorded by nothing — was still announced as "runs recorded this step".
    // A field that cries wolf gets learned-ignored, and the copy asserted
    // something the host had never checked.
    const WF4 = 'adr0440.fork.probe.untouched';
    const base = {
      workflowId: WF4,
      metadata: { name: 'Untouched node' },
      nodes: [{ nodeId: 'ran', typeId: 'core.noop', config: {} }],
      edges: [],
    };
    expect((await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(base) })).status).toBe(201);
    expect((await api('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId: WF4, inputs: {} }) })).status).toBe(201);

    // Add a node AFTER the run, then remove it. No run ever recorded it.
    const withExtra = {
      ...base,
      nodes: [...base.nodes, { nodeId: 'never-ran', typeId: 'core.noop', config: {} }],
      edges: [{ edgeId: 'e1', sourceNodeId: 'ran', targetNodeId: 'never-ran' }],
    };
    expect((await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(withExtra) })).status).toBe(201);
    const removed = await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(base) });
    expect(removed.status).toBe(201);
    expect(
      removed.body?.removedReferencedNodeIds,
      'a node no run ever recorded must NOT be reported as referenced',
    ).toBeUndefined();
  });

  it('says nothing when a node is removed from a workflow that never ran', async () => {
    const WF3 = 'adr0440.fork.probe.norun';
    const two = {
      workflowId: WF3,
      metadata: { name: 'Never ran' },
      nodes: [
        { nodeId: 'a', typeId: 'core.noop', config: {} },
        { nodeId: 'b', typeId: 'core.noop', config: {} },
      ],
      edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' }],
    };
    expect((await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify(two) })).status).toBe(201);

    // No runs reference it, so dropping a node costs nothing and must be silent.
    const trimmed = await api('/v1/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ ...two, nodes: [two.nodes[0]], edges: [] }),
    });
    expect(trimmed.status).toBe(201);
    expect(trimmed.body?.removedReferencedNodeIds).toBeUndefined();
  });
});
