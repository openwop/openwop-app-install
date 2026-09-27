/**
 * CDP-1d — RFC 0128 purpose-propagation conformance seam route (the steward's CDP-1b legs).
 * `POST /v1/host/sample/purpose-propagation/forward`: forward re-emits (never-widen), merge
 * intersects, `[]` is refused onward (dropped), unlabelled adds no constraint; flag-off ⇒ 404.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true'; // reference-host witness flag ON
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

const FWD = '/v1/host/sample/purpose-propagation/forward';
async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${FWD}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}
const labelsOf = (onward: any[], surface: string) => onward.find((o) => o.surface === surface)?.permittedPurposes;

describe('CDP-1d purpose-propagation seam (RFC 0128 CDP-1b legs)', () => {
  it('leg 1+2 — forward re-emits the grant on both surfaces; never widens', async () => {
    const r = await post({ mode: 'forward', records: [{ id: 'r1', permittedPurposes: ['analytics', 'marketing-email'] }] });
    expect(r.status).toBe(200);
    expect(labelsOf(r.body.onward, 'a2a')).toEqual(['analytics', 'marketing-email']);
    expect(labelsOf(r.body.onward, 'trigger')).toEqual(['analytics', 'marketing-email']);
    // ⊆ the input grant (never-widen): every onward purpose was in the input
    for (const o of r.body.onward) for (const p of o.permittedPurposes) expect(['analytics', 'marketing-email']).toContain(p);
    expect(r.body.dropped).toEqual([]);
  });

  it('leg 3 — merge yields the intersection of contributing labels', async () => {
    const r = await post({ mode: 'merge', records: [
      { id: 'a', permittedPurposes: ['analytics', 'marketing-email'] },
      { id: 'b', permittedPurposes: ['analytics'] },
    ] });
    expect(r.status).toBe(200);
    expect(labelsOf(r.body.onward, 'a2a')).toEqual(['analytics']); // ⊆ both inputs
    expect(r.body.dropped).toEqual([]);
  });

  it('leg 4 — merge with an unlabelled input: unlabelled adds no constraint', async () => {
    const r = await post({ mode: 'merge', records: [
      { id: 'a', permittedPurposes: ['analytics', 'marketing-email'] },
      { id: 'b' }, // unlabelled = top element
    ] });
    expect(labelsOf(r.body.onward, 'trigger')).toEqual(['analytics', 'marketing-email']);
  });

  it('leg 5 — a []-record is dropped (no onward); the unlabelled twin IS forwarded', async () => {
    const r = await post({ mode: 'forward', records: [
      { id: 'blocked', permittedPurposes: [] },  // no onward use → dropped
      { id: 'twin' },                            // unlabelled → forwarded (positive control)
    ] });
    expect(r.body.dropped).toEqual(['blocked']);
    // non-arrival of `blocked` is evidence: it appears on NO onward surface
    expect(r.body.onward.some((o: any) => o.recordId === 'blocked')).toBe(false);
    expect(r.body.onward.some((o: any) => o.recordId === 'twin')).toBe(true);
  });

  it('merge with a [] input is contagious — the derived output is refused', async () => {
    const r = await post({ mode: 'merge', records: [{ id: 'a', permittedPurposes: ['analytics'] }, { id: 'b', permittedPurposes: [] }] });
    expect(r.body.onward).toEqual([]);
    expect(r.body.dropped).toEqual(['a', 'b']);
  });

  it('guardrail — with the flag OFF the seam 404s (pre-impl soft-skip)', async () => {
    delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
    const r = await post({ mode: 'forward', records: [{ id: 'x', permittedPurposes: ['analytics'] }] });
    process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true';
    expect(r.status).toBe(404);
  });
});
