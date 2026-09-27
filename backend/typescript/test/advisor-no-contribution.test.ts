/**
 * ADR 0665 D4 — an empty advisor completion is a typed NON-CONTRIBUTION turn, not an
 * attributed empty one.
 *
 * Born red: the exchange persisted `content: ''`. In a council that is the worst
 * available record — a silent advisor is indistinguishable from one that was never
 * asked, and (because the chair synthesises over the transcript) indistinguishable
 * from one that AGREED.
 *
 * The second half of the decision is that it must be NON-HALTING.
 * `useBoardroomCadence` abandons the whole remaining queue on an `errored` edge, so
 * raising an empty completion as an exchange failure would drop every remaining
 * advisor AND the synthesis turn — the very synthesis meant to report the absence.
 * The route legs below assert the exchange still SUCCEEDS, which is what keeps the
 * cadence marching.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { programMock } from '../src/providers/dispatchMock.js';
import { producedNothing, isNoContribution, asText, NO_CONTRIBUTION_TEXT } from '../src/host/exchange/contentParts.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function openGateRun(workflowId: string): Promise<string> {
  await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
  const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) })).body.runId;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (s.startsWith('waiting')) break;
  }
  return runId;
}

interface Ev { type?: string; payload?: Record<string, unknown> }

/** The last persisted `role:'agent'` turn — read from the DURABLE event log, which
 *  is the record that matters here (the exchange ack carries only a turn COUNT). */
async function lastAgentTurn(runId: string): Promise<{ role?: string; content?: unknown; speakerId?: string } | undefined> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const st = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (st.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(st)) break;
  }
  const events = (await api<{ events?: Ev[] }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
  return events
    .filter((e) => e.type === 'conversation.exchanged')
    .map((e) => e.payload!.turn as { role?: string; content?: unknown; speakerId?: string })
    .filter((t) => t?.role === 'agent')
    .pop();
}

describe('ADR 0665 D4 — the predicate', () => {
  it('blank prose with no ignited run is a non-contribution', () => {
    expect(producedNothing('', 0)).toBe(true);
    expect(producedNothing('   \n\t ', 0)).toBe(true);
  });

  it('blank prose that IGNITED A RUN is NOT — that agent contributed, via the run bubbles', () => {
    // The clause a narrower fix would have dropped. Marking this turn "silent" would be
    // a false record in the opposite direction from the one being fixed.
    expect(producedNothing('', 1)).toBe(false);
    expect(producedNothing('', 3)).toBe(false);
  });

  it('real prose is never a non-contribution, with or without runs', () => {
    expect(producedNothing('Ship on Tuesday.', 0)).toBe(false);
    expect(producedNothing('Ship on Tuesday.', 2)).toBe(false);
  });
});

describe('ADR 0665 D4 — the text projection', () => {
  it('the typed content projects to an explicit marker, never JSON and never blank', () => {
    // Without this arm of `asText`, the object falls through to the JSON fallback and a
    // raw `{"kind":"no_contribution"…}` lands in the next advisor's prompt.
    const content: unknown = { kind: 'no_contribution', reason: 'empty_completion', agentId: 'ada' };
    expect(isNoContribution(content)).toBe(true);
    expect(asText(content)).toBe(NO_CONTRIBUTION_TEXT);
    expect(asText(content)).not.toContain('{');
    expect(asText(content).length).toBeGreaterThan(0);
  });

  it('ordinary content is untouched by the new arm', () => {
    expect(asText('hello')).toBe('hello');
    expect(isNoContribution('hello')).toBe(false);
    expect(isNoContribution(null)).toBe(false);
    expect(isNoContribution([{ type: 'text', text: 'x' }])).toBe(false);
  });
});

describe('ADR 0665 D4 — the exchange persists it, and does NOT halt', () => {
  it('an empty completion persists a TYPED non-contribution turn and the exchange still succeeds', async () => {
    // The unprogrammed mock returns '' for a chat call — the real shape of this defect.
    const runId = await openGateRun('adr0665.d4.empty');
    const ex = await api(`/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'what do you think?' } } }),
    });
    // NON-HALTING: a 2xx is what keeps `errored` false, so the cadence dispatches the
    // remaining advisors and the synthesis. A typed exchange failure here would drop both.
    expect(ex.status, JSON.stringify(ex.body).slice(0, 300)).toBe(200);
    const turn = await lastAgentTurn(runId);
    expect(turn, 'the advisor was asked — the transcript must show the seat').toBeTruthy();
    expect(turn!.content, 'NOT an attributed empty turn').not.toBe('');
    expect(isNoContribution(turn!.content)).toBe(true);
    expect((turn!.content as { reason?: string }).reason).toBe('empty_completion');
  });

  it('positive control — a real completion is stored as prose, not as a non-contribution', async () => {
    const runId = await openGateRun('adr0665.d4.spoke');
    // The conversation gate dispatches with an empty nodeId key (see the RFC 0101 suite).
    programMock('', [{ content: 'Ship on Tuesday.' }]);
    const ex = await api(`/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'what do you think?' } } }),
    });
    expect(ex.status).toBe(200);
    const turn = await lastAgentTurn(runId);
    expect(isNoContribution(turn!.content), 'a speaking advisor is never marked silent').toBe(false);
    expect(String(turn!.content)).toContain('Ship on Tuesday.');
  });
});
