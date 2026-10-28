/**
 * identity.md §5 × the front door — A BOUND ID SURVIVES A PROXY THAT DECODES `%2F`.
 *
 * MEASURED 2026-09-05 04:55Z (corpus steward, `1d29`): a run created through
 * `app.openwop.dev` under major 2 answered `runId: conformance-verify/32eb…`;
 * reading it back THROUGH THE ORIGIN — `GET /runs/conformance-verify%2F32eb…`
 * — answered `404 No route matches`, while the same request on the direct
 * `run.app` URL answered 200. Firebase Hosting decodes `%2F` to `/` before
 * forwarding, so the backend saw `/runs/conformance-verify/32eb…`, a path it
 * correctly had no route for. Every bound-id read, poll, cancel and stream was
 * unreachable at the front door. Intermediaries normalise `%2F` more often
 * than they preserve it, so the backend accepts the decoded spelling: under
 * major 2, `/runs/<tenant>/<opaque>` where `<opaque>` matches the 16–128
 * grammar is the encoded id — no sub-resource under `/runs/{id}` is longer
 * than 12 characters (`debug-bundle`), so the second segment cannot be one.
 * The tenant check is unchanged: it still runs in the path guard.
 *
 * Legs disjoint under sabotage: drop the alias → 1, 2 red; alias without the
 * grammar floor → 4, 9 red (`/runs/<bare>/events` would be mangled); alias that
 * skips the tenant check → 3, 8 red. (Leg 5, major 1, was deleted with major 1.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
// ADR 0812 P3c-0 — a bare id on a major-2 path is refused `400 validation_error`
// (the 1.x overlap that admitted it is retired; `preferredVersion()` is the
// constant '2.0'). It is read as a BARE id, never misparsed as
// `<tenant>/<opaque>` (which would answer 403 id_tenant_mismatch).
function expectReadAsBare(r: { status: number; json: Body | undefined; text: string }): void {
  expect(r.status, r.text.slice(0, 120)).toBe(400);
  expect(r.json?.error).toBe('validation_error');
  expect(r.json?.message).toContain('the bare form is not admitted');
}

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Body { runId?: string; webhookId?: string; events?: unknown[]; error?: string; message?: string }
async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: Body | undefined; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json: Body | undefined; try { json = JSON.parse(text) as Body; } catch { json = undefined; }
  return { status: res.status, json, text };
}
const V2 = { 'OpenWOP-Version': '2' };
async function createV2(): Promise<string> {
  const r = await req('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {} });
  expect(r.status, r.text.slice(0, 160)).toBe(201);
  expect(String(r.json?.runId)).toMatch(/^default\//);
  return String(r.json?.runId); // `default/<opaque>` — the bound id the client holds
}

describe('a decoded bound id (what a %2F-normalising proxy forwards) reaches the run', () => {
  it('1. GET /runs/<tenant>/<opaque> answers the same snapshot as the encoded form', async () => {
    const bound = await createV2();
    const enc = await req('GET', `/runs/${encodeURIComponent(bound)}`, V2);
    const dec = await req('GET', `/runs/${bound}`, V2);
    expect(enc.status).toBe(200);
    expect(dec.status, dec.text.slice(0, 120)).toBe(200);
    expect(dec.json?.runId).toBe(bound);
    expect(dec.json?.runId).toBe(enc.json?.runId);
  });
  it('2. …and so does a sub-resource: /runs/<tenant>/<opaque>/events/poll', async () => {
    const bound = await createV2();
    const r = await req('GET', `/runs/${bound}/events/poll?afterSequence=0`, V2);
    expect(r.status, r.text.slice(0, 120)).toBe(200);
    expect(Array.isArray(r.json?.events)).toBe(true);
  });
  it('3. a foreign tenant segment in the decoded form is still refused (no existence oracle)', async () => {
    const bound = await createV2();
    const opaque = bound.split('/')[1];
    const r = await req('GET', `/runs/other-tenant/${opaque}`, V2);
    // The path guard's own refusal (v2Identity): it names the rule, never the run.
    expect(r.status, r.text.slice(0, 160)).toBe(403);
    expect(r.json?.error).toBe('id_tenant_mismatch');
  });
  it('4. a bare id followed by a short sub-resource is not misread as bound: /runs/<bare>/events/poll', async () => {
    const bound = await createV2();
    const opaque = bound.split('/')[1];
    const r = await req('GET', `/runs/${opaque}/events/poll?afterSequence=0`, V2);
    expectReadAsBare(r);
  });
  // ADR 0812 P3c-0 — leg 5 (major 1 leaves /v1/runs/<tenant>/<opaque> a 404) was deleted with major 1.
});

// ── The other two bound-id kinds (MEASURED on production 2026-09-21) ──────────
// `DELETE /webhooks/<tenant>%2F<uuid>` through app.openwop.dev answered 404 while
// the same request on the direct run.app URL answered 204: the re-encode above
// was written for `/runs/` only, although ADR 0723 had already taught the path
// guard all three kinds. Each post-deploy cut leaked its subscriptions.
describe('a decoded bound WEBHOOK id reaches the subscription (the %2F proxy, other kinds)', () => {
  async function createWebhookV2(): Promise<string> {
    const r = await req('POST', '/webhooks', V2, { url: 'https://example.com/hook', events: ['run.completed'] });
    expect(r.status, r.text.slice(0, 160)).toBe(201);
    expect(String(r.json?.webhookId)).toMatch(/^default\//);
    return String(r.json?.webhookId);
  }
  it('6. DELETE /webhooks/<tenant>/<opaque> — the spelling a %2F-decoding proxy forwards — answers 204', async () => {
    const bound = await createWebhookV2();
    const r = await req('DELETE', `/webhooks/${bound}`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(204);
    // …and it is really gone: a second delete of the same id is a 404.
    expect((await req('DELETE', `/webhooks/${bound}`, V2)).status).toBe(404);
  });
  it('7. …and its sub-resource: POST /webhooks/<tenant>/<opaque>/test is accepted', async () => {
    const bound = await createWebhookV2();
    const r = await req('POST', `/webhooks/${bound}/test`, V2, {});
    expect(r.status, r.text.slice(0, 160)).toBe(202);
  });
  it('8. a foreign tenant segment on a decoded webhook id is still refused', async () => {
    const bound = await createWebhookV2();
    const opaque = bound.split('/')[1];
    const r = await req('DELETE', `/webhooks/other-tenant/${opaque}`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(403);
    expect(r.json?.error).toBe('id_tenant_mismatch');
    // the subscription survived the refused delete
    expect((await req('DELETE', `/webhooks/${encodeURIComponent(bound)}`, V2)).status).toBe(204);
  });
  it('9. a bare webhook id with its short sub-resource is not misread as bound: /webhooks/<bare>/test', async () => {
    const bound = await createWebhookV2();
    const opaque = bound.split('/')[1];
    const r = await req('POST', `/webhooks/${opaque}/test`, V2, {});
    expectReadAsBare(r);
  });
});
