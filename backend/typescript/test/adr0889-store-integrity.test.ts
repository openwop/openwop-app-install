/**
 * ADR 0889 grade remediation (A2) — the suite store, run create, routes and the
 * error-detail contracts the Evals tab localizes on.
 *
 * Why this exists: the grade passes found the suite lock was a get-then-put
 * (EVD-1/EVAL-2: a "locked" version could still change under a run that
 * referenced it), promotes lost updates (EVD-4), a refused insert locked a draft
 * forever (EVD-9), a non-completed baseline silently dropped the regression
 * verdict (EVD-3), `allowedModels` and unsupported `configurable` sections were
 * accepted and ignored (AEV-4, WF-EV-9), and every refusal was English prose the
 * client could not localize (BE-2/AE-4). Each `it` names its finding.
 *
 * Sabotage-witnessed (each reverted, red, restored):
 *  - `putEvalSuite`/`lockEvalSuite` back to get-then-put ⇒ "lock and PUT race";
 *  - `updateEvalSuite` back to get-then-put ⇒ "concurrent promotes";
 *  - the `unlockEvalSuite` catch removed ⇒ "a refused insert";
 *  - the resume digest compare removed ⇒ both resume cases (NP-EVAL-5, WF-EV-8).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  eraseSubjectEvalSuites, evalWorkflowId, getEvalSuite, lockEvalSuite, putEvalSuite, suiteDigest, updateEvalSuite, validateEvalSuite,
  MAX_RUBRIC_CRITERIA, MAX_TASKS_PER_SUITE, type AgentEvalSuite,
} from '../src/host/evals/suiteStore.js';
import { createAgentEvalRun } from '../src/host/evals/createEvalRun.js';
import { resumeAgentEvalRun } from '../src/host/evals/resumeEvalRun.js';
import { AGENT_SUITE_KIND } from '../src/host/evals/agentEvalRun.js';
import { resetRfc0244WireCache, resetRfc0245WireCache } from '../src/host/evals/evalCapability.js';
import { maybeCaptureExecuteTool, setCaptureSetting } from '../src/host/evals/toolBoundary.js';
import { OpenwopError, type RunRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const AGENT = 'eval.integrity-agent';
const PACK_AGENT = 'eval.integrity-pack-agent';
const TOOL = 'openwop:schema.lookup';
const PACK_SUITE = {
  suiteId: 'test.pack.evals.shipped', version: '2.0.0', modes: ['golden'],
  tasks: [{ taskId: 'p', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Integrity subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
  });
  getAgentRegistry().register({
    agentId: PACK_AGENT, persona: 'Pack subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test.pack', packVersion: '2.0.0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
    evalSuiteRef: 'evals/shipped.json', evalSuite: PACK_SUITE,
  });
});
afterAll(async () => {
  resetRfc0244WireCache();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => resetRfc0244WireCache());

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted */ }
  return { status: res.status, json, text };
}
const details = (r: Reply): Record<string, unknown> => (r.json['details'] ?? {}) as Record<string, unknown>;

const golden = (suiteId: string, value = 'done', extra: Record<string, unknown> = {}): AgentEvalSuite => validateEvalSuite({
  suiteId, version: '1.0.0', modes: ['golden'], thresholds: { passScore: 1 }, ...extra,
  tasks: [{ taskId: 'lookup', input: { q: 'hi' }, expected: { kind: 'golden', match: { strategy: 'contains', value } }, fixtures: { toolResponses: [{ tool: TOOL, response: { ok: true } }] } }],
});
const rounds = (output: string) => [{ toolCalls: [{ name: TOOL, input: { kind: 'node' } }] }, { content: output }];
const mock = (taskId = 'lookup', output = 'all done') => ({ mockProvider: { id: 'tool-calls', rounds: { [taskId]: rounds(output) } } });

