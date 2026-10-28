/**
 * ADR 0889 residue (post-merge review M4, L1, L5 + D2 pack-shipped suites).
 *
 *   - M4: the capture list reads a per-(agent, run) index, never the tenant's
 *     whole tool-boundary store; erasure keeps the index honest.
 *   - L1: two concurrent eval runs of one suite on a test host do not consume
 *     each other's scripted mock rounds.
 *   - L5: promote refuses a run captured from a different agent than the suite targets.
 *   - D2: a suite shipped in an agent pack (`evalSuiteRef`) loads from `evals/`,
 *     survives the closed-world install shape, lists read-only, runs, and shows
 *     in the run history.
 * (TST-BPA)
 *
 * Red when (sabotage-witnessed, wave 65): the capture list goes back to a tenant-wide
 * prefix read, erasure stops re-deriving the index, or the 4-char floor on erasure
 * forms is dropped ⇒ M4; the mock node id loses its run id ⇒ L1; promote stops
 * refusing a foreign agent's capture ⇒ L5; the installed-subdir predicate accepts any
 * two-segment ref ⇒ NP-EVAL-4. L1's `lastReceivedMessages` line pins the run-scoped
 * key; the pass/fail pair is the behaviour.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubjectToolBoundary, listCapturedRuns, maybeCaptureExecuteTool, setCaptureSetting } from '../src/host/evals/toolBoundary.js';
import { evalSuiteRefSurvivesInstall, loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import type { ExecuteAgentTool } from '../src/host/agentDispatch.js';
import { INSTALLED_PACK_SUBDIRS } from '../src/packs/packContentDigest.js';
import { attestPackDir } from './setup/attestPackFixture.js';
import { lastReceivedMessages } from '../src/providers/dispatchMock.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const TOOL = 'openwop:schema.lookup';
const AGENT = 'eval.residue-agent';
const OTHER = 'eval.residue-other';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const agentId of [AGENT, OTHER]) {
    getAgentRegistry().register({
      agentId, persona: 'Eval subject', modelClass: 'research', systemPrompt: 'Answer.',
      packName: 'test', packVersion: '0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
    });
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted */ }
  return { status: res.status, json, text };
}

