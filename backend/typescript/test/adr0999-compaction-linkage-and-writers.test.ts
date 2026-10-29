/**
 * ADR 0999 D1.3 + D3.3 — who may make a run INHERIT a parent's compaction
 * decision, and the writers that refuse a compaction marker.
 *
 * D1.3 security (the lead's three questions). `POST /runs` copies the parent
 * row's frozen `compaction` decision ONLY when `admittedLinkage` admits the
 * parent, and that guard (ADR 0902 D2, unchanged here) is:
 *
 *     if (principal.tenants?.includes('*') !== true) return undefined;
 *     …
 *     const parent = await storage.getRun(parentRunId);
 *     if (!parent || parent.tenantId !== tenantId) return undefined;
 *
 *  (a) only the WILDCARD service principal (the sub-run dispatcher's internal
 *      token) can name a parent, and only one in the run's own tenant. A member's
 *      `metadata.parentRunId` is stripped by `CALLER_LINKAGE_KEYS` before the
 *      build. A wildcard principal passes every run-read predicate, so "readable
 *      by the caller" is implied rather than re-checked.
 *  (b) a parent in another tenant, or one that does not exist, admits nothing:
 *      no linkage, no inheritance, and the SAME 201 as a run with no parent, so
 *      the response is not an existence oracle.
 *  (c) only the `compaction` key is copied on this lane (review M3), and it is a
 *      frozen decision about how much of a tool result a model reads. It grants
 *      no scope, autonomy or authority.
 *
 * Sabotage witnessed 2026-10-28:
 *  - drop the wildcard check in `admittedLinkage` → the member-forgery case reds.
 *  - drop `parent.tenantId !== tenantId` → the cross-tenant case reds.
 *  - remove the compaction copy in `routes/runs.ts` → the CONTROL reds (it is also
 *    red on the pre-ADR code, which copied nothing).
 *  - remove the marker check from any of the three writers → that writer's case reds.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { readCompactionDecision } from '../src/executor/compaction.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { CMS_UPDATE_SECTION_DRAFT_TOOL_ID } from '../src/features/cms/agentTools.js';
import { DISCOVERY_CREATE_RULE_TOOL_ID } from '../src/features/discovery/agentTools.js';
import { FUNNELS_DRAFT_TOOL_ID } from '../src/features/funnels/agentTools.js';
import { COMPACTION_MARKER_IN_INPUT } from '../src/host/toolResultTransform.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let BASE = '';
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0999', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  storage = __hostExtStorage()!;
});
afterAll(async () => {
  await __clearToggleStore();
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  // ON: a fresh run is stamped `lossless`. Parents below are stamped `lossy`, so a
  // child reading `lossy` INHERITED and a child reading `lossless` resolved fresh.
  await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status: 'on' }, 'test');
});

const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

function member() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
}
const asService = (body: Record<string, unknown>) => fetch(`${BASE}/runs`, {
  method: 'POST', headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** A `lossy`-stamped parent in `tenantId`, written as the host writes rows. */
async function lossyParent(tenantId: string): Promise<string> {
  const at = new Date().toISOString();
  const runId = `adr0999-parent-${n++}`;
  await storage.insertRun({ runId, tenantId, workflowId: 'conformance-noop', status: 'completed', inputs: {}, configurable: {}, createdAt: at, updatedAt: at, metadata: { compaction: { mode: 'lossy', head: 1, tail: 1 } } } as RunRecord);
  return runId;
}
async function childOf(res: Response): Promise<{ status: number; row: RunRecord | null }> {
  const status = res.status;
  const body = (await res.json()) as { runId: string };
  return { status, row: await storage.getRun(raw(body.runId)) };
}
async function serviceTenant(): Promise<string> {
  const { row } = await childOf(await asService({ workflowId: 'conformance-noop', inputs: {} }));
  return row!.tenantId;
}

