/**
 * identity.md §5 / RFC 0184 §A.1 — A TENANT-BOUND ID TRAVELS AS ONE `~`-ESCAPED SEGMENT.
 *
 * This is the sibling of `v2-origin-decoded-bound-id.test.ts`, and the same
 * outage is behind both: on 2026-09-05 Firebase Hosting decoded `%2F` to `/`
 * before forwarding, the backend correctly had no route for a literal slash,
 * and every bound-id read, poll, cancel and stream was unreachable at
 * `app.openwop.dev` while the direct `run.app` URL answered 200. That file made
 * this host tolerate the DECODED spelling a proxy produces. RFC 0184 is the
 * corpus's answer to the same measurement: stop asking front doors to preserve
 * `%2F` at all, and escape with `~`, which RFC 3986 §2.3 makes UNRESERVED — an
 * intermediary has no license to rewrite it in either direction.
 *
 * So this host now understands THREE spellings of one id, and that is
 * deliberate rather than untidy: `~2F` (the projection, which a host MUST
 * accept and MUST emit), `%2F` (released behaviour — `identity.md` §5 keeps it,
 * and withdrawing it would be breaking), and the bare decoded `/` (what a
 * normalising proxy actually forwards). The first is the one we HAND OUT.
 *
 * Legs disjoint under sabotage — MEASURED, and the first draft of this comment
 * guessed two of the four sets wrong, which is the reason to run them:
 *   revert the EMIT side (projectBoundId → encodeURIComponent) → leg 5 alone;
 *   revert the ACCEPT side (always percent-decode)             → legs 1, 3, 6, 7;
 *   let a malformed `~` fall through instead of throwing       → leg 7 alone;
 *   make the codec idempotent (skip already-projected input)   → leg 4 alone.
 * Leg 4 is the one that most needed this: it asserts a 404, which a vacuous
 * test also gets for free, so without S-D it would have been indistinguishable
 * from a gate that cannot fail.
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
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text };
}
const V2 = { 'OpenWOP-Version': '2' };
async function createV2(): Promise<{ runId: string; body: any }> {
  const r = await req('POST', '/runs', V2, { workflowId: 'conformance-noop', inputs: {} });
  expect(r.status, r.text.slice(0, 160)).toBe(201);
  expect(String(r.json.runId)).toMatch(/^default\//);
  return { runId: r.json.runId as string, body: r.json };
}

describe('the bound-id path projection (RFC 0184)', () => {
  it('1. GET /runs/{projected} answers 200 with the SAME run', async () => {
    const { runId } = await createV2();
    const projected = projectBoundId(runId);
    // Assert the encoder before blaming the host, exactly as the corpus
    // scenario does: if the segment still had something to decode, a 404 would
    // be the intermediary's fault and not the host's.
    expect(encodeURIComponent(projected), 'the projection must be all-unreserved').toBe(projected);
    const r = await req('GET', `/runs/${projected}`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(200);
    expect(r.json.runId, 'a decoder that resolves to a DIFFERENT id is non-injective').toBe(runId);
  });

  it('2. the percent-encoded form STILL works — this RFC adds a spelling, it does not retire one', async () => {
    const { runId } = await createV2();
    const r = await req('GET', `/runs/${encodeURIComponent(runId)}`, V2);
    expect(r.status, r.text.slice(0, 160)).toBe(200);
    expect(r.json.runId).toBe(runId);
  });

  it('3. a colon operation rides the projected segment in BOTH spellings', async () => {
    // `:fork` lives INSIDE the id's path segment, so a client may project the
    // whole thing (`~3Afork`) or append the op literally after projecting only
    // the id. Both must land on the same run; the op is split off after decode.
    for (const make of [
      (id: string) => `${projectBoundId(id)}:fork`,
      (id: string) => projectBoundId(`${id}:fork`),
    ]) {
      const { runId } = await createV2();
      const r = await req('POST', `/runs/${make(runId)}`, V2, {});
      expect([200, 201, 400, 409], `spelling ${make(runId)} must reach the fork handler, not a 404/403`).toContain(r.status);
      expect(r.json?.error, 'the tenant guard must not misread the op suffix as part of the tenant').not.toBe('id_tenant_mismatch');
    }
  });

  it('4. a DOUBLE-projected segment MUST NOT resolve — the codec is not idempotent', async () => {
    const { runId } = await createV2();
    const twice = projectBoundId(projectBoundId(runId));
    const r = await req('GET', `/runs/${twice}`, V2);
    expect(r.status, `a host that projects twice strands its own links (${twice})`).toBe(404);
  });

  it('5. EMIT: the create response spells its links with the projection, never %2F', async () => {
    const { runId, body } = await createV2();
    const projected = projectBoundId(runId);
    for (const key of ['eventsUrl', 'statusUrl']) {
      const url = body[key];
      if (typeof url !== 'string') continue;
      expect(url.toLowerCase(), `${key} must not carry %2F — a front door may decode it and strand every follower`).not.toContain('%2f');
      expect(url, `${key} must carry the projected id ${projected}`).toContain(projected);
    }
  });

  it('6. a link this host emitted is readable at the URL it emitted', async () => {
    // The round trip is the property that actually matters: legs 1 and 5 can
    // both pass while the host emits one spelling and accepts another.
    const { body } = await createV2();
    const eventsUrl = String(body.eventsUrl ?? '');
    expect(eventsUrl, 'the create response must carry an eventsUrl to follow').not.toBe('');
    const path = eventsUrl.replace(/^https?:\/\/[^/]+/, '');
    const r = await req('GET', `${path}${path.includes('?') ? '&' : '?'}afterSequence=0`, V2);
    expect([200, 204], `following our own eventsUrl answered ${r.status}: ${r.text.slice(0, 160)}`).toContain(r.status);
  });

  it('7. a `~` not followed by two hex digits is 400 validation_error, not 404', async () => {
    // 404 would answer "no such run" about a request that never named one.
    const { runId } = await createV2();
    const tenant = runId.split('/')[0];
    for (const bad of [`${tenant}~2`, `${tenant}~`, `${tenant}~zz`]) {
      const r = await req('GET', `/runs/${bad}`, V2);
      expect(r.status, `${bad} must be refused 400: got ${r.text.slice(0, 120)}`).toBe(400);
      expect(r.json?.error).toBe('validation_error');
    }
  });

  it('8. MAJOR 1 IS UNTOUCHED — a `~` segment under v1 is not reinterpreted', async () => {
    // The projection is a major-2 rule. Narrowing v1 would be a new refusal on
    // a shipped contract, and `~` is legal in a v1 id.
    const r = await req('GET', '/v1/runs/some~2Fthing');
    expect(r.status, 'v1 must answer its own 404, not the v2 validation refusal').not.toBe(400);
  });
});
