/**
 * RFC 0173 §C.2 — `fireEffectSeam`.
 *
 * The witness is a row in this host's Layer-2 ledger, readable at
 * `GET /runs/{runId}/effects`. So the assertion that matters is END TO END:
 * fire a manifest row, then read the projection and find the attempt. A test
 * that only checked the 201 would pass on a seam that recorded nothing, and the
 * scenario would then read an empty projection as "suppressed" — a green leg
 * certifying the opposite of what happened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { SEAM_ROWS } from '../src/host/effectSeamManifest.js';
import { fireWorkflowId } from '../src/routes/effectSeamFireSeam.js';
import { listOwned, allOwnershipByWorkflow } from '../src/host/workflowOwnership.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };
const FIRE = '/conformance/seams/sample/effect-seams/fire';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function fire(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${FIRE}`, { method: 'POST', headers: V2, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('fireEffectSeam (RFC 0173 §C.2)', () => {
  it('a fired seam APPEARS in GET /runs/{runId}/effects — the end-to-end witness', async () => {
    const seam = SEAM_ROWS[0]?.seam ?? '';
    expect(seam, 'no manifest rows means every leg here is vacuous').not.toBe('');

    const res = await fire({ seam });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const wireId = String(res.json['runId']);

    const proj = await fetch(`${base}/runs/${encodeURIComponent(wireId)}/effects`, { headers: V2 });
    expect(proj.status).toBe(200);
    const body = await proj.json() as { effects: Array<{ nodeId: string; attempt: number; state: string }> };
    expect(body.effects.length, 'the fired seam recorded NO ledger row — the scenario would read this as suppression').toBe(1);
    expect(body.effects[0]?.attempt).toBe(1);
    expect(body.effects[0]?.state, 'a recorded outcome is `completed`').toBe('completed');
  });

  it('every manifest row can be fired — the scenario picks any guarded row', async () => {
    // `replay.md:78` forbids conflating the branch permission with replay
    // suppression, so the scenario's `branchReFires === false` filter is a
    // corpus defect (confirmed by the maintainer) and ANY guarded row is a
    // valid target. This host must therefore be able to fire all of them.
    let fired = 0;
    for (const row of SEAM_ROWS) {
      const res = await fire({ seam: row.seam });
      expect(res.status, `${row.seam} could not be fired: ${JSON.stringify(res.json)}`).toBe(201);
      fired++;
    }
    expect(fired, 'the loop asserted nothing').toBe(SEAM_ROWS.length);
  });

  it('the fired run is a REAL run: it has a log and a replay fork of it answers 201 and does not re-fire', async () => {
    // The seam used to hand-build a `completed` row with ZERO events, so the
    // scenario's `:fork {mode:'replay'}` (fromSeq defaults to 0) named no event
    // and `runs.md` §Fork required `422 fork_point_invalid` — the no-refire leg
    // recorded `blocked` on every lane and suppression was never witnessed.
    const seam = SEAM_ROWS.find((r) => r.guarded)?.seam ?? '';
    expect(seam, 'no guarded manifest row — the scenario would have nothing to fire').not.toBe('');
    const res = await fire({ seam });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const parent = String(res.json['runId']);

    const poll = await fetch(`${base}/runs/${encodeURIComponent(parent)}/events/poll?timeout=1`, { headers: V2 });
    const types = ((await poll.json()) as { events: Array<{ type: string }> }).events.map((e) => e.type);
    expect(types[0], 'a run starts at sequence 0 — the event the default fork point names').toBe('run.started');
    expect(types).toContain('run.completed');

    const fork = await fetch(`${base}/runs/${encodeURIComponent(parent)}:fork`, { method: 'POST', headers: V2, body: JSON.stringify({ mode: 'replay' }) });
    const forkBody = await fork.json() as { runId?: string };
    expect(fork.status, JSON.stringify(forkBody)).toBe(201);
    const forkId = String(forkBody.runId);
    let status = '';
    for (let i = 0; i < 100; i++) {
      status = ((await (await fetch(`${base}/runs/${encodeURIComponent(forkId)}`, { headers: V2 })).json()) as { status: string }).status;
      if (['completed', 'failed', 'cancelled'].includes(status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).toBe('completed');
    const count = async (id: string): Promise<number> =>
      ((await (await fetch(`${base}/runs/${encodeURIComponent(id)}/effects`, { headers: V2 })).json()) as { effects: unknown[] }).effects.length;
    expect(await count(parent), 'the source recorded its attempt — the comparison has something to compare').toBe(1);
    expect(await count(forkId), 'a replay fork MUST NOT issue a further attempt through a guarded seam (replay.md §Suppression)').toBe(0);
  });

  it('guardrail 2 — the transient workflow is scoped to the calling tenant, idempotent across fires, and never owned', async () => {
    const seam = SEAM_ROWS.find((r) => r.guarded)?.seam ?? '';
    const a = await fire({ seam });
    const b = await fire({ seam });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const wireA = String(a.json['runId']);
    const tenant = wireA.slice(0, wireA.lastIndexOf('/'));
    expect(tenant.length, 'the wire runId carries the caller tenant').toBeGreaterThan(0);
    const runOf = async (id: string) => (await (await fetch(`${base}/v1/runs/${encodeURIComponent(id.slice(id.lastIndexOf('/') + 1))}`, { headers: AUTH })).json()) as { workflowId: string; metadata?: { definitionRevision?: string } };
    const [ra, rb] = [await runOf(wireA), await runOf(String(b.json['runId']))];
    expect(ra.workflowId, 'the definition is keyed to the CALLING tenant').toBe(fireWorkflowId(tenant, seam));
    expect(rb.workflowId, 'a second fire reuses the same definition, not a new one').toBe(ra.workflowId);
    expect(fireWorkflowId('another-tenant', seam)).not.toBe(ra.workflowId);
    // No catalog row: the definition lives only as a tenant-scoped revision the
    // run pins, so it is not a registered workflow on any instance.
    expect(await getRegisteredWorkflowAsync(ra.workflowId)).toBeNull();
    expect(ra.metadata?.definitionRevision, 'both runs pin the same content-hash revision').toBe(rb.metadata?.definitionRevision);
    // Never in the tenant ownership index — so never in /builder or the `/` picker.
    expect((await listOwned(tenant)).map((o) => o.workflowId)).not.toContain(ra.workflowId);
    expect((await allOwnershipByWorkflow()).has(ra.workflowId)).toBe(false);
    const listed = await (await fetch(`${base}/v1/host/openwop-app/workflows`, { headers: AUTH })).json() as { workflows?: Array<{ workflowId?: string }> };
    expect(JSON.stringify(listed)).not.toContain('conformance.effect-seam.fire');
  });

  it('an unknown seam is REFUSED, not silently recorded', async () => {
    const res = await fire({ seam: 'not.a.declared.seam' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/unknown seam/);
  });

  it('closed-world validates the body, and 404s when the seam surface is off', async () => {
    expect((await fire({})).status).toBe(400);
    expect((await fire({ seam: '' })).status).toBe(400);
    expect((await fire({ seam: SEAM_ROWS[0]?.seam, receiverUrl: 5 })).status).toBe(400);
    const prev = process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'false';
      expect((await fire({ seam: SEAM_ROWS[0]?.seam })).status).toBe(404);
    } finally { process.env.OPENWOP_TEST_SEAM_ENABLED = prev; }
  });
});
