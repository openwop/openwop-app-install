/**
 * RFC 0176 — the era-2 seed seam, and the ONE property that makes it worth
 * having: the rows land VERBATIM.
 *
 * Four read-projection scenarios (`v2-v1-events-translated`,
 * `v2-unmapped-type-refused`, `v2-fork-a-v1-run`, `v2-pinned-run-disposition`)
 * read a log this seam plants. If the seam normalised the `type` strings on the
 * way in, all four would pass while testing nothing — the translation they exist
 * to witness would have already happened before they looked. So the assertions
 * below are about what is STORED, not about the 201.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import { registerEventLogSeedSeam } from '../src/routes/eventLogSeedSeam.js';
import { validateSeedBody } from '../src/routes/eventLogSeedSeam.js';
import { seamsFloorServed } from '../src/routes/conformanceSeams.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const SEED = '/conformance/seams/sample/event-log/seed';

// v1 SPELLINGS on purpose — an era-2 log is one written before the v2 cut.
const V1_EVENTS = [
  { type: 'run.started', sequence: 0, payload: { workflowId: 'legacy.wf' } },
  { type: 'node.completed', sequence: 1, payload: { nodeId: 'n1' } },
  { type: 'run.completed', sequence: 2, payload: { status: 'completed' } },
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

async function seed(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${SEED}`, {
    method: 'POST', headers: { ...AUTH, 'OpenWOP-Version': '2' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe('era-2 event-log seed seam (RFC 0176)', () => {
  it('plants a run and returns a tenant-bound wire run id', async () => {
    const res = await seed({ eventLogSchemaVersion: 2, status: 'completed', events: V1_EVENTS });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(typeof res.json['runId']).toBe('string');
    // The seeded run belongs to the CALLER'S tenant, not a fixture tenant. It was
    // `sample-era2-tenant`, which made the run unreadable by the caller that had
    // just created it — every seed-then-read scenario got 403 from the id-only
    // tenant check and the suite reported it as a translation gap.
    expect(String(res.json['runId']), 'v2 run ids are tenant-bound').toMatch(/^[^/]+\/[0-9a-f-]{36}$/);
    const seededTenant = String(res.json['runId']).split('/')[0];
    // And the read-back must actually work — the property the fixture tenant broke.
    const readBack = await fetch(`${base}/runs/${encodeURIComponent(String(res.json['runId']))}`, {
      headers: { ...AUTH, 'OpenWOP-Version': '2' },
    });
    expect(readBack.status, `the caller must be able to read the run it just seeded (tenant ${seededTenant})`).not.toBe(403);
  });

  /**
   * Read back through STORAGE, not the wire.
   *
   * This leg was written first against `GET /v1/runs/{id}/events` and PASSED —
   * because that read is tenant-scoped to the caller and answers 404 for the
   * seam's own tenant, so an early return skipped the assertion entirely. Six
   * green tests, and the one that carried the whole point of the seam was
   * asserting nothing. It only surfaced because the early return was replaced
   * with a probe that printed the status.
   *
   * The claim is about what is STORED, so storage is the right instrument.
   */
  it('persists the v1 type spellings and sequence space VERBATIM — the property all four reader scenarios depend on', async () => {
    const storage = await openStorage('memory://');
    const app = express();
    app.use(express.json());
    registerEventLogSeedSeam(app, { storage });
    const local = await new Promise<Server>((r) => { const srv = app.listen(0, '127.0.0.1', () => r(srv)); });
    try {
      const port = (local.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/host/sample/event-log/seed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventLogSchemaVersion: 2, status: 'completed', events: V1_EVENTS }),
      });
      expect(res.status).toBe(201);
      const rawId = String(((await res.json()) as { runId: string }).runId).split('/').pop() ?? '';

      const events = await storage.listEvents(rawId, { fromSeq: -1 });
      expect(events.map((e) => e.type), 'stored types must be the v1 spellings sent, untranslated').toEqual(
        V1_EVENTS.map((e) => e.type),
      );
      expect(events.map((e) => e.sequence), 'the given sequence space, starting at 0').toEqual([0, 1, 2]);
      expect(events.map((e) => e.payload), 'payloads untouched').toEqual(V1_EVENTS.map((e) => e.payload));

      // THE decisive assertion, and the one that found the defect. The type
      // check above is weaker than it looks: the read path maps an era-3 log
      // back to v1 spellings for a v1 reader, so those types come back correct
      // whether the run is era 2 or era 3. Only the stored era distinguishes
      // them — and without this line the seam planted era-3 runs while every
      // other assertion in the file stayed green.
      const run = await storage.getRun(rawId);
      expect(run?.eventLogSchemaVersion, 'the fixture must BE era 2; this host stamps 3 on any run inserted without one').toBe(2);
    } finally { await new Promise<void>((r) => local.close(() => r())); }
  });

  it('refuses a non-contiguous sequence space rather than renumbering it', () => {
    const bad = validateSeedBody({
      eventLogSchemaVersion: 2, status: 'completed',
      events: [{ type: 'run.started', sequence: 0, payload: {} }, { type: 'run.completed', sequence: 7, payload: {} }],
    });
    expect('error' in bad).toBe(true);
    expect('error' in bad && bad.error).toMatch(/contiguous from 0/);
    // The point is the DISPOSITION: a renumbering seam would have returned the
    // events happily and stored a log the caller never asked for.
    expect('error' in bad && bad.error).toMatch(/VERBATIM|verbatim/);
  });

  it('closed-world validates the body — every field the contract constrains', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ eventLogSchemaVersion: 3, status: 'completed', events: V1_EVENTS }, /literal 2/],
      [{ eventLogSchemaVersion: 2, status: 'paused', events: V1_EVENTS }, /status must be one of/],
      [{ eventLogSchemaVersion: 2, status: 'completed', events: [] }, /non-empty/],
      [{ eventLogSchemaVersion: 2, status: 'completed', events: [{ type: '', sequence: 0, payload: {} }] }, /type must be/],
      [{ eventLogSchemaVersion: 2, status: 'completed', events: [{ type: 'x.y', sequence: -1, payload: {} }] }, /sequence must be/],
      [{ eventLogSchemaVersion: 2, status: 'completed', events: [{ type: 'x.y', sequence: 0, payload: 'no' }] }, /payload must be/],
    ];
    for (const [body, re] of cases) {
      const out = validateSeedBody(body);
      expect('error' in out, `expected a refusal for ${JSON.stringify(body).slice(0, 70)}`).toBe(true);
      if ('error' in out) expect(out.error).toMatch(re);
    }
    // Non-vacuity: the valid body must PASS, or every case above is trivially true.
    expect('error' in validateSeedBody({ eventLogSchemaVersion: 2, status: 'completed', events: V1_EVENTS })).toBe(false);
  });

  it('the seams advert reads the env gate, not just the manifest', () => {
    const prev = process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'false';
      expect(
        seamsFloorServed(),
        'with the seam surface disabled every seam 404s, so the advert must be off regardless of the manifest',
      ).toBe(false);
    } finally { process.env.OPENWOP_TEST_SEAM_ENABLED = prev; }
  });

  it('404s when the seam surface is disabled', async () => {
    const prev = process.env.OPENWOP_TEST_SEAM_ENABLED;
    try {
      process.env.OPENWOP_TEST_SEAM_ENABLED = 'false';
      const res = await seed({ eventLogSchemaVersion: 2, status: 'completed', events: V1_EVENTS });
      expect(res.status).toBe(404);
    } finally { process.env.OPENWOP_TEST_SEAM_ENABLED = prev; }
  });
});