async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const status = String(((await send('GET', `/runs/${runId}`)).json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}
const storedId = (wireId: string): string => (wireId.includes('/') ? wireId.slice(wireId.indexOf('/') + 1) : wireId);

describe('EVD-1 / EVAL-2 — the suite lock is one compare-and-swap on the resolved content', () => {
  it('a lock against content that changed is 409 suite_changed and leaves the new content unlocked', async () => {
    const v1 = await putEvalSuite(TENANT, golden('test.acme.evals.cas1', 'one'));
    await putEvalSuite(TENANT, golden('test.acme.evals.cas1', 'two'));
    await expect(lockEvalSuite(TENANT, 'test.acme.evals.cas1@1.0.0', suiteDigest(v1.suite))).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'suite_changed' } });
    const row = await getEvalSuite(TENANT, 'test.acme.evals.cas1@1.0.0');
    expect(row?.lockedAt).toBeUndefined();
    expect(JSON.stringify(row?.suite)).toContain('two');
  });

  it('lock and PUT race: the version is never locked holding content the lock did not see, and a lock is never erased', async () => {
    for (let i = 0; i < 25; i += 1) {
      const id = `test.acme.evals.race${i}`;
      const v1 = await putEvalSuite(TENANT, golden(id, 'one'));
      const [put, lock] = await Promise.allSettled([
        putEvalSuite(TENANT, golden(id, 'two')),
        lockEvalSuite(TENANT, `${id}@1.0.0`, suiteDigest(v1.suite)),
      ]);
      const row = (await getEvalSuite(TENANT, `${id}@1.0.0`))!;
      if (lock.status === 'fulfilled') {
        // The lock won: the stored content IS what it locked, and the PUT was refused.
        expect(row.lockedAt, `iteration ${i}`).toBeTruthy();
        expect(suiteDigest(row.suite), `iteration ${i}`).toBe(suiteDigest(v1.suite));
        expect(put.status, `iteration ${i}`).toBe('rejected');
      } else {
        // The PUT won: the lock refused, naming why; nothing locked.
        expect((lock.reason as OpenwopError).details).toMatchObject({ reason: 'suite_changed' });
        expect(row.lockedAt, `iteration ${i}`).toBeUndefined();
        expect(put.status).toBe('fulfilled');
      }
    }
  });

  it('every run source is digest-stamped (it was pack-only) — a tenant suite run carries its content digest', async () => {
    const stored = await putEvalSuite(TENANT, golden('test.acme.evals.digest'));
    const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.digest@1.0.0', agentId: AGENT, configurable: mock() });
    expect(c.status, c.text.slice(0, 300)).toBe(201);
    const run = await hostExtStorage().getRun(storedId(String(c.json['runId'])));
    expect((run?.metadata?.eval as { suiteDigest?: string }).suiteDigest).toBe(suiteDigest(stored.suite));
    expect((await getEvalSuite(TENANT, 'test.acme.evals.digest@1.0.0'))?.lockedAt).toBeTruthy();
    await waitTerminal(String(c.json['runId']));
  });
});

