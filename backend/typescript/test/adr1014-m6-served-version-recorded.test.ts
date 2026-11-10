/**
 * ADR 1014 M6 — with `OPENWOP_AGENT_VERSIONS=on`, the version an UNPINNED agent is
 * served is resolved once and recorded, never drawn again.
 *
 * In a run it is recorded like a channel pin (`agent.invocation.started` with
 * `resolvedChannel: 'stable'` + `resolvedAgentVersion`), so a resume reuses this
 * run's record and a fork reuses its parent's, even after the deployment moved.
 *
 * Red when: a second resolution in the same run, or a fork's, follows the moved
 * deployment instead of the record; nothing is recorded for a deployed agent; an
 * agent with no deployment rows starts being recorded (it runs its head, as with
 * the flag off); a deployment that serves a version this host cannot load runs
 * anything; or the flag off records anything.
 *
 * Flag off is a double guard: `pinServedAgent` and `servingVersion` both check
 * `agentVersionsServed()`, so only an edit to that shared predicate reds the
 * flag-off case. Sabotage-witnessed (grade-tests w83): reuse of this run's
 * record, the parent's record on a fork, the no-rows head, the null and the
 * unloadable refusals, the flag predicate, and voice's draw key.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { registerAgentServingResolver } from '../src/host/agentServing.js';
import { pinServedAgent } from '../src/host/agentChannelPin.js';
import { resolveAgentToolDecls } from '../src/features/voice/realtime/toolBridge.js';

const AGENT = 'acme.agents.served.a';
const TENANT = 'org:m6';
const manifest = (version: string): ResolvedAgentManifest => ({
  agentId: AGENT, persona: `P${version}`, modelClass: 'chat', systemPrompt: `I am ${version}.`,
  toolAllowlist: [], packName: 'acme.agents.served', packVersion: version,
});

let storage: Storage;
/** What `stable` serves right now; `undefined` = the agent has no deployment rows. */
let stable: string | null | undefined;
let draws = 0;
let drawKeys: string[] = [];

const run = async (runId: string, parentRunId?: string): Promise<RunRecord> => {
  const now = new Date().toISOString();
  const r: RunRecord = {
    runId, workflowId: 'wf.m6', tenantId: TENANT, status: 'running', inputs: {}, metadata: {}, configurable: {},
    createdAt: now, updatedAt: now, ...(parentRunId ? { parentRunId, forkMode: 'replay' as const } : {}),
  };
  await storage.insertRun(r);
  return r;
};
const pin = (r: RunRecord, nodeId = 'n1') => pinServedAgent({ storage, run: r, nodeId, agentId: AGENT, execution: 1 });
const recorded = async (runId: string) => (await storage.listEvents(runId, { fromSeq: -1, limit: 500 }))
  .filter((e) => e.type.endsWith('agent.invocation.started'))
  .map((e) => (e.payload as Record<string, unknown>).resolvedAgentVersion);

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  initHostExtPersistence(storage); // the voice leg resolves the agent's identity
});
beforeEach(() => {
  process.env.OPENWOP_AGENT_VERSIONS = 'on';
  const reg = getAgentRegistry();
  reg._resetForTest();
  reg.register(manifest('2.0.0'));
  reg.registerVersion(manifest('1.0.0'));
  stable = '1.0.0';
  draws = 0;
  drawKeys = [];
  registerAgentServingResolver(async (_t, _a, key) => { draws += 1; drawKeys.push(key); return stable; });
});
afterEach(() => {
  registerAgentServingResolver(undefined);
  getAgentRegistry()._resetForTest();
  delete process.env.OPENWOP_AGENT_VERSIONS;
});
afterAll(() => { delete process.env.OPENWOP_AGENT_VERSIONS; });

describe('ADR 1014 M6 — a run records the served version once', () => {
  it('records stable’s version, and a resume in the same run reuses it after the deployment moved', async () => {
    const r = await run(`m6-a-${Date.now()}`);
    const first = await pin(r);
    expect(first.ok && first.pin?.version).toBe('1.0.0');
    expect(first.ok && first.pin?.channel).toBe('stable');
    stable = '2.0.0'; // promoted between the run's first turn and its resume
    const again = await pin(r, 'n2');
    expect(again.ok && again.pin?.version, 'the record, not the moved deployment').toBe('1.0.0');
    expect(draws, 'one draw for the whole run').toBe(1);
    expect(await recorded(r.runId)).toEqual(['1.0.0', '1.0.0']);
  });

  it('a fork reuses its parent’s record', async () => {
    const parent = await run(`m6-p-${Date.now()}`);
    await pin(parent);
    stable = '2.0.0';
    const child = await run(`m6-c-${Date.now()}`, parent.runId);
    const forked = await pin(child);
    expect(forked.ok && forked.pin?.version).toBe('1.0.0');
    expect(draws).toBe(1);
  });

  it('an agent with no deployment rows runs its head and records nothing', async () => {
    stable = undefined;
    const r = await run(`m6-h-${Date.now()}`);
    const out = await pin(r);
    expect(out).toEqual({ ok: true });
    expect(await recorded(r.runId)).toEqual([]);
  });

  it('a deployment that serves nothing, or a version this host cannot load, fails closed', async () => {
    stable = null;
    const none = await pin(await run(`m6-n-${Date.now()}`));
    expect(none.ok ? 'ran' : none.error.code).toBe('agent_version_unavailable');
    stable = '0.9.0';
    const missing = await run(`m6-m-${Date.now()}`);
    const out = await pin(missing);
    expect(out.ok ? 'ran' : out.error.code).toBe('agent_version_unavailable');
    expect(await recorded(missing.runId), 'never recorded as the one that ran').toEqual([]);
  });

  it('with the flag off nothing is resolved or recorded', async () => {
    delete process.env.OPENWOP_AGENT_VERSIONS;
    const r = await run(`m6-off-${Date.now()}`);
    expect(await pin(r)).toEqual({ ok: true });
    expect(draws).toBe(0);
    expect(await recorded(r.runId)).toEqual([]);
  });
});

describe('ADR 1014 M6 — voice draws its tools on the same key as its prompt', () => {
  it('a session in a conversation draws on the conversation, like composeChatContext', async () => {
    await resolveAgentToolDecls(TENANT, AGENT, 'conv-42');
    expect(drawKeys).toEqual(['conv-42']);
  });
});
