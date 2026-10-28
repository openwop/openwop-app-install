/**
 * ADR 0755 (WIT-A2UI-5, WIT-A2UI-4) — the RFC 0209 §C.12 approval block, driven
 * through the REAL choke points rather than `nodeHasUntrustedSurface` alone:
 *   - `POST /runs/{runId}/interrupts/{nodeId}` answers 403
 *     `untrusted_content_blocks_approval` and leaves the interrupt OPEN;
 *   - the MCP `resumeInterrupt` refuses BEFORE its claim (a refusal after the
 *     claim would strand the interrupt: consumed, never resumed);
 *   - where nothing can record a v0.9 surface (`a2uiV2AdmissionReachable()` is
 *     false) the resolve path skips the whole-log read (WIT-A2UI-4).
 *
 * Tracker TST-BAB-13. Red when (sabotage-witnessed, wave 60): the shared taint
 * predicate stops refusing (route AND MCP red); taint is read as "any bound
 * surface" (the trusted CONTROL red); the reachability fast path is removed
 * (WIT-A2UI-4 red); the MCP pre-claim check is removed.
 * DOUBLE GUARD (MCP): `resumeInterrupt` checks before its claim AND
 * `resolveAndResume` re-checks, both through `assertApprovalSurfaceTrusted`;
 * the shared predicate is the one edit that breaks both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, Principal, RunRecord } from '../src/types.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { admitA2uiSurface, A2UI_V09_CATALOG_ID } from '../src/host/a2uiSurfaceAdmission.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let hostSuite: HostAdapterSuite;
const TOKEN = 'dev-token';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0755-a2ui', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let seq = 0;
/**
 * What a resolve that got PAST the taint check answers here: the fixture run has
 * no stored definition, so `resolveAndResume`'s LATER gate-semantics check refuses
 * it 409 `approval_node_unresolvable`. Reaching that check proves the taint check
 * (earlier in the same function) admitted the approval.
 */
async function expectPastTaintCheck(res: Response): Promise<void> {
  const body = (await res.json()) as { error?: string; details?: { reason?: string } };
  expect(body.error).not.toBe('openwop-app.untrusted_content_blocks_approval');
  expect(res.status, JSON.stringify(body)).toBe(409);
  expect(body.details?.reason).toBe('approval_node_unresolvable');
}
async function seedApproval(tainted: boolean): Promise<{ run: RunRecord; interrupt: InterruptRecord }> {
  const now = new Date().toISOString();
  const n = ++seq;
  const run: RunRecord = {
    runId: `run-adr0755-a2ui-${n}`,
    // The caller's own tenant (`dev-token` acts in `default`): the major-2 path
    // takes the run id tenant-bound, and a foreign segment is id_tenant_mismatch.
    workflowId: 'wf-adr0755', tenantId: 'default', status: 'waiting-approval',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const interrupt: InterruptRecord = {
    interruptId: `int-adr0755-a2ui-${n}`, runId: run.runId, nodeId: 'gate', kind: 'approval',
    token: `tok-adr0755-a2ui-${n}`, data: {}, createdAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await storage.insertInterrupt(interrupt);
  const sid = `s${n}`;
  const meta = { source: 'ai-generation', ts: now, ...(tainted ? { contentTrust: 'untrusted' } : {}) };
  const admitted = await admitA2uiSurface(run.runId, {
    type: 'ui.a2ui-surface', schemaVersion: 2, envelopeId: `e${n}`, correlationId: `c${n}`, nodeId: 'gate', meta,
    payload: { version: 'v0.9', catalogId: A2UI_V09_CATALOG_ID, surfaceId: sid, messages: [{ version: 'v0.9', createSurface: { surfaceId: sid, catalogId: A2UI_V09_CATALOG_ID } }] },
  });
  expect(admitted.status, 'precondition: the surface was recorded').toBe('admitted');
  return { run, interrupt };
}

const resolve = (runId: string): Promise<Response> =>
  fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(runId, 'default'))}/interrupts/gate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'OpenWOP-Version': '2' },
    body: JSON.stringify({ resumeValue: { action: 'approve' } }),
  });

describe('an approval bound to a tainted v0.9 surface cannot be resolved', () => {
  it('the run-scoped resolve route answers 403 untrusted_content_blocks_approval and the interrupt stays open', async () => {
    const { run } = await seedApproval(true);
    const res = await resolve(run.runId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('openwop-app.untrusted_content_blocks_approval');
    expect(await storage.getInterruptByNode(run.runId, 'gate'), 'refused BEFORE resolve — nothing stranded').toBeTruthy();
  });

  it('CONTROL: the same approval over a trusted surface is not refused for taint', async () => {
    const { run } = await seedApproval(false);
    await expectPastTaintCheck(await resolve(run.runId));
  });

  it('the MCP resume refuses before its claim', async () => {
    const { run, interrupt } = await seedApproval(true);
    const principal: Principal = { principalId: 'adr0755-mcp', tenants: ['default'], token: 'unused' };
    const out = await resumeInterrupt({ storage, hostSuite, principal }, interrupt.interruptId, { action: 'approve' });
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' ? out.text : '', 'refused for TAINT, not for a missing interrupt').toContain('untrusted content');
    expect(await storage.getInterruptByNode(run.runId, 'gate'), 'the claim never ran').toBeTruthy();
  });

  it('WIT-A2UI-4: where nothing can admit a v0.9 surface, the resolve path does not read for taint', async () => {
    const { run } = await seedApproval(true);
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      await expectPastTaintCheck(await resolve(run.runId));
    } finally {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    }
  });
});
