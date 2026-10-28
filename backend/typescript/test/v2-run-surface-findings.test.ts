/**
 * runs.md — FOUR RUN-SURFACE FINDINGS from the corpus steward's rc.48 witnesses
 * (crosstalk `4f74`, 2026-09-05 06:53Z, measured on the direct service URL):
 *
 *  1. A colon-suffixed operation on a BOUND id (`/runs/<t>%2F<o>:diff`) answered
 *     `403 id_tenant_mismatch` — the path guard captured `<o>:diff` as the
 *     opaque segment and the 16–128 grammar refused the `:`. (CORRECTED in
 *     wave 63: this header used to say `:pause`/`:resume` had no route and
 *     answered 404. ADR 0632 routes `:pause`; a terminal run answers
 *     `409 run_terminal`, which is what case 2 asserts.) A FOREIGN tenant
 *     segment is still refused `403 id_tenant_mismatch` (`v2Identity.ts:215`).
 *  2. Bulk-cancel over the cap answered `400 validation_error` WITHOUT
 *     `details.maxRunIds` (§Cancel: MUST carry it).
 *  3. `tags` limits were not enforced (101 → 201; MUST be 400) and `tags` /
 *     `metadata` were not surfaced on the snapshot (MUST surface unchanged).
 *  4. Cancel on a terminal run answered `200 { status: completed }` — outside
 *     §Cancel's 200 grammar; the conforming refusal is `409 run_terminal`.
 *
 * Legs are per finding and disjoint: each fix touches one mechanism.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
const V2 = { 'OpenWOP-Version': '2' };
/** The fields these legs read off a response body (no `any`). */
interface Body {
  runId?: string; status?: string; error?: string; message?: string;
  details?: { status?: string; runStatus?: string; maxRunIds?: number };
  tags?: unknown; metadata?: Record<string, unknown>; divergedAtSeq?: number | null; eventDiffs?: unknown[];
}
async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: Body; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json: Body = {}; try { json = JSON.parse(text) as Body; } catch { json = {}; }
  return { status: res.status, json, text };
}
async function createDone(extra: Record<string, unknown> = {}, headers: Record<string, string> = V2): Promise<string> {
  const r = await req('POST', '/runs', headers, { workflowId: 'conformance-noop', inputs: {}, ...extra });
  expect(r.status, r.text.slice(0, 200)).toBe(201);
  const id = r.json.runId!;
  for (let i = 0; i < 50; i++) { const s = await req('GET', `/runs/${encodeURIComponent(id)}`, headers); if (['completed', 'failed'].includes(s.json.status ?? '')) break; await new Promise((r) => setTimeout(r, 20)); }
  return id;
}

describe('1. colon-suffixed operations reach their route with a bound id', () => {
  it(':diff on a bound id reaches its route — not a tenant refusal', async () => {
    const a = await createDone(); const b = await createDone();
    // The PATH id is the bound one under test. `?against=` is passed as the bare opaque
    // half: the route looks the query up raw, so a BOUND `against` 404s — a separate
    // defect pinned as it.fails in v2-event-sequence-zero-based (DIFF-AGAINST-BOUND-1).
    const bOpaque = b.slice(b.lastIndexOf('/') + 1);
    const r = await req('GET', `/runs/${encodeURIComponent(a)}:diff?against=${encodeURIComponent(bOpaque)}`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(200);
    // The route itself answered: a structured diff body, not an error envelope.
    expect(r.json.error).toBeUndefined();
    expect(Array.isArray(r.json.eventDiffs), r.text.slice(0, 160)).toBe(true);
    expect(r.json).toHaveProperty('divergedAtSeq');
  });
  it(':pause on a bound id reaches its route (ADR 0632): a terminal run answers 409 run_terminal, never a false 403', async () => {
    const a = await createDone();
    const r = await req('POST', `/runs/${encodeURIComponent(a)}:pause`, V2, {});
    expect(r.status, r.text.slice(0, 160)).toBe(409);
    expect(r.json?.error).toBe('run_terminal');
    expect(r.json?.details?.status ?? r.json?.details?.runStatus).toBe('completed');
  });
  it('a FOREIGN tenant segment with a suffix is still refused', async () => {
    const a = await createDone(); const opaque = a.split('/')[1];
    const r = await req('GET', `/runs/${encodeURIComponent(`other-tenant/${opaque}`)}:diff?against=x`, V2);
    // Exactly the identity refusal: a 404 would be some OTHER guard (round-1 probe
    // 8fw4g1-rs-foreign stayed green when this accepted [403, 404]).
    expect(r.status, r.text.slice(0, 160)).toBe(403);
    expect(r.json.error).toBe('id_tenant_mismatch');
  });
});

describe('2. bulk-cancel over the cap names the cap', () => {
  it('101 ids → 400 validation_error with details.maxRunIds', async () => {
    const r = await req('POST', '/runs:bulk-cancel', V2, { runIds: Array.from({ length: 101 }, (_, i) => `default/00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) });
    expect(r.status).toBe(400);
    expect(r.json?.error).toBe('validation_error');
    expect(r.json?.details?.maxRunIds).toBe(100);
  });
});

describe('3. tags / metadata: limits enforced, both surfaced unchanged', () => {
  it('101 tags → 400 validation_error', async () => {
    const r = await req('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {}, tags: Array.from({ length: 101 }, (_, i) => `t${i}`) });
    expect(r.status, r.text.slice(0, 160)).toBe(400);
    expect(r.json?.error).toBe('validation_error');
  });
  it('a 257-char tag → 400 validation_error', async () => {
    const r = await req('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {}, tags: ['x'.repeat(257)] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('validation_error');
    expect(r.json.message).toContain('1–256 characters (got 257)');
  });
  it('valid tags + metadata surface unchanged on the snapshot (major 2)', async () => {
    const tags = ['alpha', 'odd format!/with slashes', '  spaced  ']; const metadata = { owner: 'qa', n: 3, nested: { k: [1, 2] } };
    const id = await createDone({ tags, metadata });
    const s = await req('GET', `/runs/${encodeURIComponent(id)}`, V2);
    expect(s.json.tags).toEqual(tags);
    expect(s.json.metadata).toEqual(metadata);
  });
  // ADR 0812 P3c-0 — the 1.x snapshot leg was deleted with major 1 (the major-2 leg above carries the same assertion).
  it('the snapshot metadata never leaks the host bag (engineVersion lives on its own axis)', async () => {
    const id = await createDone({ metadata: { a: 1 } });
    const s = await req('GET', `/runs/${encodeURIComponent(id)}`, V2);
    expect(Object.keys(s.json.metadata ?? {})).toEqual(['a']);
  });
});

describe('4. cancel on a terminal run', () => {
  it('major 2: 409 run_terminal', async () => {
    const id = await createDone();
    const r = await req('POST', `/runs/${encodeURIComponent(id)}/cancel`, V2, {});
    expect(r.status, r.text.slice(0, 120)).toBe(409);
    expect(r.json?.error).toBe('run_terminal');
  });
  // ADR 0812 P3c-0 — the 1.x idempotent-200 cancel leg was deleted with major 1.
});
