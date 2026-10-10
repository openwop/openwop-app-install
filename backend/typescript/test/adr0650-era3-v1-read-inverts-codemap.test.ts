/**
 * The v1 wire of an era-3 log (`persistence.md` §The v1 wire of an era-3 log):
 * a run created under major 2 stores v2 spellings; a major-1 reader MUST see
 * the v1 spelling of every RENAMED type (36 codemap rows, e.g.
 * `run.resume-started` ↔ `run.resuming`). `storage/eventEra.ts
 * toContractVocabulary` inverts the codemap (bijection asserted at load). The
 * mechanism shipped with ADR 0650; this is its first HTTP witness — the corpus
 * steward found the reference host had never inverted and every cut was green,
 * because no fixture emits a renamed type (bus `ac81`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';
import type { Storage } from '../src/storage/storage.js';

let server: http.Server; let base = ''; let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals['storage'] as Storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}
const V2 = { 'OpenWOP-Version': '2' };
const types = (r: { json: any }): string[] => (r.json.events as Array<{ type: string }>).map((e) => e.type);

describe('era-3 log read on the v1 wire inverts the codemap', () => {
  it('a renamed type stored in its v2 spelling reads as v2 on the major-2 read', async () => {
    // An IN-FLIGHT run: the seeded types include forward execution
    // (`run.resume-started`, `interrupt.requested`), which RFC 0194 refuses at
    // the store behind a terminal event. `conformance-noop` completes at once;
    // `conformance-cancellable` holds until cancelled.
    const created = await req('POST', '/runs', V2, { workflowId: 'conformance-cancellable', inputs: {} });
    expect(created.status, created.text.slice(0, 160)).toBe(201);
    const bound = created.json.runId as string; const bare = bound.split('/')[1]!;
    // Append in the v2 spelling straight at the seat: the era adapter keeps the
    // run's era vocabulary at rest whichever spelling the caller used.
    await storage.appendEvent({ eventId: randomUUID(), runId: bare, type: 'run.resume-started', payload: {}, timestamp: new Date().toISOString() });
    await storage.appendEvent({ eventId: randomUUID(), runId: bare, type: 'replay.diverged-at-refusal', payload: { sourceRunId: bare, atSequence: 1 }, timestamp: new Date().toISOString() });

    // ADR 0812 P3c-0: the two /v1 legs (the inverse-codemap spelling on the v1
    // wire, and the v2-only type passing through it) were deleted with major 1;
    // the major-2 read of the same era-3 log is what remains.
    await storage.appendEvent({ eventId: randomUUID(), runId: bare, type: 'interrupt.requested', payload: { kind: 'custom', key: 'k', data: { customKind: 'x' } }, timestamp: new Date().toISOString() });

    const v2 = await req('GET', `/runs/${projectBoundId(bound)}/events/poll`, V2);
    expect(v2.status, v2.text.slice(0, 160)).toBe(200);
    expect(types(v2), 'major-2 wire: the v2 spelling, untouched').toEqual(expect.arrayContaining(['run.resume-started', 'replay.diverged-at-refusal', 'interrupt.requested']));
    expect(types(v2), 'major-2 wire: never the v1 spelling').not.toEqual(expect.arrayContaining(['run.resuming']));
  });
});
