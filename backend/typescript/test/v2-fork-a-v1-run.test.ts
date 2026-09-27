import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

/**
 * RFC 0176 §A.5 / `replay.md` §"Forking a v1 run" — a v2 host MUST fork a run
 * created before the era cut. The corpus leg reports 404 from
 * `POST /runs/{runId}:fork` on an era-2 parent; this is the same drive, local.
 */
let server: Server;
let base: string;
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/**
 * Explicit, far-past timestamps — the fixture is what makes "untouched"
 * assertable at all. With the seam's default stamps a re-stamping fork would be
 * indistinguishable from a faithful one, because both would read as ~now.
 */
const TS = (n: number) => `2026-01-15T10:0${n}:00.000Z`;
const LOG = [
  { sequence: 0, type: 'run.started', payload: { workflowId: 'conformance-noop' }, timestamp: TS(0) },
  { sequence: 1, type: 'node.started', nodeId: 'a', payload: {}, timestamp: TS(1) },
  { sequence: 2, type: 'node.completed', nodeId: 'a', payload: {}, timestamp: TS(2) },
  { sequence: 3, type: 'run.completed', payload: {}, timestamp: TS(3) },
];

async function seedEra2(): Promise<string> {
  const res = await fetch(`${base}/conformance/seams/sample/event-log/seed`, {
    method: 'POST', headers: V2,
    body: JSON.stringify({ eventLogSchemaVersion: 2, status: 'completed', events: LOG }),
  });
  const body = await res.json() as { runId?: string };
  if (res.status !== 201 || !body.runId) throw new Error(`seed answered ${res.status}: ${JSON.stringify(body)}`);
  return body.runId;
}

describe('forking a v1 (era-2) run', () => {
  it('POST /runs/{id}:fork on an era-2 parent is accepted, not 404', async () => {
    const runId = await seedEra2();
    const fromSeq = Math.max(...LOG.map((e) => e.sequence));
    const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}:fork`, {
      method: 'POST', headers: V2, body: JSON.stringify({ mode: 'replay', fromSeq }),
    });
    const body = await res.text();
    expect(
      res.status,
      `a v2 host MUST fork a run created before the cut (replay.md §"Forking a v1 run"); got ${res.status}: ${body.slice(0, 300)}`,
    ).toBe(201);
  });

  it("the fork's inherited prefix carries the SOURCE timestamps, not fork time", async () => {
    // ADR 0687. The prefix-copy loop in `routes/runs.ts` omitted `timestamp`,
    // so the event log stamped `now` and every copied event claimed to have
    // happened at fork time. `persistence.md` §"The reader rule": `timestamp`
    // passes through untouched.
    //
    // The corpus asserts this (`v2-v1-events-translated`) but could not SEE it:
    // the scenario failed earlier on a 404, because the era-2 translation never
    // refused and the fork found nothing to read. This is the local witness so
    // a regression reds here in 40ms rather than in an 8-minute lane.
    const runId = await seedEra2();
    const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}:fork`, {
      method: 'POST', headers: V2, body: JSON.stringify({ mode: 'branch', fromSeq: 2 }),
    });
    // Read the body ONCE — an `await res.text()` inside the expect message
    // consumes it, and the leg then fails on "Body is unusable" instead of on
    // the thing it asserts.
    const forkBody = await res.text();
    expect(res.status, forkBody.slice(0, 300)).toBe(201);
    const { runId: forkId } = JSON.parse(forkBody) as { runId: string };

    const poll = await fetch(`${base}/runs/${encodeURIComponent(forkId)}/events/poll?timeout=1`, { headers: V2 });
    expect(poll.status).toBe(200);
    const events = (await poll.json() as { events?: Array<{ sequence?: number; timestamp?: string }> }).events ?? [];
    const inherited = events.filter((e) => typeof e.sequence === 'number' && e.sequence < 2);
    expect(inherited.length, 'the branch fork must copy the prefix below fromSeq').toBeGreaterThan(0);
    for (const ev of inherited) {
      expect(
        ev.timestamp,
        `inherited event at sequence ${ev.sequence} was re-stamped — a copy that re-stamps is not a copy`,
      ).toBe(TS(ev.sequence as number));
    }
  });
});
