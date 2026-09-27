import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

/**
 * `persistence.md` §"Runs pinned to v1" — a non-terminal run a v2 host inherits
 * carries `version.pinned` events naming change ids. The host MUST continue it
 * or cancel it, **never follow a pin silently**. Any pinned change id no longer
 * implemented ⇒ `run.cancelled` with reason `v1_pin_unsupported` and
 * `cancelledBy: "v2-cutover"`.
 */
let server: Server;
let base: string;
let savedKeys: string | undefined;
/** Headers for a v2 request as the given bearer key. */
const v2As = (key: string) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2' });
/**
 * BOTH principals, because the rule silently held for only one of them. The
 * wildcard `dev-token` is what every host test authenticates as; a configured
 * key is what every real caller (and the conformance harness) is. The tenant
 * branch of `loadReadableRun` skipped the disposition, and a suite that only
 * ever read as the wildcard could not see it.
 */
const PRINCIPALS = [
  { label: 'the wildcard operator (dev-token)', key: 'dev-token' },
  { label: 'a configured tenant key', key: 'k-pin-tenant' },
] as const;
let V2 = v2As('dev-token');

beforeAll(async () => {
  savedKeys = process.env.OPENWOP_API_KEYS;
  process.env.OPENWOP_API_KEYS = 'dev-token:*,k-pin-tenant:pin-tenant';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
});

/** A RUNNING era-2 log — the rule governs runs the host INHERITS non-terminal. */
function pinnedLog(changeId: string) {
  return [
    { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' } },
    { sequence: 1, type: 'version.pinned', payload: { changeId, version: 1 } },
  ];
}

async function seedPinned(changeId: string): Promise<string> {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST', headers: V2,
    body: JSON.stringify({ eventLogSchemaVersion: 2, status: 'running', events: pinnedLog(changeId) }),
  });
  const body = await res.json() as { runId?: string };
  if (res.status !== 201 || !body.runId) throw new Error(`seed answered ${res.status}: ${JSON.stringify(body)}`);
  return body.runId;
}

async function readRun(runId: string) {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { headers: V2 });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

async function readEvents(runId: string) {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events/poll?timeout=1`, { headers: V2 });
  const b = await res.json().catch(() => null) as { events?: Array<Record<string, unknown>> } | null;
  return b?.events ?? [];
}

describe.each(PRINCIPALS)('runs pinned to v1 — read as $label', ({ key }) => {
  beforeAll(() => { V2 = v2As(key); });
  it('an UNSUPPORTED pin cancels the run with v1_pin_unsupported / v2-cutover', async () => {
    const changeId = `conformance-unknown-change-${Date.now().toString(36)}`;
    const runId = await seedPinned(changeId);
    await readEvents(runId);

    const { body } = await readRun(runId);
    expect(
      body?.status,
      'a run pinned to a change id this host does not implement MUST be cancelled, never followed silently',
    ).toBe('cancelled');

    const events = await readEvents(runId);
    const cancelled = events.filter((e) => e['type'] === 'run.cancelled');
    expect(cancelled.length, 'the cancellation MUST be an event on the run\'s own log').toBe(1);
    const payload = (cancelled[0]?.['payload'] ?? {}) as Record<string, unknown>;
    expect(payload['reason']).toBe('v1_pin_unsupported');
    expect(payload['cancelledBy']).toBe('v2-cutover');
    expect(JSON.stringify(payload), 'the payload names the pin that forced it').toContain(changeId);
  });

  it('re-reading does NOT cancel twice — the disposition is idempotent', async () => {
    // A read that WRITES must be compare-and-set. Without it every poll appends
    // another `run.cancelled`, and the log grows one event per reader.
    const runId = await seedPinned(`conformance-unknown-change-${Date.now().toString(36)}-b`);
    await readEvents(runId); await readEvents(runId); await readEvents(runId);
    const cancelled = (await readEvents(runId)).filter((e) => e['type'] === 'run.cancelled');
    expect(cancelled.length, 'one cancellation, however many times the run is read').toBe(1);
  });

  it('a SUPPORTED pin continues — the rule is not "cancel every pinned run"', async () => {
    // Non-vacuity in the dangerous direction. A host that cancelled unconditionally
    // would pass the first leg while destroying every inherited run.
    const changeId = 'conformance-implemented-change';
    const prev = process.env.OPENWOP_IMPLEMENTED_CHANGE_IDS;
    process.env.OPENWOP_IMPLEMENTED_CHANGE_IDS = changeId;
    try {
      const runId = await seedPinned(changeId);
      await readEvents(runId);
      const { body } = await readRun(runId);
      expect(body?.status, 'every pinned change id is implemented, so the run MUST continue').not.toBe('cancelled');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_IMPLEMENTED_CHANGE_IDS; else process.env.OPENWOP_IMPLEMENTED_CHANGE_IDS = prev;
    }
  });
});
