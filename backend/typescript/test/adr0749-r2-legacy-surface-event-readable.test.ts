/**
 * ADR 0749 R2 — a `ui.a2ui-surface` run event recorded before RFC 0209 must stay
 * readable on the major-2 wire (RFC 0209 §C.11: "A reader MUST keep accepting
 * schema-version-1 envelopes on replay, fork and poll for the life of the major").
 *
 * The fixture is the REAL pre-change row: exactly what the RFC 0114 v1 emit seam
 * (`routes/testSeam.ts`, `POST …/a2ui/emit-surface`) appended — `type:
 * 'ui.a2ui-surface'`, a flat `{ catalogVersion, surface }` payload — planted in
 * an era-2 log through the production `seedEra2EventLog` seam.
 *
 * Before the fix, every major-2 read of that log answered `500
 * event_type_unmapped`: `ui` is not a registered org, and RFC 0209 §D.14's
 * `ui.*` carve-out covers envelope KINDS, not event TYPES (events.md §Types).
 * The fix translates the type's SPELLING onto this host's registered vendor org
 * (`openwop-app.a2ui-surface`) — the payload is never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { toContractVocabulary, toStorageVocabulary } from '../src/storage/eventEra.js';

let server: Server;
let base: string;
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

/** Byte-for-byte what the v1 emit seam recorded (RFC 0102 0.9.1 tree). */
const LEGACY_SURFACE = {
  catalogVersion: '0.9.1',
  surface: {
    title: 'Schedule the kickoff',
    components: [
      { component: 'field.date', id: 'date', label: 'Date', required: true },
      { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
    ],
  },
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function seedLegacyRun(): Promise<string> {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST',
    headers: V2,
    body: JSON.stringify({
      eventLogSchemaVersion: 2,
      status: 'completed',
      events: [
        { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' } },
        { sequence: 1, type: 'ui.a2ui-surface', payload: LEGACY_SURFACE },
        { sequence: 2, type: 'node.started', nodeId: 'a', payload: {} },
        { sequence: 3, type: 'node.completed', nodeId: 'a', payload: {} },
        { sequence: 4, type: 'run.completed', payload: {} },
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

describe('ADR 0749 R2 — a pre-RFC-0209 surface event stays readable at major 2', () => {
  it('poll answers 200 and returns the legacy surface byte-equal, under a registered vendor type', async () => {
    const runId = await seedLegacyRun();
    const r = await poll(runId, V2);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    const surface = r.events.find((e) => e.sequence === 1);
    expect(surface?.type).toBe('openwop-app.a2ui-surface');
    expect(JSON.stringify(surface?.payload)).toBe(JSON.stringify(LEGACY_SURFACE));
  });

  it('a fork after the surface carries it unchanged', async () => {
    const runId = await seedLegacyRun();
    const fork = await fetch(`${base}/runs/${encodeURIComponent(runId)}:fork`, { method: 'POST', headers: V2, body: JSON.stringify({ mode: 'replay', fromSeq: 4 }) });
    const forkBody = await fork.json() as { runId?: string };
    expect(fork.status, JSON.stringify(forkBody).slice(0, 200)).toBe(201);
    const r = await poll(forkBody.runId!, V2);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.events.some((e) => e.type === 'openwop-app.a2ui-surface' && JSON.stringify(e.payload) === JSON.stringify(LEGACY_SURFACE))).toBe(true);
  });
});

describe('the spelling is a bijection that never reaches the v1 wire', () => {
  it('an era-3 log stores the vendor spelling and the v1 read inverts it; an era-2 log keeps the v1 spelling at rest', () => {
    expect(toStorageVocabulary('ui.a2ui-surface', 3)).toBe('openwop-app.a2ui-surface');
    expect(toStorageVocabulary('ui.a2ui-surface', 2)).toBe('ui.a2ui-surface');
    expect(toContractVocabulary('openwop-app.a2ui-surface', 3, 1)).toBe('ui.a2ui-surface');
    expect(toContractVocabulary('ui.a2ui-surface', 2, 1)).toBe('ui.a2ui-surface');
    expect(toContractVocabulary('ui.a2ui-surface', 2, 2)).toBe('openwop-app.a2ui-surface');
    // An era-3 row written before this fix (verbatim) is forwarded too.
    expect(toContractVocabulary('ui.a2ui-surface', 3, 2)).toBe('openwop-app.a2ui-surface');
  });
});