describe('EVD-4 — concurrent promotes both land', () => {
  it('five parallel task appends to one version all survive', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.appends'));
    await Promise.all([0, 1, 2, 3, 4].map((n) => updateEvalSuite(TENANT, 'test.acme.evals.appends@1.0.0', (row) => validateEvalSuite({
      ...row.suite,
      tasks: [...row.suite.tasks, { taskId: `added-${n}`, input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    }))));
    const ids = (await getEvalSuite(TENANT, 'test.acme.evals.appends@1.0.0'))!.suite.tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual(['added-0', 'added-1', 'added-2', 'added-3', 'added-4', 'lookup']);
  });
});

describe('EVD-9 — a refused run insert releases the lock it took', () => {
  it('the draft stays editable when the insert throws', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.refused'));
    const real = hostExtStorage();
    const refusing = new Proxy(real, {
      get(target, prop, recv) {
        if (typeof prop === 'string' && prop.startsWith('insertRun')) return async () => { throw new OpenwopError('rate_limited', 'run limit', 429); };
        const v = Reflect.get(target, prop, recv) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Storage;
    await expect(createAgentEvalRun({
      caller: { actingUserId: 'u-1' }, storage: refusing, tenantId: TENANT,
      body: { mode: 'eval', evalSuiteRef: 'test.acme.evals.refused@1.0.0', agentId: AGENT },
    })).rejects.toMatchObject({ httpStatus: 429 });
    expect((await getEvalSuite(TENANT, 'test.acme.evals.refused@1.0.0'))?.lockedAt).toBeUndefined();
    // … and a lock this create did NOT take is left alone.
    const row = (await getEvalSuite(TENANT, 'test.acme.evals.refused@1.0.0'))!;
    await lockEvalSuite(TENANT, 'test.acme.evals.refused@1.0.0', suiteDigest(row.suite));
    await expect(createAgentEvalRun({
      caller: { actingUserId: 'u-1' }, storage: refusing, tenantId: TENANT,
      body: { mode: 'eval', evalSuiteRef: 'test.acme.evals.refused@1.0.0', agentId: AGENT },
    })).rejects.toMatchObject({ httpStatus: 429 });
    expect((await getEvalSuite(TENANT, 'test.acme.evals.refused@1.0.0'))?.lockedAt).toBeTruthy();
  });
});

describe('suite routes — the contracts stream B localizes on', () => {
  it('?create=true is insert-only (409 suite_exists); a locked version is 409 suite_locked; a pack ref is 409 pack_suite_ref', async () => {
    const body = golden('test.acme.evals.create');
    const first = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.create@1.0.0?create=true', body);
    expect(first.status, first.text.slice(0, 200)).toBe(200);
    const again = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.create@1.0.0?create=true', { ...body, tasks: [{ ...body.tasks[0], taskId: 'other' }] });
    expect(again.status).toBe(409);
    expect(details(again)).toMatchObject({ reason: 'suite_exists', suiteRef: 'test.acme.evals.create@1.0.0' });
    expect((await getEvalSuite(TENANT, 'test.acme.evals.create@1.0.0'))!.suite.tasks[0]!.taskId).toBe('lookup');
    // Without create=true the editor's save still upserts.
    expect((await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.create@1.0.0', body)).status).toBe(200);

    const stored = (await getEvalSuite(TENANT, 'test.acme.evals.create@1.0.0'))!;
    await lockEvalSuite(TENANT, 'test.acme.evals.create@1.0.0', suiteDigest(stored.suite));
    const locked = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.create@1.0.0', body);
    expect(locked.status).toBe(409);
    expect(details(locked)['reason']).toBe('suite_locked');

    const pack = await send('PUT', '/host/openwop-app/agent-evals/suites/test.pack.evals.shipped@2.0.0', PACK_SUITE);
    expect(pack.status).toBe(409);
    expect(details(pack)['reason']).toBe('pack_suite_ref');
  });

  it('EVAL-11 — GET suites/:ref serves a pack suite the list returns', async () => {
    const r = await send('GET', '/host/openwop-app/agent-evals/suites/test.pack.evals.shipped@2.0.0');
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json).toMatchObject({ ref: 'test.pack.evals.shipped@2.0.0', source: 'pack', locked: true, pack: 'test.pack@2.0.0' });
  });

  it('BE-2 / AEV-3 — validation carries a machine-readable rule and its params', async () => {
    const put = (body: unknown, ref = 'test.acme.evals.rules@1.0.0') => send('PUT', `/host/openwop-app/agent-evals/suites/${ref}`, body);
    const base = { suiteId: 'test.acme.evals.rules', version: '1.0.0', modes: ['golden'] };
    const task = (expected: unknown, taskId = 't') => ({ taskId, input: {}, expected });

    const range = await put({ ...base, thresholds: { passScore: 2 }, tasks: [task({ kind: 'golden', match: { strategy: 'exact', value: 'x' } })] });
    expect(details(range)).toMatchObject({ field: 'thresholds.passScore', rule: 'range', params: { min: 0, max: 1, integer: false } });

    const pattern = await put({ ...base, tasks: [task({ kind: 'golden', match: { strategy: 'exact', value: 'x' } }, 'Bad Id')] });
    expect(details(pattern)).toMatchObject({ field: 'tasks[0].taskId', rule: 'pattern' });
    expect(typeof (details(pattern)['params'] as Record<string, unknown>)['pattern']).toBe('string');

    const unknown = await put({ ...base, extra: 1, tasks: [] });
    expect(details(unknown)).toMatchObject({ field: 'suite.extra', rule: 'unknown_property' });

    const en = await put({ ...base, tasks: [task({ kind: 'golden', match: { strategy: 'fuzzy', value: 'x' } })] });
    expect(details(en)).toMatchObject({ field: 'tasks[0].expected.match.strategy', rule: 'enum', params: { values: ['exact', 'contains', 'json-match'] } });

    const required = await put({ ...base, tasks: [{ taskId: 't', expected: { kind: 'golden', match: { strategy: 'exact', value: 'x' } } }] });
    expect(details(required)).toMatchObject({ field: 'tasks[0].input', rule: 'required' });

    const dup = await put({ ...base, tasks: [task({ kind: 'golden', match: { strategy: 'exact', value: 'x' } }), task({ kind: 'golden', match: { strategy: 'exact', value: 'y' } })] });
    expect(details(dup)).toMatchObject({ field: 'tasks', rule: 'duplicate', params: { value: 't' } });

    // AEV-3 — the rubric size IS the judge spend, so both dimensions are capped.
    const many = await put({ ...base, modes: ['rubric'], tasks: [task({ kind: 'rubric', rubric: Array.from({ length: MAX_RUBRIC_CRITERIA + 1 }, (_, i) => ({ criterion: `c${i}`, weight: 1 })) })] });
    expect(details(many)).toMatchObject({ field: 'tasks[0].expected.rubric', rule: 'too_many', params: { max: MAX_RUBRIC_CRITERIA } });
    const long = await put({ ...base, modes: ['rubric'], tasks: [task({ kind: 'rubric', rubric: [{ criterion: 'x'.repeat(1001), weight: 1 }] })] });
    expect(details(long)).toMatchObject({ field: 'tasks[0].expected.rubric[0].criterion', rule: 'too_large', params: { max: 1000 } });
    // A rubric on a golden task is validated (and capped) too — it used to be stored unchecked.
    const stray = await put({ ...base, tasks: [task({ kind: 'golden', match: { strategy: 'exact', value: 'x' }, rubric: [{ criterion: '', weight: 1 }] })] });
    expect(details(stray)).toMatchObject({ field: 'tasks[0].expected.rubric[0].criterion', rule: 'type' });
  });

  it('EVD-5 — the capture switch 404s for an agent the tenant cannot resolve', async () => {
    const r = await send('PUT', '/host/openwop-app/agent-evals/capture/not.an.agent', { enabled: true });
    expect(r.status).toBe(404);
    expect(details(r)['field']).toBe('agentId');
  });
});

describe('promote — typed reasons (AE-4) and the errored-call stopgap (AEV-6)', () => {
  it('missing_run, nothing_captured and errored_call are distinct reasons', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.promote'));
    const path = '/host/openwop-app/agent-evals/suites/test.acme.evals.promote@1.0.0/tasks';

    const absent = await send('POST', path, {});
    expect(absent.status).toBe(400);
    expect(details(absent)).toMatchObject({ field: 'fromRunId', rule: 'required', reason: 'missing_run' });
    const notFound = await send('POST', path, { fromRunId: 'no-such-run' });
    expect(notFound.status).toBe(404);
    expect(details(notFound)).toMatchObject({ field: 'fromRunId', reason: 'missing_run' });

    const empty = await send('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    const nothing = await send('POST', path, { fromRunId: String(empty.json['runId']) });
    expect(nothing.status).toBe(400);
    expect(details(nothing)).toMatchObject({ field: 'fromRunId', reason: 'nothing_captured' });

    // A run whose recorded calls include a FAILURE. WITHOUT RFC 0245's advert the
    // fixture has no error field, so a replay would serve it as a success: refused,
    // naming the calls. (With the advert it is promoted as an isError entry: below.)
    resetRfc0245WireCache(false);
    await setCaptureSetting(TENANT, AGENT, true);
    const run = await send('POST', '/runs', { workflowId: 'conformance-noop', inputs: { q: 'x' } });
    const id = storedId(String(run.json['runId']));
    const exec = await maybeCaptureExecuteTool(async (call) => (call.name === 'billing:refund' ? { content: '{"error":"upstream_down"}', isError: true } : { content: '{"ok":true}' }), { tenantId: TENANT, runId: id, agentId: AGENT });
    await exec({ name: 'crm:lookup', input: {} } as Parameters<typeof exec>[0]);
    await exec({ name: 'billing:refund', input: {} } as Parameters<typeof exec>[0]);
    const errored = await send('POST', path, { fromRunId: String(run.json['runId']) });
    expect(errored.status, errored.text.slice(0, 300)).toBe(400);
    expect(details(errored)).toMatchObject({ field: 'fromRunId', reason: 'errored_call' });
    expect((details(errored)['params'] as { calls: Array<Record<string, unknown>> }).calls).toEqual([expect.objectContaining({ tool: 'billing:refund', seq: 1 })]);
    // Nothing was appended.
    expect((await getEvalSuite(TENANT, 'test.acme.evals.promote@1.0.0'))!.suite.tasks).toHaveLength(1);

    // ADR 0929 — with `agents.evalSuite.fixtureErrors` advertised, the same run is
    // promoted, and the failure is kept a failure: an `isError: true` entry.
    resetRfc0245WireCache();
    const promoted = await send('POST', path, { fromRunId: String(run.json['runId']) });
    expect(promoted.status, promoted.text.slice(0, 300)).toBe(201);
    const tasks = (await getEvalSuite(TENANT, 'test.acme.evals.promote@1.0.0'))!.suite.tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.fixtures?.toolResponses?.map((r) => [r.tool, r.isError === true])).toEqual([['crm:lookup', false], ['billing:refund', true]]);
  });
});

describe('POST /runs {mode:"eval"} — refusals that used to be silent', () => {
  it('WF-EV-9 — an unsupported configurable section is refused by name, not ignored', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.cfg'));
    const r = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.cfg@1.0.0', agentId: AGENT, configurable: { run: { runTimeoutMs: 5 } } });
    expect(r.status).toBe(400);
    expect(details(r)).toMatchObject({ field: 'configurable.run', reason: 'unsupported_configurable' });
  });

  it('AEV-4 — a suite\'s allowedModels is enforced against the agent\'s model class', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.models', 'done', { allowedModels: ['coding'] }));
    const r = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.models@1.0.0', agentId: AGENT });
    expect(r.status).toBe(400);
    expect(details(r)).toMatchObject({ field: 'agentId', reason: 'model_class_not_allowed', params: { modelClass: 'research', allowedModels: ['coding'] } });
    // Nothing referenced it, so it stays editable.
    expect((await getEvalSuite(TENANT, 'test.acme.evals.models@1.0.0'))?.lockedAt).toBeUndefined();
  });

  it('EVAL-6 — a suite targeting the legacy spelling runs against the canonical id (ADR 0763)', async () => {
    getAgentRegistry().register({
      agentId: 'vendor.openwop-app.evals.agents.spelled', persona: 'Spelled', modelClass: 'research', systemPrompt: 'Answer.',
      packName: 'test', packVersion: '0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
    });
    await putEvalSuite(TENANT, golden('test.acme.evals.spelling', 'done', { targetAgentId: 'feature.evals.agents.spelled' }));
    const ok = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.spelling@1.0.0', agentId: 'vendor.openwop-app.evals.agents.spelled', configurable: mock() });
    expect(ok.status, ok.text.slice(0, 300)).toBe(201);
    await waitTerminal(String(ok.json['runId']));
    const other = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.spelling@1.0.0', agentId: AGENT });
    expect(details(other)).toMatchObject({ field: 'agentId', reason: 'target_agent_mismatch' });
  });

  it('M7 — the remaining RFC 0244 §G refusals and the host task cap name their field', async () => {
    resetRfc0244WireCache(false);
    const refused = async (suite: AgentEvalSuite, field: string): Promise<void> => {
      await putEvalSuite(TENANT, suite);
      const r = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: `${suite.suiteId}@1.0.0`, agentId: AGENT });
      expect(r.status, `${field}: ${r.text.slice(0, 200)}`).toBe(400);
      expect(details(r)['field']).toBe(field);
      expect((await getEvalSuite(TENANT, `${suite.suiteId}@1.0.0`))?.lockedAt).toBeUndefined();
    };
    await refused(validateEvalSuite({
      suiteId: 'test.acme.evals.g-traj', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 't', input: {}, expected: { kind: 'trajectory', trajectory: { match: 'in-order', calls: [{ tool: TOOL }] } } }],
    }), 'tasks.expected.trajectory');
    await refused(validateEvalSuite({
      suiteId: 'test.acme.evals.g-fix', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'exact', value: 'x' } }, fixtures: { onMiss: 'fail' } }],
    }), 'tasks.fixtures');
    resetRfc0244WireCache(true);
    await refused(golden('test.acme.evals.g-maxtrials', 'done', { trials: { count: 11 } }), 'trials.count');
    await refused(validateEvalSuite({
      suiteId: 'test.acme.evals.g-tasks', version: '1.0.0', modes: ['golden'],
      tasks: Array.from({ length: MAX_TASKS_PER_SUITE + 1 }, (_, i) => ({ taskId: `t${i}`, input: {}, expected: { kind: 'golden', match: { strategy: 'exact', value: 'x' } } })),
    }), 'tasks');
  });
});

