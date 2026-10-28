/**
 * ADR 0984 D7 (OQ1) — an eval run of a LIVE agent can be an RFC 0252 fixture
 * source, through a host-internal as-executed record, with the wire unchanged.
 *
 * Why this exists: the live dispatch lane records `agent.toolCalled` with an
 * `argsHash` only and `agent.toolReturned` without `outcome`, so no live run
 * could be a source (D2). D7 records each call of a live eval trial as executed,
 * under the agent's capture opt-in, and freezes the fixtures a replay derives
 * from it in the same governed store. The scenario cases drive real eval runs
 * over HTTP (the mock provider calls the real `openwop:schema.lookup` tool), so
 * the record, the derivation and the frozen copy are the production paths.
 *
 * Red when (each sabotage-witnessed): the recorder ignores the opt-in ⇒ "off by
 * default"; the dispatcher stops passing `callId` ⇒ "a recorded eval run";
 * the trial reads frozen fixtures from metadata only ⇒ "a recorded eval run";
 * the derivation skips the argsHash pairing ⇒ "pairing"; returns pair by last
 * event instead of in order ⇒ "a reused call id"; the per-run cap is not
 * enforced ⇒ "over the cap"; the owner check is skipped ⇒ "only by the user
 * who ran it"; erasure skips exact or frozen rows ⇒ "subject erasure"; a second
 * module reads the record ⇒ "only the derivation and the trial"; a trial that
 * serves fixtures is recorded ⇒ "a recorded eval run replays"; a thrown tool is
 * not recorded ⇒ "a tool that throws".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { putEvalSuite, validateEvalSuite } from '../src/host/evals/suiteStore.js';
import {
  eraseSubjectToolBoundary, freezeRecordedFixtures, maybeCaptureExecuteTool, maybeRecordExactCalls, readExactCalls,
  readFrozenFixtures, setCaptureSetting, MAX_EXACT_BYTES, MAX_EXACT_CALLS_PER_RUN,
} from '../src/host/evals/toolBoundary.js';
import { deriveFixtures, resolveRecordedFixtures } from '../src/host/evals/recordedFixtures.js';
import { computeArgsHash } from '../src/host/toolHooks.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getEvalSuite } from '../src/host/evals/suiteStore.js';
import { runAgentEval } from '../src/host/evals/agentEvalRun.js';
import type { RunRecord } from '../src/types.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const AGENT = 'eval.d7-live-agent';
const TOOL = 'openwop:schema.lookup';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getAgentRegistry().register({
    agentId: AGENT, persona: 'D7 subject', modelClass: 'research', systemPrompt: 'Answer.',
    packName: 'test', packVersion: '0', toolAllowlist: [TOOL], confidence: { defaultThreshold: 0.1 },
  });
  // The source suite runs its tool live; the replay suite names no fixtures of its own.
  await putEvalSuite(TENANT, validateEvalSuite({
    suiteId: 'test.d7.evals.source', version: '1.0.0', modes: ['golden'],
    tasks: [{ taskId: 'lookup', input: { q: 'hi' }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } }, fixtures: { onMiss: 'live' } }],
  }));
  await putEvalSuite(TENANT, validateEvalSuite({
    suiteId: 'test.d7.evals.replay', version: '1.0.0', modes: ['golden'],
    tasks: [{ taskId: 'lookup', input: { q: 'hi' }, expected: { kind: 'golden', match: { strategy: 'contains', value: 'done' } } }],
  }));
}, 60_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Reply { status: number; json: Record<string, unknown>; text: string }
async function send(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted */ }
  return { status: res.status, json, text };
}
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const status = String(((await send('GET', `/runs/${runId}`)).json as { status?: string }).status ?? '');
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} never settled`);
}
const storedId = (wireId: string): string => (wireId.includes('/') ? wireId.slice(wireId.indexOf('/') + 1) : wireId);
// A small, deterministic success: the artifact-type lookup of a name nothing registers.
const lookupOf = (name: string) => ({ kind: 'artifact-type', names: [name] });
const rounds = (name: string) => [{ toolCalls: [{ name: TOOL, input: lookupOf(name) }] }, { content: 'all done' }];
const create = (suite: string, name: string, extra: Record<string, unknown> = {}) => send('POST', '/runs', {
  mode: 'eval', evalSuiteRef: `${suite}@1.0.0`, agentId: AGENT,
  configurable: { mockProvider: { id: 'tool-calls', rounds: { lookup: rounds(name) } } }, ...extra,
});
async function runToEnd(suite: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const c = await create(suite, name, extra);
  expect(c.status, c.text.slice(0, 400)).toBe(201);
  const id = String(c.json['runId']);
  expect(await waitTerminal(id)).toBe('completed');
  return id;
}
const summaryTask = async (id: string) => (((await send('GET', `/runs/${id}/eval-summary`)).json['tasks'] as Array<Record<string, unknown>>) ?? [])[0]!;
const codeOf = (r: Reply): unknown => (typeof r.json['error'] === 'string' ? r.json['error'] : (r.json['error'] as { code?: unknown } | undefined)?.code);

describe('ADR 0984 D7 — a live eval run as an RFC 0252 source', () => {
  it('off by default: nothing is recorded, and the source is refused uniformly', async () => {
    const src = await runToEnd('test.d7.evals.source', 'zz.d7-off');
    expect(await readExactCalls(TENANT, storedId(src))).toEqual([]);
    const r = await create('test.d7.evals.replay', 'zz.d7-off', { fixtureRuns: { lookup: src } });
    expect(r.status, r.text).toBe(400);
    expect(codeOf(r)).toBe('validation_error');
    expect(JSON.stringify(r.json)).not.toContain(storedId(src));
  });

  it('a recorded eval run replays: wire unchanged, fixtures frozen in the store, a drift fails closed', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const src = await runToEnd('test.d7.evals.source', 'zz.d7-source');
      const evs = await getEventLog().list(storedId(src), { fromSeq: -1, limit: 200 });
      const called = evs.filter((e) => e.type === 'agent.tool-called' || e.type === 'agent.toolCalled').map((e) => e.payload as Record<string, unknown>);
      const returned = evs.filter((e) => e.type === 'agent.tool-returned' || e.type === 'agent.toolReturned').map((e) => e.payload as Record<string, unknown>);
      expect(called).toHaveLength(1);
      expect(called[0]!['inputs']).toBeUndefined();
      expect(returned.every((p) => !Object.hasOwn(p, 'outcome'))).toBe(true);
      const [row] = (await readExactCalls(TENANT, storedId(src)))!;
      expect(row).toMatchObject({ tool: TOOL, input: lookupOf('zz.d7-source'), complete: true, argsHash: called[0]!['argsHash'] });

      const replay = await runToEnd('test.d7.evals.replay', 'zz.d7-source', { fixtureRuns: { lookup: src } });
      const stored = (await hostExtStorage().getRun(storedId(replay)))!;
      const meta = (stored.metadata?.eval ?? {}) as Record<string, unknown>;
      expect(meta['recordedFixturesStored']).toEqual({ lookup: storedId(src) });
      expect((meta['recordedFixtures'] as Record<string, unknown> | undefined)?.['lookup']).toBeUndefined();
      expect(await readFrozenFixtures(TENANT, storedId(src), storedId(replay), 'lookup')).toEqual([
        { tool: TOOL, args: lookupOf('zz.d7-source'), argsMatch: 'exact', response: row!.content },
      ]);
      // Capture is ON, but a trial that serves fixtures records nothing: its record
      // would be an unlinked copy of the source's content with its own retention.
      expect(await readExactCalls(TENANT, storedId(replay))).toEqual([]);
      const task = await summaryTask(replay);
      expect(task['fixtureMissCount'] ?? 0).toBe(0);
      expect(task['passed']).toBe(true);

      const drift = await runToEnd('test.d7.evals.replay', 'zz.d7-drift', { fixtureRuns: { lookup: src } });
      expect((await summaryTask(drift))['fixtureMissCount']).toBe(1);

      // Erasing the source's record removes every copy derived from it, and a run
      // whose copy is gone is refused before any trial: never re-derived, never live.
      const again: RunRecord = { ...stored, runId: `d7-again-${randomUUID()}`, status: 'pending' };
      await hostExtStorage().insertRun(again);
      await freezeRecordedFixtures(TENANT, again.runId, { lookup: { sourceRunId: storedId(src), anchorAt: row!.updatedAt, entries: [] } });
      await eraseSubjectToolBoundary(TENANT, 'zz.d7-source');
      expect(await readExactCalls(TENANT, storedId(src))).toEqual([]);
      expect(await readFrozenFixtures(TENANT, storedId(src), storedId(replay), 'lookup')).toBeNull();
      expect(await readFrozenFixtures(TENANT, storedId(src), again.runId, 'lookup')).toBeNull();
      const suite = (await getEvalSuite(TENANT, 'test.d7.evals.replay@1.0.0'))!.suite;
      expect(await runAgentEval({ storage: hostExtStorage(), run: again, suite })).toBeNull();
      const failed = (await getEventLog().list(again.runId, { fromSeq: -1, limit: 50 })).find((e) => e.type === 'run.failed');
      expect(JSON.stringify(failed?.payload)).toContain('eval_recorded_fixtures_gone');
      expect((await getEventLog().list(again.runId, { fromSeq: -1, limit: 50 })).some((e) => e.type.includes('invocation'))).toBe(false);
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('a recorded source is usable only by the user who ran it', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const src = await runToEnd('test.d7.evals.source', 'zz.d7-owner');
      const run = (await hostExtStorage().getRun(storedId(src)))!;
      const read = async () => run;
      const owner = run.metadata?.actingUserId as string;
      await expect(resolveRecordedFixtures({ lookup: src }, read, AGENT, { allowErrors: true, actingUserId: owner })).resolves.toMatchObject({ fromRecord: { lookup: { sourceRunId: storedId(src) } } });
      await expect(resolveRecordedFixtures({ lookup: src }, read, AGENT, { allowErrors: true, actingUserId: `${owner}-other` }))
        .rejects.toMatchObject({ httpStatus: 400, details: { field: 'fixtureRuns' } });
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });
});

describe('ADR 0984 D7 — the record (unit)', () => {
  const inner = async (call: { input: Record<string, unknown> }) => ({ content: JSON.stringify({ seen: call.input }) });
  const put = (runId: string, type: string, payload: Record<string, unknown>) => getEventLog().append({ runId, type, payload });
  const terminal = (runId: string): RunRecord => ({ runId, tenantId: TENANT, status: 'completed', metadata: { actingUserId: 'u' } } as unknown as RunRecord);

  it('pairing: a reused call id pairs each return with its own call, in order; a gate answer is not a result', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const runId = `d7-${randomUUID()}`;
      const rec = (await maybeRecordExactCalls({ tenantId: TENANT, runId, agentId: AGENT }))!(inner);
      const a = { email: 'a@example.com' }; const b = { email: 'b@example.com' };
      await rec({ name: 'crm', input: a, callId: 'dup' });
      await rec({ name: 'crm', input: b, callId: 'dup' });
      await put(runId, 'agent.invocation.started', { agentId: AGENT });
      await put(runId, 'agent.toolCalled', { agentId: AGENT, toolName: 'crm', callId: 'dup', argsHash: computeArgsHash(a) });
      await put(runId, 'agent.toolReturned', { agentId: AGENT, toolName: 'crm', callId: 'dup', status: 'ok' });
      await put(runId, 'agent.toolCalled', { agentId: AGENT, toolName: 'crm', callId: 'dup', argsHash: computeArgsHash(b) });
      await put(runId, 'agent.toolReturned', { agentId: AGENT, toolName: 'crm', callId: 'dup', status: 'ok' });
      // Round 3 reused the id and a gate refused it: a return with no call.
      await put(runId, 'agent.toolReturned', { agentId: AGENT, toolName: 'crm', callId: 'dup', status: 'forbidden' });
      expect((await deriveFixtures(terminal(runId), AGENT, { allowErrors: true }))?.entries).toEqual([
        { tool: 'crm', args: a, argsMatch: 'exact', response: JSON.stringify({ seen: a }) },
        { tool: 'crm', args: b, argsMatch: 'exact', response: JSON.stringify({ seen: b }) },
      ]);
      // A record from other arguments is not this call's record.
      const other = `d7-${randomUUID()}`;
      await (await maybeRecordExactCalls({ tenantId: TENANT, runId: other, agentId: AGENT }))!(inner)({ name: 'crm', input: b, callId: 'x' });
      await put(other, 'agent.invocation.started', { agentId: AGENT });
      await put(other, 'agent.toolCalled', { agentId: AGENT, toolName: 'crm', callId: 'x', argsHash: computeArgsHash(a) });
      await put(other, 'agent.toolReturned', { agentId: AGENT, toolName: 'crm', callId: 'x', status: 'ok' });
      expect(await deriveFixtures(terminal(other), AGENT, { allowErrors: true })).toBeNull();
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('over the cap, or too large to hold, the run is not a source', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const runId = `d7-${randomUUID()}`;
      const rec = (await maybeRecordExactCalls({ tenantId: TENANT, runId, agentId: AGENT }))!(inner);
      for (let i = 0; i <= MAX_EXACT_CALLS_PER_RUN; i += 1) await rec({ name: 'crm', input: { i }, callId: `c${i}` });
      expect(await readExactCalls(TENANT, runId)).toBeNull();

      const big = `d7-${randomUUID()}`;
      const huge = (await maybeRecordExactCalls({ tenantId: TENANT, runId: big, agentId: AGENT }))!(async () => ({ content: 'é'.repeat(MAX_EXACT_BYTES / 2 + 1) }));
      await huge({ name: 'crm', input: {}, callId: 'h' });
      const [row] = (await readExactCalls(TENANT, big))!;
      expect(row).toMatchObject({ complete: false });
      expect(row?.content).toBeUndefined();
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('a tool that throws is recorded as the failure the dispatcher reports, and the throw goes on', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const runId = `d7-${randomUUID()}`;
      const rec = (await maybeRecordExactCalls({ tenantId: TENANT, runId, agentId: AGENT }))!(async () => { throw new Error('upstream 503'); });
      await expect(rec({ name: 'crm', input: { email: 'a@example.com' }, callId: 'c1' })).rejects.toThrow('upstream 503');
      expect((await readExactCalls(TENANT, runId))?.[0]).toMatchObject({ callId: 'c1', isError: true, complete: true, content: 'tool_execution_failed: upstream 503' });
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('the workflow and chat capture wrapper records no as-executed calls', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const runId = `d7-${randomUUID()}`;
      const exec = await maybeCaptureExecuteTool(inner, { tenantId: TENANT, runId, agentId: AGENT });
      await exec({ name: 'crm', input: { email: 'a@example.com' }, callId: 'c1' });
      expect(await readExactCalls(TENANT, runId)).toEqual([]);
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('subject erasure deletes a matching record, every copy of its source, and a copy that quotes the subject', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    try {
      const runId = `d7-${randomUUID()}`;
      await (await maybeRecordExactCalls({ tenantId: TENANT, runId, agentId: AGENT }))!(inner)({ name: 'crm', input: { email: 'quinn@example.com' }, callId: 'c1' });
      await (await maybeRecordExactCalls({ tenantId: TENANT, runId, agentId: AGENT }))!(inner)({ name: 'crm', input: { email: 'kept@example.com' }, callId: 'c2' });
      const otherSource = `d7-${randomUUID()}`;
      const at = new Date().toISOString();
      // A copy of an UNRELATED source that quotes the subject, and one that does not.
      await freezeRecordedFixtures(TENANT, 'eval-1', {
        gone: { sourceRunId: otherSource, anchorAt: at, entries: [{ tool: 'crm', args: { email: 'quinn@example.com' }, argsMatch: 'exact', response: 'x' }] },
        kept: { sourceRunId: otherSource, anchorAt: at, entries: [{ tool: 'crm', args: { email: 'kept@example.com' }, argsMatch: 'exact', response: 'y' }] },
      });
      // A copy of THIS source that does not quote the subject: it goes with its source.
      await freezeRecordedFixtures(TENANT, 'eval-2', { t: { sourceRunId: runId, anchorAt: at, entries: [] } });
      await eraseSubjectToolBoundary(TENANT, 'quinn@example.com');
      expect((await readExactCalls(TENANT, runId))!.map((r) => r.callId)).toEqual(['c2']);
      expect(await readFrozenFixtures(TENANT, otherSource, 'eval-1', 'gone')).toBeNull();
      expect(await readFrozenFixtures(TENANT, otherSource, 'eval-1', 'kept')).not.toBeNull();
      expect(await readFrozenFixtures(TENANT, runId, 'eval-2', 't')).toBeNull();
    } finally {
      await setCaptureSetting(TENANT, AGENT, false);
    }
  });

  it('only the derivation and the trial read the record', () => {
    const src = join(__dirname, '..', 'src');
    const users = (name: string): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.ts$/.test(f) && p !== join(src, 'host/evals/toolBoundary.ts') && new RegExp(`\\b${name}\\b`).test(readFileSync(p, 'utf8'))) out.push(p.slice(src.length + 1));
        }
      };
      walk(src);
      return out.sort();
    };
    expect(users('readExactCalls')).toEqual(['host/evals/recordedFixtures.ts']);
    expect(users('readFrozenFixtures')).toEqual(['host/evals/agentEvalRun.ts']);
    expect(users('maybeRecordExactCalls')).toEqual(['host/evals/agentEvalRun.ts']);
  });
});