async function waitTerminal(runId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const r = await send('GET', `/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(String(r.json['status'] ?? ''))) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}

const rounds = (output: string) => [{ toolCalls: [{ name: TOOL, input: { kind: 'node' } }] }, { content: output }];
const goldenSuite = (suiteId: string, extra: Record<string, unknown> = {}) => ({
  suiteId, version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 }, ...extra,
  tasks: [{
    taskId: 'lookup', input: { q: 'hi' },
    expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } },
    fixtures: { toolResponses: [{ tool: TOOL, response: { ok: true } }] },
  }],
});

describe('review M4 — the capture list is an index read, not a tenant scan', () => {
  it('lists captured runs without a tenant-wide prefix read, and erasure re-derives the index', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    const ok: ExecuteAgentTool = async () => ({ content: '{"ok":true}' });
    const exec = await maybeCaptureExecuteTool(ok, { tenantId: TENANT, runId: 'r-m4', agentId: AGENT });
    await exec({ name: 'crm:lookup', input: { email: 'bob@example.com' } });
    await exec({ name: 'crm:lookup', input: { id: 'ACCT-42' } });

    const spy = vi.spyOn(DurableCollection.prototype, 'listByPrefix');
    try {
      const runs = await listCapturedRuns(TENANT, AGENT);
      expect(runs.find((r) => r.runId === 'r-m4')?.calls).toBe(2);
      // The old shape read `${tenant}:` — every captured call of every agent.
      expect(spy.mock.calls.map((c) => c[0])).not.toContain(`${TENANT}:`);
    } finally {
      spy.mockRestore();
    }

    await eraseSubjectToolBoundary(TENANT, 'bob@example.com');
    expect((await listCapturedRuns(TENANT, AGENT)).find((r) => r.runId === 'r-m4')?.calls).toBe(1);
    // EVD-11 — a form under 4 chars matches unrelated text, so it erases nothing.
    await eraseSubjectToolBoundary(TENANT, '42');
    expect((await listCapturedRuns(TENANT, AGENT)).find((r) => r.runId === 'r-m4')?.calls).toBe(1);
    await eraseSubjectToolBoundary(TENANT, 'ACCT-42');
    expect((await listCapturedRuns(TENANT, AGENT)).find((r) => r.runId === 'r-m4')).toBeUndefined();
  });
});

describe('review L1 — concurrent eval runs keep their own scripted rounds', () => {
  it('two runs of one suite, started together, each grade their own mock output', async () => {
    const put = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.l1@1.0.0', goldenSuite('test.acme.evals.l1'));
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const start = (output: string) => send('POST', '/runs', {
      mode: 'eval', evalSuiteRef: 'test.acme.evals.l1@1.0.0', agentId: AGENT,
      configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds(output) } } },
    });
    const [pass, fail] = await Promise.all([start('all done'), start('nope')]);
    expect(pass.status, pass.text.slice(0, 300)).toBe(201);
    expect(fail.status, fail.text.slice(0, 300)).toBe(201);
    const ids = [String(pass.json['runId']), String(fail.json['runId'])];
    await Promise.all(ids.map(waitTerminal));
    const [a, b] = await Promise.all(ids.map((id) => send('GET', `/runs/${id}/eval-summary`)));
    expect(a!.json['passed'], a!.text.slice(0, 300)).toBe(true);
    expect(b!.json['passed'], b!.text.slice(0, 300)).toBe(false);
    // The mock program is keyed by the RUN-scoped node id (a shared `eval:<task>:<trial>`
    // key is what let one run's program be overwritten by another's).
    for (const id of ids) {
      const stored = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
      expect(lastReceivedMessages(`eval:${stored}:lookup:0`), id).not.toBeNull();
    }
  });
});

describe('review L5 — promote checks the captured agent against the suite target', () => {
  it('a run captured from another agent is a typed 400 unless overridden', async () => {
    const put = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.l5@1.0.0', { ...goldenSuite('test.acme.evals.l5'), targetAgentId: AGENT });
    expect(put.status, put.text.slice(0, 300)).toBe(200);
    const created = await send('POST', '/runs', { workflowId: 'conformance-noop', inputs: { q: 'x' } });
    expect(created.status, created.text.slice(0, 200)).toBe(201);
    const runId = String(created.json['runId']);
    const storedId = runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId;
    await setCaptureSetting(TENANT, OTHER, true);
    const ok: ExecuteAgentTool = async () => ({ content: '{"ok":true}' });
    const exec = await maybeCaptureExecuteTool(ok, { tenantId: TENANT, runId: storedId, agentId: OTHER });
    await exec({ name: TOOL, input: {} });

    const refused = await send('POST', '/host/openwop-app/agent-evals/suites/test.acme.evals.l5@1.0.0/tasks', { fromRunId: runId });
    expect(refused.status, refused.text.slice(0, 300)).toBe(400);
    expect((refused.json['details'] as Record<string, unknown>)['reason']).toBe('agent_mismatch');
    const forced = await send('POST', '/host/openwop-app/agent-evals/suites/test.acme.evals.l5@1.0.0/tasks', { fromRunId: runId, overrideTargetAgent: true });
    expect(forced.status, forced.text.slice(0, 300)).toBe(201);
  });
});

describe('ADR 0889 D2 — pack-shipped suites (RFC 0081 §A evalSuiteRef)', () => {
  const PACK = 'local.evalpack.agents';
  const PACK_AGENT = `${PACK}.subject`;
  let dir = '';
  let loadedIds: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'evalpack-'));
    mkdirSync(join(dir, 'evals'), { recursive: true });
    writeFileSync(join(dir, 'evals', 'subject.json'), JSON.stringify(goldenSuite(`${PACK}.evals.subject`)));
    writeFileSync(join(dir, 'evals', 'broken.json'), JSON.stringify({ suiteId: 'x' }));
    // NP-EVAL-6 — a pack suite naming ANOTHER agent resolves only through its shipper.
    writeFileSync(join(dir, 'evals', 'foreign.json'), JSON.stringify(goldenSuite(`${PACK}.evals.foreign`, { targetAgentId: PACK_AGENT })));
    writeFileSync(join(dir, 'pack.json'), JSON.stringify({
      name: PACK, version: '1.2.3', nodes: [],
      agents: [
        { agentId: PACK_AGENT, persona: 'Pack subject', modelClass: 'research', systemPrompt: 'Answer.', toolAllowlist: [TOOL], evalSuiteRef: 'evals/subject.json' },
        { agentId: `${PACK}.broken`, persona: 'Broken suite', modelClass: 'research', systemPrompt: 'Answer.', evalSuiteRef: 'evals/broken.json' },
        { agentId: `${PACK}.escape`, persona: 'Escaping suite', modelClass: 'research', systemPrompt: 'Answer.', evalSuiteRef: '../../../etc/passwd' },
        { agentId: `${PACK}.shipper`, persona: 'Foreign suite', modelClass: 'research', systemPrompt: 'Answer.', evalSuiteRef: 'evals/foreign.json' },
      ],
    }));
    attestPackDir(dir);
    loadedIds = loadAgentsFromManifest(dir).map((a) => a.agentId).sort();
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('loads: a bad suite file costs the suite, never the agent; an escaping ref loads no suite', () => {
    expect(INSTALLED_PACK_SUBDIRS.has('evals')).toBe(true);
    expect(loadedIds).toEqual([`${PACK}.broken`, `${PACK}.escape`, `${PACK}.shipper`, PACK_AGENT].sort());
    expect(getAgentRegistry().get(`${PACK}.escape`)?.evalSuite).toBeUndefined();
    expect(getAgentRegistry().get(`${PACK}.shipper`)?.evalSuite).toBeDefined();
  });

  it('lists the pack suite read-only (locked, source pack), and not the invalid one', async () => {
    const r = await send('GET', `/host/openwop-app/agent-evals/suites?agentId=${PACK_AGENT}`);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    const items = r.json['items'] as Array<{ ref: string; locked: boolean; source: string; pack?: string; suite: { targetAgentId?: string } }>;
    const mine = items.find((i) => i.ref === `${PACK}.evals.subject@1.0.0`);
    expect(mine).toMatchObject({ locked: true, source: 'pack', pack: `${PACK}@1.2.3` });
    expect(mine?.suite.targetAgentId).toBe(PACK_AGENT);
    const all = await send('GET', '/host/openwop-app/agent-evals/suites');
    expect(JSON.stringify(all.json)).not.toContain(`${PACK}.broken`);
    // NP-EVAL-6 — listed for its target it would 404 on run, so it is not listed at all.
    expect(JSON.stringify(all.json)).not.toContain(`${PACK}.evals.foreign`);
    // Read-only: it is not in the tenant store, so delete is a 404 — and the pack
    // suite still lists after it (M11: this used to name a ref that never existed).
    expect((await send('DELETE', `/host/openwop-app/agent-evals/suites/${PACK}.evals.subject@1.0.0`)).status).toBe(404);
    expect(((await send('GET', `/host/openwop-app/agent-evals/suites/${PACK}.evals.subject@1.0.0`)).json as { source?: string }).source).toBe('pack');
  });

  it('runs by suite ref and by manifest ref, stamps provenance, and shows in the history', async () => {
    for (const ref of [`${PACK}.evals.subject@1.0.0`, 'evals/subject.json']) {
      const c = await send('POST', '/runs', {
        mode: 'eval', evalSuiteRef: ref, agentId: PACK_AGENT,
        configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds('all done') } } },
      });
      expect(c.status, c.text.slice(0, 300)).toBe(201);
      const runId = String(c.json['runId']);
      await waitTerminal(runId);
      const s = await send('GET', `/runs/${runId}/eval-summary`);
      expect(s.json, s.text.slice(0, 300)).toMatchObject({ suiteId: `${PACK}.evals.subject`, passed: true });
    }
    const history = await send('GET', `/host/openwop-app/agent-evals/runs?agentId=${PACK_AGENT}`);
    const items = history.json['items'] as Array<{ suiteRef: string; status: string }>;
    expect(items.filter((i) => i.suiteRef === `${PACK}.evals.subject@1.0.0`)).toHaveLength(2);
  });

  it('NP-EVAL-4 — only a suite under an installed subdir loads (an install would drop any other)', () => {
    // An attested fixture cannot even hold a root-level file (the closed-world
    // content check refuses it), so the loader's predicate is witnessed directly:
    // a vendored dev mount is where such a ref used to load and then vanish.
    for (const ok of ['evals/subject.json', './evals/x.json', 'prompts/x.json']) expect(evalSuiteRefSurvivesInstall(ok), ok).toBe(true);
    for (const bad of ['suite.json', './suite.json', 'tests/x.json', 'lib/evals/x.json']) expect(evalSuiteRefSurvivesInstall(bad), bad).toBe(false);
  });

  it('another agent cannot reach the pack suite by its ref', async () => {
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${PACK}.evals.subject@1.0.0`, agentId: AGENT });
    expect(c.status, c.text.slice(0, 300)).toBe(404);
    expect(c.json['error']).toBe('not_found');
    expect(c.json['message']).toBe(`Eval suite ${PACK}.evals.subject@1.0.0 was not found.`);
  });
});
