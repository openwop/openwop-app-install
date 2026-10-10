/**
 * RFC 0239 council-roster refusals (ADR 0858 P3 behaviour gap: multiPartyConversation).
 *
 * `multiPartyConversation` was withdrawn from the v2 document because, once
 * advertised, `v2-multi-party-council` failed two legs:
 *
 *   speaker-refused  a bare `{ role:'agent', speakerId, content }` resume value
 *                    fell into the chat exchange path, which found no
 *                    `turn.content` and answered `422 validation_error` with no
 *                    `details.speakerId` — for the intruder AND for the roster
 *                    member's control turn, so the roster was never enforced and
 *                    no member could ever speak;
 *   roster-exceeded  a 64-member `core.conversationGate` roster was admitted
 *                    `201` against an advertised `maxParticipants` of 8.
 *
 * Both are driven here through the same normative operations the suite uses
 * (run creation, the event poll, `resolveInterrupt`) at major 2.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../src/host/multiPartyConversation.js';

let server: Server; let base = '';
const ADMIN = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...ADMIN, 'OpenWOP-Version': '2' };

const COUNCIL = 'openwop-app.test.council-roster';
const OVERSIZE = 'openwop-app.test.council-roster-oversize';
const ROSTER = ['host:council-a', 'host:council-b', 'host:council-c'];
const INTRUDER = 'host:council-intruder';

const gate = (n: number | string[]) => ({
  nodeId: 'convo', typeId: 'core.conversationGate',
  config: {
    lifecycle: 'open-exchange-close', mockAutoResume: false,
    participants: (Array.isArray(n) ? n : Array.from({ length: n }, (_, i) => `host:member-${i}`)).map((agentId) => ({ agentId })),
  },
});

async function register(workflowId: string, node: ReturnType<typeof gate>): Promise<void> {
  const res = await fetch(`${base}/host/openwop-app/workflows`, {
    method: 'POST', headers: ADMIN, body: JSON.stringify({ workflowId, nodes: [node], edges: [] }),
  });
  expect([200, 201, 409], `register ${workflowId}: ${res.status}`).toContain(res.status);
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

const errCode = (j: Record<string, unknown>): unknown =>
  typeof j['error'] === 'string' ? j['error'] : (j['error'] as { code?: unknown } | undefined)?.code;
const details = (j: Record<string, unknown>): Record<string, unknown> =>
  ((j['details'] ?? (j['error'] as { details?: unknown } | undefined)?.details ?? {}) as Record<string, unknown>);

async function runStatus(runId: string): Promise<string> {
  return String((await call('GET', `/runs/${encodeURIComponent(runId)}`)).json['status'] ?? '');
}
async function exchangedCount(runId: string): Promise<number> {
  const r = await call('GET', `/runs/${encodeURIComponent(runId)}/events/poll`);
  const evs = (Array.isArray(r.json['events']) ? r.json['events'] : []) as Array<{ type?: string }>;
  expect(evs.length, 'the event poll must read real events or the count asserts nothing').toBeGreaterThan(0);
  return evs.filter((e) => e.type === 'conversation.exchanged').length;
}
const resolve = (runId: string, speakerId: string) =>
  call('POST', `/runs/${encodeURIComponent(runId)}/interrupts/convo`, { resumeValue: { role: 'agent', speakerId, content: 'council turn' } });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await register(COUNCIL, gate(ROSTER));
  await register(OVERSIZE, gate(MAX_MULTI_PARTY_PARTICIPANTS + 1));
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('RFC 0239 §B — an off-roster resumed turn', () => {
  it('is 422 conversation_speaker_not_participant naming the speaker, unconsumed; a member then resolves it', async () => {
    const created = await call('POST', '/runs', { workflowId: COUNCIL });
    expect(created.status).toBe(201);
    const runId = String(created.json['runId']);
    for (let i = 0; i < 100 && !(await runStatus(runId)).startsWith('waiting'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(await runStatus(runId)).toMatch(/^waiting/);

    const refused = await resolve(runId, INTRUDER);
    expect(refused.status).toBe(422);
    expect(errCode(refused.json), 'a registered code travels unprefixed at v2').toBe('conversation_speaker_not_participant');
    expect(details(refused.json)['speakerId']).toBe(INTRUDER);
    expect(await runStatus(runId), 'the refused turn MUST NOT be consumed').toMatch(/^waiting/);
    expect(await exchangedCount(runId)).toBe(0);

    const member = await resolve(runId, ROSTER[0]!);
    expect(member.status, JSON.stringify(member.json)).toBeGreaterThanOrEqual(200);
    expect(member.status).toBeLessThan(300);
    expect(await exchangedCount(runId)).toBe(1);
    expect(await runStatus(runId), 'an exchange never resumes the gate').toMatch(/^waiting/);
  });
});

describe('RFC 0239 §C — an oversized roster', () => {
  it('is refused at run creation with 422 conversation_roster_exceeded and opens no run', async () => {
    const before = await call('GET', `/runs?workflowId=${encodeURIComponent(OVERSIZE)}`);
    const created = await call('POST', '/runs', { workflowId: OVERSIZE });
    expect(created.status, JSON.stringify(created.json)).toBe(422);
    expect(errCode(created.json)).toBe('conversation_roster_exceeded');
    expect(details(created.json)['maxParticipants']).toBe(MAX_MULTI_PARTY_PARTICIPANTS);
    expect(created.json['runId']).toBeUndefined();
    const after = await call('GET', `/runs?workflowId=${encodeURIComponent(OVERSIZE)}`);
    expect(after.status).toBe(200);
    const items = (r: Record<string, unknown>): unknown[] => (Array.isArray(r['runs']) ? r['runs'] : Array.isArray(r['items']) ? r['items'] : []) as unknown[];
    expect(items(after.json).length, 'no run row may be written for a refused roster').toBe(items(before.json).length);
  });

  it('a roster AT the cap is admitted (the refusal is the cap, not the presence of a roster)', async () => {
    await register(`${OVERSIZE}-at-cap`, gate(MAX_MULTI_PARTY_PARTICIPANTS));
    const created = await call('POST', '/runs', { workflowId: `${OVERSIZE}-at-cap` });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
  });
});
