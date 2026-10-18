/**
 * ADR 0669 addendum — "`runs.ts` run links" was listed as still open before the
 * cut. MEASURED here instead of rewritten: every request is served under
 * major 2 (v1 retired; ADR 0812 removed it), and the major-2 wire owns the
 * spelling of every address `routes/runs.ts` builds:
 *
 * - `eventsUrl` / `statusUrl` on create and fork are `/runs/<bound id>`. They
 *   were minted `/v1/runs/<bare id>` and rewritten by `projectV2RunIds`
 *   (host/v2Ids.ts) until ADR 0812 P4 slice 2b, which mints them final in
 *   `runWireUrls`; the projector leg that served pre-slice ledger replays was
 *   deleted in ADR 0812 P4 slice 4;
 * - the snapshot's `interrupt.callbackUrl` (`/v1/interrupts/<token>`) never ships,
 *   because `closeV2Snapshot` keeps only the closed v2 snapshot's own properties.
 *
 * (CORRECTED 2026-10-15, ADR 0812 P4 slice 2b: the paragraph below described
 * the pre-slice shape. Both `/v1` literals are gone from `runs.ts`; the source
 * and the projector moved together, and the create/fork legs now also pin that
 * the URL's id IS the projected `runId`.)
 *
 * So the `/v1` literals in `runs.ts` reach the wire only in a pre-cut major-1
 * response, which is correct. Rewriting them at the source would BREAK the
 * projector, which finds the id by matching `/v1/runs/`. This test pins the
 * behaviour so a change to either seam is caught. Its pre-cut control (a
 * major-1 response DID carry `/v1/interrupts/`) went with major 1 in ADR 0812
 * P3c; the gated leg asserts the run is actually `waiting…`, so its "no `/v1`"
 * cannot pass because no gate opened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method, headers: AUTH, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
async function waitFor(statusPath: string, done: (status: string) => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = await call('GET', statusPath);
    if (done(String(s.json.status))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run at ${statusPath} did not reach the expected status`);
}
const terminal = (s: string) => ['completed', 'failed', 'cancelled'].includes(s);
const suspended = (s: string) => s.startsWith('waiting');

describe('ADR 0669 — run links survive the cut', () => {
  it('create, snapshot and fork hand out no /v1 address', async () => {
    {
      const created = await call('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
      expect(created.status).toBe(201);
      expect(created.text).not.toMatch(/\/v1\//);
      const statusPath = new URL(String(created.json.statusUrl)).pathname;
      expect(statusPath).toMatch(/^\/runs\//);
      expect(new URL(String(created.json.eventsUrl)).pathname).toBe(`${statusPath}/events`);
      // ADR 0812 P4 slice 2b — the URL is minted in its final form at the source
      // (`runWireUrls`), no longer rewritten by the projector, so pin that it names
      // the SAME id the projected `runId` does, in its RFC 0184 path-segment form.
      expect(statusPath).toBe(`/runs/${projectBoundId(String(created.json.runId))}`);

      await waitFor(statusPath, terminal);
      const snap = await call('GET', statusPath);
      expect(snap.status).toBe(200);
      expect(snap.text).not.toMatch(/\/v1\//);

      const fork = await call('POST', `${statusPath}:fork`, { fromSeq: 0, mode: 'replay' });
      expect(fork.status).toBe(201);
      expect(fork.text).not.toMatch(/\/v1\//);
      expect(new URL(String(fork.json.eventsUrl)).pathname).toMatch(/^\/runs\/.+\/events$/);
      expect(new URL(String(fork.json.eventsUrl)).pathname).toBe(`/runs/${projectBoundId(String(fork.json.runId))}/events`);

      // An open approval gate: the snapshot carries no `/v1/interrupts/` callback.
      const gated = await call('POST', '/runs', { workflowId: 'conformance-approval', inputs: {} });
      expect(gated.status).toBe(201);
      const gatedPath = new URL(String(gated.json.statusUrl)).pathname;
      await waitFor(gatedPath, suspended);
      const gatedSnap = await call('GET', gatedPath);
      expect(gatedSnap.status).toBe(200);
      expect(String(gatedSnap.json.status)).toMatch(/^waiting/);
      expect(gatedSnap.text).not.toMatch(/\/v1\//);
    }
  });
});
