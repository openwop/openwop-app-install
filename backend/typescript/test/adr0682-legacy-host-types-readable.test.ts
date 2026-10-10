/**
 * This host's PRE-ADR-0682 event spellings must stay readable on the major-2 wire.
 *
 * ADR 0682 (2026-09-14) moved five host events out of protocol namespaces, and
 * renamed the WRITER only. A conversation is one long-lived run, so every
 * conversation started before that date still holds the old spellings in its
 * era-2 log. None is a codemap row and none carries a vendor prefix, so a major-2
 * read of such a log answered `500 event_type_unmapped` — seen live 2026-10-01 as
 * "No response" on a chat with an agent whose conversation predated the rename.
 *
 * The fixture is what that log actually holds: all five legacy spellings, planted
 * through the production `seedEra2EventLog` seam. It is proved per READER (poll,
 * SSE, fork) rather than once at the storage function — the SSE writer uses
 * `res.write`, and a fix that only covered the JSON readers has shipped before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { hostLegacyReadRows, loadCodemap, toContractVocabulary, toStorageVocabulary } from '../src/storage/eventEra.js';

let server: Server;
let base: string;
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

const LEGACY: { type: string; vendor: string; payload: Record<string, unknown> }[] = [
  { type: 'ai.message.chunk', vendor: 'openwop-app.ai.message-chunk', payload: { chunk: 'Hello' } },
  { type: 'node.message', vendor: 'openwop-app.node.message', payload: { text: 'Hello' } },
  { type: 'node.interrupt.resolved', vendor: 'openwop-app.node.interrupt-resolved', payload: { action: 'approve' } },
  { type: 'ai.message.error', vendor: 'openwop-app.ai.message-error', payload: { message: 'boom' } },
  { type: 'conversation.titled', vendor: 'openwop-app.conversation.titled', payload: { title: 'Changing the world' } },
];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function seedLegacyRun(extra: { type: string; payload: unknown }[] = []): Promise<string> {
  const middle = [...LEGACY.map((l) => ({ type: l.type, payload: l.payload })), ...extra];
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST',
    headers: V2,
    body: JSON.stringify({
      eventLogSchemaVersion: 2,
      status: 'completed',
      events: [
        { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' } },
        ...middle.map((e, i) => ({ sequence: i + 1, type: e.type, nodeId: 'a', payload: e.payload })),
        { sequence: middle.length + 1, type: 'run.completed', payload: {} },
      ],
    }),
  });
  const body = await res.json() as { runId?: string };
  if (res.status !== 201 || !body.runId) throw new Error(`seed answered ${res.status}: ${JSON.stringify(body)}`);
  return body.runId;
}

type Ev = { type: string; payload: unknown; sequence: number };
async function poll(runId: string, headers: Record<string, string>): Promise<{ status: number; events: Ev[]; text: string }> {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers });
  const text = await res.text();
  let events: Ev[] = [];
  try { events = (JSON.parse(text) as { events?: Ev[] }).events ?? []; } catch { /* non-JSON */ }
  return { status: res.status, events, text };
}

describe('a pre-ADR-0682 conversation log stays readable at major 2', () => {
  it('poll answers 200 and serves every legacy row under its vendor spelling, payload untouched', async () => {
    const runId = await seedLegacyRun();
    const r = await poll(runId, V2);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    for (const [i, l] of LEGACY.entries()) {
      const ev = r.events.find((e) => e.sequence === i + 1);
      expect(ev?.type, l.type).toBe(l.vendor);
      expect(JSON.stringify(ev?.payload)).toBe(JSON.stringify(l.payload));
    }
    // No row was dropped to make the read succeed.
    expect(r.events).toHaveLength(LEGACY.length + 2);
  });

  it('the SSE reader serves the same log (it writes frames itself, not through res.json)', async () => {
    const runId = await seedLegacyRun();
    const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events`, { headers: { ...V2, Accept: 'text/event-stream' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('event_type_unmapped');
    for (const l of LEGACY) {
      expect(text, l.type).toContain(l.vendor);
      expect(text, `${l.type} must not reach a major-2 reader`).not.toMatch(new RegExp(`"type":"${l.type.replace(/\./g, '\\.')}"`));
    }
  });

  it('a fork of the log carries the rows and reads at major 2', async () => {
    const runId = await seedLegacyRun();
    const fork = await fetch(`${base}/runs/${encodeURIComponent(runId)}:fork`, { method: 'POST', headers: V2, body: JSON.stringify({ mode: 'replay', fromSeq: LEGACY.length + 1 }) });
    const forkBody = await fork.json() as { runId?: string };
    expect(fork.status, JSON.stringify(forkBody).slice(0, 300)).toBe(201);
    const r = await poll(forkBody.runId!, V2);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    for (const l of LEGACY) expect(r.events.some((e) => e.type === l.vendor), l.type).toBe(true);
  });

  // ADR 0812 P3c-0: "the v1 read is unchanged" leg was deleted with major 1 —
  // `/v1/runs/…/events/poll` is the retired path space; the major-2 legs remain.

  it('a type that is neither corpus, vendor nor legacy is STILL refused — the map is not a tolerant branch', async () => {
    const runId = await seedLegacyRun([{ type: 'made.up.type', payload: {} }]);
    const r = await poll(runId, V2);
    expect(r.status).toBe(500);
    expect(r.text).toContain('event_type_unmapped');
  });
});

describe('the legacy map is read-only and cannot shadow the protocol', () => {
  it('covers exactly the five ADR 0682 renames', () => {
    expect([...hostLegacyReadRows().entries()].sort()).toEqual(LEGACY.map((l) => [l.type, l.vendor]).sort());
  });

  it('no legacy name or target is a corpus codemap row, on either side', () => {
    const { forward, inverse } = loadCodemap();
    for (const [legacy, vendor] of hostLegacyReadRows()) {
      expect(forward.has(legacy), legacy).toBe(false);
      expect(inverse.has(legacy), legacy).toBe(false);
      expect(forward.has(vendor), vendor).toBe(false);
      expect(inverse.has(vendor), vendor).toBe(false);
    }
  });

  it('every target is a registered vendor type the major-2 reader passes through', () => {
    for (const vendor of hostLegacyReadRows().values()) expect(toContractVocabulary(vendor, 2, 2)).toBe(vendor);
  });

  it('WRITES are untouched: the vendor spelling is stored as written, never put back under the old name', () => {
    for (const [legacy, vendor] of hostLegacyReadRows()) {
      expect(toStorageVocabulary(vendor, 2)).toBe(vendor);
      expect(toStorageVocabulary(vendor, 3)).toBe(vendor);
      // ...and the v1 read of the vendor spelling is not inverted to the old one.
      expect(toContractVocabulary(vendor, 2, 1)).toBe(vendor);
      expect(toContractVocabulary(vendor, 3, 1)).toBe(vendor);
      // The legacy name on the v1 wire stays what was stored.
      expect(toContractVocabulary(legacy, 2, 1)).toBe(legacy);
    }
  });
});
