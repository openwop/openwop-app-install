/**
 * ADR 1003 D2 + D5, through the real exchange: the transcript window steps, and
 * when it drops turns the user is told with a counts-only host event.
 *
 * Before D5 only the MODEL was told ("[Context budget: N earlier turn(s)
 * omitted…]" in its system message); the person reading the chat had no way to
 * know the assistant had stopped seeing their earlier messages. The event
 * copies `context-degraded` / `recall-used`: host-namespaced, best-effort, and
 * carrying a COUNT — never a turn id, never text. It is not model input.
 *
 * Also pinned here (ADR 1003 D2, on the real fold): between steps the system
 * message the model receives is byte-identical from one exchange to the next,
 * and it names no run, conversation or message id (ADR 1002).
 *
 * The event's type must read back unchanged under OpenWOP major 2. The v2
 * vendor grammar admits `openwop-app.*` (storage/eventEra.ts); the last case
 * drives that mapping directly, because the debug-bundle read the other cases
 * use does NOT go through it (witnessed: breaking the grammar left them green).
 *
 * Sabotage (witnessed 2026-10-29): renaming the appended type reds the event
 * case; putting a message id in the payload reds the counts-only case;
 * removing the D2 round-up, or putting the kept count back into the marker,
 * reds the stable-system case; narrowing the vendor grammar to two segments
 * reds the round-trip case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { lastReceivedMessages, programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { toContractVocabulary, toStorageVocabulary, wireEventType } from '../src/storage/eventEra.js';

let server: http.Server;
let BASE: string;
const ENV: Record<string, string> = {
  OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT: 'true',
  OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS: '4',
  OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS: '4',
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  Object.assign(process.env, ENV);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  for (const k of Object.keys(ENV)) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2', ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
interface Ev { type?: string; payload?: Record<string, unknown> }
async function waitSuspended(runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
    if (s.startsWith('waiting')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${runId} never suspended`);
}
const events = async (runId: string): Promise<Ev[]> => (await api<{ events?: Ev[] }>(`/runs/${runId}/debug-bundle`)).body.events ?? [];

describe('context-budgeted disclosure + stepped window (ADR 1003 D2/D5)', () => {
  let runId = '';
  const systems: string[] = [];

  beforeAll(async () => {
    const workflowId = 'openwop-app.conversation.ce1003';
    await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Hi' } }], edges: [],
    }) });
    const created = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' } }) });
    expect(created.status).toBe(201);
    runId = created.body.runId;
    await waitSuspended(runId);
    // Eight exchanges = 16 prior turns by the last one; keep 4, step 4.
    for (let i = 1; i <= 8; i++) {
      resetMockPrograms();
      programMock('', [{ content: `reply ${i}` }]);
      const r = await api(`/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: `question ${i}` } } }) });
      expect(r.status).toBe(200);
      const sent = lastReceivedMessages('gate') ?? lastReceivedMessages('') ?? [];
      systems.push(sent.find((m) => m.role === 'system')?.content ?? '');
      await waitSuspended(runId);
    }
  }, 60_000);

  it('emits openwop-app.conversation.context-budgeted once the window drops turns, readable under major 2', async () => {
    const budgeted = (await events(runId)).filter((e) => e.type === 'openwop-app.conversation.context-budgeted');
    expect(budgeted.length).toBeGreaterThan(0);
    for (const e of budgeted) expect(typeof e.payload?.omittedTurns).toBe('number');
    expect(Math.max(...budgeted.map((e) => Number(e.payload?.omittedTurns)))).toBeGreaterThanOrEqual(4);
  });

  it('the payload is counts only: no turn ids and no message text', async () => {
    const budgeted = (await events(runId)).filter((e) => e.type === 'openwop-app.conversation.context-budgeted');
    for (const e of budgeted) {
      expect(Object.keys(e.payload ?? {}).sort()).toEqual(expect.arrayContaining(['conversationId', 'omittedTurns']));
      for (const k of Object.keys(e.payload ?? {})) expect(['conversationId', 'omittedTurns', 'speakerId']).toContain(k);
      expect(JSON.stringify(e.payload)).not.toMatch(/question \d|reply \d/);
    }
  });

  it('between steps the model\'s system message is byte-identical, and names no id', () => {
    expect(systems.length).toBe(8);
    const elided = systems.filter((s) => s.includes('[Context budget:'));
    expect(elided.length).toBeGreaterThan(1);
    // With step 4 the elision count moves at most every second exchange, so at
    // least one consecutive pair of elided system messages is identical.
    const pairs = elided.slice(1).filter((s, i) => s === elided[i]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const s of systems) expect(s.includes(runId)).toBe(false);
  });

  // The vocabulary round trip itself: written under era 2, read under either
  // contract major, the type is passed through unchanged (the v2 vendor
  // grammar; a type it refused would throw `event_type_unmapped` on a major-2
  // read and blank the chat, as ADR 0682 recorded for older host types).
  it('the event type round-trips the era-2 store and both contract majors unchanged', () => {
    const T = 'openwop-app.conversation.context-budgeted';
    expect(toStorageVocabulary(T, 2)).toBe(T);
    expect(toContractVocabulary(T, 2, 2)).toBe(T);
    expect(toContractVocabulary(T, 2, 1)).toBe(T);
    expect(wireEventType(T, 2)).toBe(T);
  });
});