describe('ADR 0999 D1.3 — only an admitted parent hands down its decision', () => {
  it('CONTROL: the service lane naming a same-tenant parent inherits its frozen decision', async () => {
    const tenantId = await serviceTenant();
    const parent = await lossyParent(tenantId);
    const { status, row } = await childOf(await asService({ workflowId: 'conformance-noop', tenantId, inputs: {}, metadata: { parentRunId: parent } }));
    expect(status).toBe(201);
    expect(row?.metadata?.['parentRunId']).toBe(parent);
    expect(readCompactionDecision(row?.metadata)).toEqual({ mode: 'lossy', head: 1, tail: 1 });
  });

  it('(a) a MEMBER naming a parent in its own tenant inherits nothing (the linkage is stripped)', async () => {
    const call = member();
    const login = await call('POST', '/host/openwop-app/test/login', { email: `adr0999-${Date.now()}-${n++}@acme.test` });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const tenantId = login.body.user.tenantId as string;
    const parent = await lossyParent(tenantId);
    const r = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {}, metadata: { parentRunId: parent } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = await storage.getRun(raw(r.body.runId));
    expect(row?.tenantId).toBe(tenantId); // same tenant: only the wildcard check stands between them
    expect(row?.metadata?.['parentRunId']).toBeUndefined();
    expect(readCompactionDecision(row?.metadata)).toEqual({ mode: 'lossless' }); // resolved fresh, not inherited
  });

  it('(b) a parent in ANOTHER tenant and a parent that does not exist both admit nothing, with the same response', async () => {
    const tenantId = await serviceTenant();
    const foreign = await lossyParent('adr0999-other-tenant');
    const cross = await childOf(await asService({ workflowId: 'conformance-noop', tenantId, inputs: {}, metadata: { parentRunId: foreign } }));
    const ghost = await childOf(await asService({ workflowId: 'conformance-noop', tenantId, inputs: {}, metadata: { parentRunId: 'adr0999-no-such-run' } }));
    const none = await childOf(await asService({ workflowId: 'conformance-noop', tenantId, inputs: {} }));
    for (const c of [cross, ghost]) {
      expect(c.row?.metadata?.['parentRunId']).toBeUndefined();
      expect(readCompactionDecision(c.row?.metadata)).toEqual({ mode: 'lossless' });
    }
    // No existence oracle: a foreign parent, a missing one and no parent are indistinguishable.
    expect(new Set([cross.status, ghost.status, none.status])).toEqual(new Set([201]));
  });
});

describe('ADR 0999 D3.3 — the writers refuse a compaction marker instead of filtering it', () => {
  const MARKED = [{ id: 's0' }, { _elided: 4 }, { id: 's5' }];
  const cases: Array<[string, Record<string, unknown>]> = [
    [CMS_UPDATE_SECTION_DRAFT_TOOL_ID, { pageId: 'p', sectionId: 's', data: { items: MARKED } }],
    [DISCOVERY_CREATE_RULE_TOOL_ID, { name: 'r', actions: MARKED }],
    [FUNNELS_DRAFT_TOOL_ID, { name: 'f', funnelId: 'f1', steps: MARKED }],
  ];
  for (const [id, input] of cases) {
    it(`${id} refuses with ${COMPACTION_MARKER_IN_INPUT}, naming the path`, async () => {
      const tool = builtinAgentTool(id);
      expect(tool, `${id} must be registered`).toBeTruthy();
      const out = await tool!.run(input, { tenantId: 't-none' } as never);
      expect(out.isError).toBe(true);
      const body = JSON.parse(out.content) as { error: string; message: string; detail?: string };
      expect(body.error).toBe(COMPACTION_MARKER_IN_INPUT);
      // TOC2CD-11 (ADR 1000, Codex): the marker path is derived from INPUT keys, so it is the
      // fenced `detail`; the recovery sentence is a host literal.
      expect(body.detail).toContain('[1]');
      expect(body.message).toMatch(/^Input contains a tool-output compaction marker/);
    });
  }
});