describe('EVD-3 / M4 — the regression baseline', () => {
  it('a baseline that is not completed with a summary is refused; another suite\'s run is refused; a completed one yields a verdict', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.reg'));
    const baseline = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.reg@1.0.0', agentId: AGENT, configurable: mock() });
    expect(baseline.status, baseline.text.slice(0, 200)).toBe(201);
    const baseId = String(baseline.json['runId']);
    expect(await waitTerminal(baseId)).toBe('completed');

    // A failed eval run of the SAME suite: it has no summary, so no verdict could come of it.
    const failedId = `failed-${Date.now()}`;
    const failedRun: RunRecord = {
      runId: failedId, workflowId: 'eval:test.acme.evals.reg@1.0.0', tenantId: TENANT, status: 'failed', inputs: {},
      metadata: { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.reg@1.0.0', suiteSource: 'tenant', agentId: AGENT } },
      configurable: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await hostExtStorage().insertRun(failedRun);
    const notDone = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.reg@1.0.0', agentId: AGENT, configurable: { ...mock(), baselineRunId: failedId } });
    expect(notDone.status).toBe(400);
    expect(details(notDone)).toMatchObject({ field: 'configurable.baselineRunId', reason: 'baseline_not_completed', params: { status: 'failed' } });

    await putEvalSuite(TENANT, golden('test.acme.evals.reg-other'));
    const otherSuite = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.reg-other@1.0.0', agentId: AGENT, configurable: { ...mock(), baselineRunId: baseId } });
    expect(otherSuite.status).toBe(400);
    expect(details(otherSuite)).toMatchObject({ field: 'configurable.baselineRunId', reason: 'baseline_other_suite' });

    const candidate = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.reg@1.0.0', agentId: AGENT, configurable: { ...mock(), baselineRunId: baseId } });
    expect(candidate.status, candidate.text.slice(0, 200)).toBe(201);
    expect(await waitTerminal(String(candidate.json['runId']))).toBe('completed');
    const summary = await send('GET', `/runs/${String(candidate.json['runId'])}/eval-summary`);
    expect(summary.status).toBe(200);
    const regression = (summary.json['regression'] ?? (summary.json as { regression?: unknown }).regression) as Record<string, unknown> | undefined;
    expect(regression, summary.text.slice(0, 400)).toBeTruthy();
    expect(typeof regression!['verdict']).toBe('string');
  });
});

describe('M6 — GET /runs/:id/eval-summary', () => {
  it('is 409 while the eval run is not terminal', async () => {
    const now = new Date().toISOString();
    const evalMeta = { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.reg@1.0.0', suiteSource: 'tenant', agentId: AGENT } };
    // A summary already present (e.g. a partial write) must not be served before
    // the run is terminal-completed: the STATUS decides, not the summary's presence.
    const running: RunRecord = { runId: `running-${Date.now()}`, workflowId: 'eval:test.acme.evals.reg@1.0.0', tenantId: TENANT, status: 'running', inputs: {}, metadata: { ...evalMeta, evalSummary: { passed: true } }, configurable: {}, createdAt: now, updatedAt: now };
    await hostExtStorage().insertRun(running);
    const r = await send('GET', `/runs/${TENANT}/${running.runId}/eval-summary`);
    expect(r.status, r.text.slice(0, 300)).toBe(409);
    expect(details(r)).toMatchObject({ status: 'running' });

    // Cross-tenant: this route reads through `loadReadableRun`, the SAME gate as
    // `GET /runs/:id` (its tenant arm is covered with that route's tests). It is not
    // re-witnessed here because `dev-token` is the wildcard operator, which reads
    // across tenants by design.
  });
});

describe('EVAL-10 — the history is agent-scoped and paged', () => {
  it('pages with an opaque cursor, newest first, with no duplicates or gaps', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.hist'));
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.hist@1.0.0', agentId: AGENT, configurable: mock() });
      ids.push(storedId(String(c.json['runId'])));
      await waitTerminal(String(c.json['runId']));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const r = await send('GET', `/host/openwop-app/agent-evals/runs?agentId=${AGENT}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      const items = r.json['items'] as Array<{ runId: string; createdAt: string; agentId: string }>;
      expect(items.length).toBeLessThanOrEqual(2);
      expect(items.every((x) => x.agentId === AGENT)).toBe(true);
      seen.push(...items.map((x) => storedId(x.runId)));
      cursor = r.json['nextCursor'] as string | undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    expect((await send('GET', '/host/openwop-app/agent-evals/runs?cursor=garbage')).status).toBe(400);
    expect((await send('GET', '/host/openwop-app/agent-evals/runs?limit=0')).status).toBe(400);
  });
});

describe('resume refuses a suite whose content changed (NP-EVAL-5 pack, WF-EV-8 tenant)', () => {
  const orphan = (suiteRef: string, suiteSource: 'tenant' | 'pack', digest: string, agentId: string): RunRecord => {
    const now = new Date().toISOString();
    return {
      runId: `orphan-${suiteSource}-${Date.now()}`, workflowId: `eval:${suiteRef}`, tenantId: TENANT, status: 'running', inputs: {},
      metadata: { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef, suiteSource, suiteDigest: digest, agentId, ...(suiteSource === 'pack' ? { suitePack: 'test.pack@2.0.0' } : {}) } },
      configurable: {}, createdAt: now, updatedAt: now,
    };
  };

  it('a pack suite swapped under the same ref fails the resume eval_suite_unavailable', async () => {
    // The pack suite still resolves; only its content differs from what the run started on.
    const stale = suiteDigest(validateEvalSuite({ ...PACK_SUITE, tasks: [{ ...PACK_SUITE.tasks[0], taskId: 'before-upgrade' }] }));
    const run = orphan('test.pack.evals.shipped@2.0.0', 'pack', stale, PACK_AGENT);
    await hostExtStorage().insertRun(run);
    await resumeAgentEvalRun(hostExtStorage(), run);
    const after = await hostExtStorage().getRun(run.runId);
    expect(after?.status).toBe('failed');
    expect((after?.error as { code?: string } | undefined)?.code).toBe('eval_suite_unavailable');
  });

  it('a tenant suite redacted by erasure after the run started fails the resume too (every source is stamped)', async () => {
    const stored = await putEvalSuite(TENANT, validateEvalSuite({
      suiteId: 'test.acme.evals.erased', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 't', input: { email: 'erin@example.com' }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    }));
    const run = orphan('test.acme.evals.erased@1.0.0', 'tenant', suiteDigest(stored.suite), AGENT);
    await hostExtStorage().insertRun(run);
    await eraseSubjectEvalSuites(TENANT, 'erin@example.com');
    expect(suiteDigest((await getEvalSuite(TENANT, 'test.acme.evals.erased@1.0.0'))!.suite)).not.toBe(suiteDigest(stored.suite));
    await resumeAgentEvalRun(hostExtStorage(), run);
    const after = await hostExtStorage().getRun(run.runId);
    expect(after?.status).toBe('failed');
    expect((after?.error as { code?: string } | undefined)?.code).toBe('eval_suite_unavailable');
  });
});

describe('EVD-7 — the run chat tool is idempotent per conversation run and carries the owner', () => {
  it('a re-issued call in the same run returns the same eval run; the run echoes the conversation run\'s owner', async () => {
    const { builtinAgentTool } = await import('../src/host/agentToolProvider.js');
    const tool = builtinAgentTool('openwop:agent-evals.run')!;
    const tenantId = 'user:u-7';
    await putEvalSuite(tenantId, golden('test.acme.evals.chat'));
    const owner = { principal: 'p-u-7', principalKind: 'user', subject: { issuer: 'urn:openwop-app:session', subjectId: 's-u-7', lane: 'oidc', kind: 'user' } };
    const now = new Date().toISOString();
    const conversation: RunRecord = {
      runId: `conv-${Date.now()}`, workflowId: 'chat', tenantId, status: 'running', inputs: {},
      metadata: { owner }, configurable: {}, createdAt: now, updatedAt: now,
    };
    await hostExtStorage().insertRun(conversation);
    const scope = { tenantId, actingUserId: 'u-7', personalTenant: tenantId, runId: conversation.runId } as never;
    const input = { suiteRef: 'test.acme.evals.chat@1.0.0', agentId: AGENT };

    const first = await tool.run(input, scope);
    expect(first.isError, first.content).toBeFalsy();
    const second = await tool.run(input, scope);
    expect(second.isError, second.content).toBeFalsy();
    const a = JSON.parse(first.content) as { runId: string };
    const b = JSON.parse(second.content) as { runId: string; replayed?: boolean };
    expect(b.runId).toBe(a.runId);
    expect(b.replayed).toBe(true);
    const created = await hostExtStorage().getRun(storedId(a.runId));
    expect(created?.metadata?.owner).toEqual(owner);

    // Different arguments in the same run are a different eval run.
    await putEvalSuite(tenantId, golden('test.acme.evals.chat2'));
    const third = JSON.parse((await tool.run({ ...input, suiteRef: 'test.acme.evals.chat2@1.0.0' }, scope)).content) as { runId: string };
    expect(third.runId).not.toBe(a.runId);
  });
});

describe('EVD-6 — the per-run capture cap holds across concurrent wraps', () => {
  it('two parallel lane invocations of one run record at most MAX_CALLS_PER_RUN between them', async () => {
    const { MAX_CALLS_PER_RUN, listRunBoundary } = await import('../src/host/evals/toolBoundary.js');
    await setCaptureSetting(TENANT, AGENT, true);
    const runId = `r-cap-concurrent-${Date.now()}`;
    // Both wraps start before either records: each used to seed `recorded` from the
    // same (empty) count and record a full 50 of its own.
    const [a, b] = await Promise.all([0, 1].map(() => maybeCaptureExecuteTool(async () => ({ content: '{}' }), { tenantId: TENANT, runId, agentId: AGENT })));
    await Promise.all([a!, b!].map(async (exec) => {
      for (let i = 0; i < MAX_CALLS_PER_RUN; i += 1) await exec({ name: 't', input: { i } } as Parameters<typeof exec>[0]);
    }));
    expect(await listRunBoundary(TENANT, runId)).toHaveLength(MAX_CALLS_PER_RUN);
  });
});

describe('WF-EV-10 — redrive names an eval run for what it is', () => {
  it('a failed eval run is eval_run_not_redrivable, not workflow_not_found', async () => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `redrive-eval-${Date.now()}`, workflowId: 'eval:test.acme.evals.reg@1.0.0', tenantId: TENANT, status: 'failed', inputs: {},
      metadata: { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.reg@1.0.0', suiteSource: 'tenant', agentId: AGENT } },
      configurable: {}, createdAt: now, updatedAt: now,
    };
    await hostExtStorage().insertRun(run);
    const r = await send('POST', '/host/openwop-app/runs/redrive', { runIds: [run.runId] });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(JSON.stringify(r.json)).toContain('eval_run_not_redrivable');
  });
});

describe('regressionReason — host-extension only, never the wire summary', () => {
  it('the progress route and the history items carry metadata.eval.regressionReason; the wire eval-summary does not', async () => {
    const now = new Date().toISOString();
    const runId = `inconclusive-${Date.now()}`;
    const run: RunRecord = {
      runId, workflowId: evalWorkflowId('test.acme.evals.reg@1.0.0'), tenantId: TENANT, status: 'completed', inputs: {},
      metadata: {
        mode: 'eval',
        eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.reg@1.0.0', suiteSource: 'tenant', agentId: AGENT, baselineRunId: 'gone', regressionReason: 'baseline_unavailable' },
        evalSummary: { suiteId: 'test.acme.evals.reg', passed: true, regression: { baselineRunId: 'gone', verdict: 'inconclusive', scoreDelta: 0, pairedTaskCount: 0 } },
      },
      configurable: {}, createdAt: now, updatedAt: now,
    };
    await hostExtStorage().insertRun(run);
    const progress = await send('GET', `/host/openwop-app/agent-evals/runs/${runId}/progress`);
    expect(progress.status, progress.text.slice(0, 200)).toBe(200);
    expect(progress.json['regressionReason'], progress.text.slice(0, 400)).toBe('baseline_unavailable');
    const history = await send('GET', `/host/openwop-app/agent-evals/runs?agentId=${AGENT}&limit=100`);
    const item = (history.json['items'] as Array<{ runId: string; regressionReason: string | null }>).find((i) => storedId(i.runId) === runId);
    expect(item?.regressionReason).toBe('baseline_unavailable');
    const wire = await send('GET', `/runs/${TENANT}/${runId}/eval-summary`);
    expect(wire.text).not.toContain('regressionReason');
    expect(wire.text).not.toContain('baseline_unavailable');
  });
});

describe('EVUX-7 — the capture list says which lane and shows a redacted preview', () => {
  it('records lane and a ≤120-char, secret-stripped preview of the run\'s FIRST call; erasure re-derives it', async () => {
    const { listCapturedRuns, PREVIEW_CHARS, eraseSubjectToolBoundary } = await import('../src/host/evals/toolBoundary.js');
    await setCaptureSetting(TENANT, AGENT, true);
    const runId = `r-preview-${Date.now()}`;
    const exec = await maybeCaptureExecuteTool(async () => ({ content: '{}' }), { tenantId: TENANT, runId, agentId: AGENT, lane: 'chat' });
    await exec({ name: 'crm:lookup', input: { email: 'quinn@example.com', apiKey: 'sk-ant-api03-SECRETSECRETSECRETSECRET', note: 'x'.repeat(300) } } as Parameters<typeof exec>[0]);
    await exec({ name: 'crm:update', input: { id: 'c-9' } } as Parameters<typeof exec>[0]);
    const row = (await listCapturedRuns(TENANT, AGENT)).find((r) => r.runId === runId)!;
    expect(row).toMatchObject({ lane: 'chat', calls: 2 });
    expect(row.inputPreview!.startsWith('crm:lookup: ')).toBe(true);
    expect(row.inputPreview!.length).toBeLessThanOrEqual(PREVIEW_CHARS);
    expect(row.inputPreview).not.toContain('SECRETSECRET');
    // The route serves the same fields.
    const r = await send('GET', `/host/openwop-app/agent-evals/capture/${AGENT}`);
    expect((r.json['runs'] as Array<Record<string, unknown>>).find((x) => x['runId'] === runId)).toMatchObject({ lane: 'chat', inputPreview: row.inputPreview });
    // Erasing the subject of the FIRST call must not leave it quoted in the preview.
    await eraseSubjectToolBoundary(TENANT, 'quinn@example.com');
    const after = (await listCapturedRuns(TENANT, AGENT)).find((x) => x.runId === runId)!;
    expect(after).toMatchObject({ calls: 1, lane: 'chat' });
    expect(after.inputPreview).not.toContain('quinn');
    expect(after.inputPreview!.startsWith('crm:update: ')).toBe(true);
  });
});

describe('EVD-7 — createAgentEvalRunOnce dedupes a crash-retried caller (chain node)', () => {
  it('the same dedupeKey returns the same run; a refused create frees the key', async () => {
    const { createAgentEvalRunOnce } = await import('../src/host/evals/createEvalRun.js');
    await putEvalSuite(TENANT, golden('test.acme.evals.once'));
    const body = { mode: 'eval', evalSuiteRef: 'test.acme.evals.once@1.0.0', agentId: AGENT, configurable: mock() };
    const key = `parent-run-1:node-a:${Date.now()}`;
    const wire = (id: string): string => (id.includes('/') ? id : `${TENANT}/${id}`);
    const a = await createAgentEvalRunOnce({ caller: { actingUserId: 'u-1' }, storage: hostExtStorage(), tenantId: TENANT, body, dedupeKey: key });
    const b = await createAgentEvalRunOnce({ caller: { actingUserId: 'u-1' }, storage: hostExtStorage(), tenantId: TENANT, body, dedupeKey: key });
    expect(b.runId).toBe(a.runId);
    expect(b.replayed).toBe(true);
    await waitTerminal(wire(a.runId));
    // A refusal (unknown suite) releases the claim, so the corrected call is not locked out.
    const bad = { ...body, evalSuiteRef: 'test.acme.evals.once-missing@1.0.0' };
    const k2 = `parent-run-2:node-a:${Date.now()}`;
    await expect(createAgentEvalRunOnce({ caller: { actingUserId: 'u-1' }, storage: hostExtStorage(), tenantId: TENANT, body: bad, dedupeKey: k2 })).rejects.toMatchObject({ httpStatus: 404 });
    await putEvalSuite(TENANT, golden('test.acme.evals.once-missing'));
    const c = await createAgentEvalRunOnce({ caller: { actingUserId: 'u-1' }, storage: hostExtStorage(), tenantId: TENANT, body: bad, dedupeKey: k2 });
    expect(c.replayed).toBeUndefined();
    await waitTerminal(wire(c.runId));
  });
});

describe('capture truncation — a recorded result is cut to MAX_RESULT_CHARS', () => {
  it('a 40 KB tool result is stored truncated, not whole', async () => {
    const { MAX_RESULT_CHARS, listRunBoundary } = await import('../src/host/evals/toolBoundary.js');
    await setCaptureSetting(TENANT, AGENT, true);
    const runId = `r-trunc-${Date.now()}`;
    const exec = await maybeCaptureExecuteTool(async () => ({ content: 'y'.repeat(40_000) }), { tenantId: TENANT, runId, agentId: AGENT });
    await exec({ name: 'docs:read', input: {} } as Parameters<typeof exec>[0]);
    const [row] = await listRunBoundary(TENANT, runId);
    expect(row!.result.length).toBe(MAX_RESULT_CHARS);
  });
});

describe('M1 — the scripted mock is test-seam only', () => {
  it('a production posture refuses configurable.mockProvider 403, naming the field', async () => {
    await putEvalSuite(TENANT, golden('test.acme.evals.mock403'));
    const prev = process.env.OPENWOP_MOCK_PROVIDER_ENABLED;
    process.env.OPENWOP_MOCK_PROVIDER_ENABLED = 'false';
    try {
      const r = await send('POST', '/runs', { mode: 'eval', evalSuiteRef: 'test.acme.evals.mock403@1.0.0', agentId: AGENT, configurable: mock() });
      expect(r.status, r.text.slice(0, 200)).toBe(403);
      expect(details(r)['field']).toBe('configurable.mockProvider');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_MOCK_PROVIDER_ENABLED; else process.env.OPENWOP_MOCK_PROVIDER_ENABLED = prev;
    }
  });
});
