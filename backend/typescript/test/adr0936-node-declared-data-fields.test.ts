/**
 * ADR 0936 (Book AI P18) — a node's declared DATA fields skip the
 * credential-shape pass; every other field, and the known-secret scrub, stay.
 *
 * Book AI reads model prose back from `node.completed` and an author's answers
 * back from the resume value. The shape pass rewrote a fictional `Bearer …` in a
 * thriller scene to `<<redacted:credential-shape>>`, and the free-text pass
 * turned a 32-hex run into `***`.
 *
 * Sabotage: making `stripSecretsKeepingData` ignore `dataKeys` reds the output
 * case; making `scrubResumeValue` ignore them reds the resume case; dropping the
 * Tier 1 call on a data key reds the known-secret legs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { readNodeDataFields, type NodeModule } from '../src/executor/types.js';
import { clearRunSecrets, setRunSecrets, stripSecretsKeepingData } from '../src/byok/ephemeralRunSecrets.js';
import { bareRunId } from './support/bareRunId.js';

const FICTION = 'The courier read the token aloud: Bearer abcdefghijklmnopqrstuvwxyz0123456789.';
const HEX = '0123456789abcdef0123456789abcdef0123'; // a 36-hex run, rewritten by the free-text pass
const SHAPE_MARK = '<<redacted:credential-shape>>';

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };

const proseNode: NodeModule = {
  typeId: 'adr0936.prose',
  version: '1.0.0',
  dataFields: { outputs: ['scene'] },
  async execute() {
    return { status: 'success', outputs: { scene: FICTION, log: FICTION } };
  },
};
const answersNode: NodeModule = {
  typeId: 'adr0936.answers',
  version: '1.0.0',
  dataFields: { resume: ['answers'], outputs: ['answers'] },
  async execute(ctx) {
    const v = await ctx.suspend!({ kind: 'clarification', resumeKey: 'q' }) as { answers?: unknown; comment?: unknown };
    return { status: 'success', outputs: { answers: v.answers, comment: v.comment } };
  },
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  getNodeRegistry().register(proseNode);
  getNodeRegistry().register(answersNode);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function waitStatus(runId: string, pred: (s: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (pred(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function completedOutputs(runId: string, nodeId: string): Promise<Json | undefined> {
  const evs = (await api<{ events: Array<{ type: string; nodeId?: string; payload?: { outputs?: Json } }> }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
  return evs.filter((e) => e.type === 'node.completed' && e.nodeId === nodeId).at(-1)?.payload?.outputs;
}
let n = 0;
async function run(typeId: string): Promise<string> {
  const workflowId = `adr0936.${typeId}.${Date.now()}-${n++}`;
  const reg = await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId }], edges: [] }) });
  expect(reg.status, JSON.stringify(reg.body)).toBeLessThan(300);
  const create = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  return create.body.runId;
}

describe('ADR 0936 — declared data fields', () => {
  it('a declared output port keeps credential-shaped prose; an undeclared one is still scrubbed', async () => {
    const runId = await run('adr0936.prose');
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    const out = await completedOutputs(runId, 'n');
    expect(out?.['scene']).toBe(FICTION);
    expect(String(out?.['log'])).toContain(SHAPE_MARK);
  });

  it('a declared resume key reaches the node unchanged; an undeclared one keeps both passes', async () => {
    const runId = await run('adr0936.answers');
    expect(await waitStatus(runId, (s) => s.startsWith('waiting'))).toMatch(/^waiting/);
    const [gate] = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts;
    const knownLater = 'adr0936-replay-secret-fixture';
    const r = await api(`/interrupts/${gate!.token}`, { method: 'POST', body: JSON.stringify({ resumeValue: { answers: [FICTION, HEX, knownLater], comment: `${FICTION} ${HEX}` } }) });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(await waitStatus(runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
    const out = await completedOutputs(runId, 'n');
    expect(out?.['answers']).toEqual([FICTION, HEX, knownLater]);
    expect(String(out?.['comment'])).toContain(SHAPE_MARK);
    expect(String(out?.['comment'])).not.toContain(HEX);

    const sourceEvents = (await api<{ events: Array<{ type: string; nodeId?: string; sequence: number }> }>(`/runs/${runId}/events/poll?fromSeq=-1&limit=1000`)).body.events;
    const resolved = sourceEvents.find((e) => e.nodeId === 'n' && e.type === 'interrupt.resolved');
    expect(resolved).toBeDefined();
    if (!resolved) throw new Error('source never recorded its resolution');
    // Cut before node.completed: a full replay can copy the source output and
    // would not exercise derived resolution's own redaction boundary.
    setRunSecrets('adr0936-replay-fixture', { replayFixture: knownLater });
    try {
      const fork = await api<{ runId: string }>(`/runs/${runId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: resolved.sequence }) });
      expect(fork.status, JSON.stringify(fork.body)).toBe(201);
      expect(await waitStatus(fork.body.runId, (s) => ['completed', 'failed'].includes(s))).toBe('completed');
      const events = (await api<{ events: Array<{ type: string; nodeId?: string; sequence: number; payload?: { outputs?: Json } }> }>(`/runs/${fork.body.runId}/events/poll?fromSeq=-1&limit=1000`)).body.events;
      const tail = events.filter((e) => e.sequence >= resolved.sequence && e.nodeId === 'n');
      expect(tail.filter((e) => ['interrupt.requested', 'node.suspended'].includes(e.type))).toEqual([]);
      const completed = tail.filter((e) => e.type === 'node.completed');
      expect(completed).toHaveLength(1);
      // A ctx.suspend continuation keeps the node's actual ports, just as the
      // source did above; a native gate's synthetic `output` wrapper is wrong.
      const replayed = completed[0]?.payload?.outputs;
      expect(replayed).not.toHaveProperty('output');
      expect(replayed?.['answers']).toEqual([FICTION, HEX, '<<redacted:replayFixture>>']);
      expect(String(replayed?.['comment'])).toContain(SHAPE_MARK);
      expect(String(replayed?.['comment'])).not.toContain(HEX);
    } finally { clearRunSecrets('adr0936-replay-fixture'); }
  });
});

describe('ADR 0936 — the pieces', () => {
  it('a secret a run resolved is still redacted inside a data field (NFR-7)', () => {
    const key = 'sk-test-adr0936-resolved-key-value';
    setRunSecrets('adr0936-run', { anthropic: key });
    const out = stripSecretsKeepingData({ scene: `she typed ${key}`, other: key }, ['scene']);
    expect(out.scene).toBe('she typed <<redacted:anthropic>>');
    expect(out.other).not.toContain(key);
  });

  it('readNodeDataFields keeps well-formed names only, and absent means nothing declared', () => {
    expect(readNodeDataFields({ 'x-dataFields': { outputs: ['scene', 'scene', 'bad name', 7], resume: ['answers'] } }))
      .toEqual({ outputs: ['scene'], resume: ['answers'] });
    expect(readNodeDataFields({ 'x-dataFields': { outputs: [] } })).toBeUndefined();
    expect(readNodeDataFields({})).toBeUndefined();
    expect(readNodeDataFields(undefined)).toBeUndefined();
  });
});
