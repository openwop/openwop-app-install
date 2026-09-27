/**
 * ADR 0755 (WIT-ART-2) — the 1:1 chat's fallback agent turn names a speaker.
 *
 * ADR 0746 put `parts` on every turn, and RFC 0205's `turn-parts-emitted` leg fails
 * a parts-bearing turn that does not validate against the closed v2 turn def. That
 * def REQUIRES `speakerId` on `role:'agent'` (RFC 0101). ADR 0746 fixed the fixture
 * node but not the real exchange: when no agent resolves, the fallback `'assistant'`
 * turn carried `parts` and no `speakerId`, so every 1:1 chat reply was v2-invalid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { programMock } from '../src/providers/dispatchMock.js';

const V2_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');
let server: http.Server;
let BASE = '';
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

async function waitSettled(runId: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return;
  }
}

function turnValidator(): (doc: unknown) => { ok: boolean; errors: string } {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
  for (const f of readdirSync(V2_DIR)) {
    if (!f.endsWith('.schema.json')) continue;
    try { ajv.addSchema(JSON.parse(readFileSync(join(V2_DIR, f), 'utf8')) as Record<string, unknown>); } catch { /* duplicate $id */ }
  }
  const fn = ajv.getSchema('https://openwop.dev/spec/v2/conversation-turn.schema.json')!;
  return (doc) => ({ ok: fn(doc) as boolean, errors: JSON.stringify(fn.errors ?? []) });
}

describe('ADR 0755 (WIT-ART-2) — the fallback agent turn', () => {
  it('carries speakerId and validates against the closed v2 turn def', async () => {
    const workflowId = 'adr0755.fallback.speaker';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
    const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) })).body.runId;
    await waitSettled(runId);
    programMock('', [{ content: 'Ship on Tuesday.' }]);
    const ex = await api(`/v1/runs/${runId}/interrupts/gate`, {
      method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'what do you think?' } } }),
    });
    expect(ex.status, JSON.stringify(ex.body).slice(0, 300)).toBe(200);
    await waitSettled(runId);
    const events = (await api<{ events?: Array<{ type?: string; payload?: Record<string, unknown> }> }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
    const agent = events
      .filter((e) => e.type === 'conversation.exchanged')
      .map((e) => e.payload!['turn'] as Record<string, unknown>)
      .filter((t) => t?.['role'] === 'agent')
      .pop();
    expect(agent, 'the exchange must persist an agent turn or nothing below asserts anything').toBeTruthy();
    expect(agent!['parts'], 'precondition: ADR 0746 puts parts on the turn').toBeDefined();
    expect(agent!['speakerId']).toBe('assistant');
    const r = turnValidator()(agent);
    expect(r.ok, r.errors).toBe(true);
  });
});
