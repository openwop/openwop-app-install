/**
 * ADR 0755 (WIT-A2UI-5, WIT-A2UI-4) — the RFC 0209 §C.12 approval block, driven
 * through the REAL choke points rather than `nodeHasUntrustedSurface` alone:
 *   - `POST /v1/runs/{runId}/interrupts/{nodeId}` answers 403
 *     `untrusted_content_blocks_approval` and leaves the interrupt OPEN;
 *   - the MCP `resumeInterrupt` refuses BEFORE its claim (a refusal after the
 *     claim would strand the interrupt: consumed, never resumed);
 *   - where nothing can record a v0.9 surface (`a2uiV2AdmissionReachable()` is
 *     false) the resolve path skips the whole-log read (WIT-A2UI-4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';
import { admitA2uiSurface, A2UI_V09_CATALOG_ID } from '../src/host/a2uiSurfaceAdmission.js';
import { resumeInterrupt } from '../src/host/mcpSemantics.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
const TOKEN = 'dev-token';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0755-a2ui', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let seq = 0;
async function seedApproval(tainted: boolean): Promise<{ run: RunRecord; interrupt: InterruptRecord }> {
  const now = new Date().toISOString();
  const n = ++seq;
  const run: RunRecord = {
    runId: `run-adr0755-a2ui-${n}-${Math.random().toString(36).slice(2)}`,
    workflowId: 'wf-adr0755', tenantId: 'demo', status: 'waiting-approval',
    inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  };
  await storage.insertRun(run);
  const interrupt: InterruptRecord = {
    interruptId: `int-adr0755-a2ui-${n}`, runId: run.runId, nodeId: 'gate', kind: 'approval',
    token: `tok-adr0755-a2ui-${n}-${Math.random().toString(36).slice(2)}`, data: {}, createdAt: now,
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
  fetch(`${BASE}/v1/runs/${encodeURIComponent(runId)}/interrupts/gate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ resumeValue: { action: 'approve' } }),
  });

describe('an approval bound to a tainted v0.9 surface cannot be resolved', () => {
  it('the run-scoped resolve route answers 403 untrusted_content_blocks_approval and the interrupt stays open', async () => {
    const { run } = await seedApproval(true);
    const res = await resolve(run.runId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('untrusted_content_blocks_approval');
    expect(await storage.getInterruptByNode(run.runId, 'gate'), 'refused BEFORE resolve — nothing stranded').toBeTruthy();
  });

  it('CONTROL: the same approval over a trusted surface is not refused for taint', async () => {
    const { run } = await seedApproval(false);
    const res = await resolve(run.runId);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('untrusted_content_blocks_approval');
  });

  it('the MCP resume refuses before its claim', async () => {
    const { run, interrupt } = await seedApproval(true);
    const out = await resumeInterrupt({ storage, hostSuite: {} as never, principal: {} as never }, interrupt.interruptId, { action: 'approve' });
    expect(out.kind).toBe('failed');
    expect(await storage.getInterruptByNode(run.runId, 'gate'), 'the claim never ran').toBeTruthy();
  });

  it('WIT-A2UI-4: where nothing can admit a v0.9 surface, the resolve path does not read for taint', async () => {
    const { run } = await seedApproval(true);
    delete process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      const res = await resolve(run.runId);
      const body = (await res.json()) as { error?: string };
      expect(body.error).not.toBe('untrusted_content_blocks_approval');
    } finally {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
    }
  });
});
