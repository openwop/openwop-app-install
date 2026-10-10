/**
 * ADR 0818 — the asset serve route must never let stored bytes run as a page on
 * the app's origin.
 *
 * `GET /host/openwop-app/assets/:token` is auth-exempt and served from the SAME
 * origin as the SPA (Hosting rewrites `/host/**` to the backend), with cookie
 * auth. It reflected the stored `Content-Type` verbatim, with no `nosniff`, no
 * CSP and no `Content-Disposition`. The upload routes refuse `text/html` and
 * SVG, but they are not the only writers: the always-registered
 * `local.openwop-app.image-emit` node stores a caller-chosen `mimeType`, and the
 * AI image seams store whatever type the provider returned. Any of those is a
 * stored-XSS page a victim opens by following a link.
 *
 * So the guard belongs at the one place every byte leaves: the serve route.
 *
 * Reds if: the serve route stops calling `assetServeHeaders`; `nosniff`, the
 * sandbox CSP or the attachment disposition is dropped; `+xml`/`text/*`/case
 * handling regresses; a PDF gets a CSP; an inert download loses its type; or the
 * image-emit node mints a non-image type.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { assetServeHeaders } from '../src/host/assetServeHeaders.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

const HTML = Buffer.from('<!doctype html><script>fetch("/host/openwop-app/me")</script>').toString('base64');

/** Store bytes the way a non-upload writer does (any type), return the serve URL. */
async function stored(contentType: string, contentBase64: string): Promise<string> {
  return (await storeMediaAsset('default', { contentBase64, contentType })).url;
}

let emitSeq = 0;
/** Run a one-node image-emit workflow with caller-chosen bytes + type. */
async function emit(mimeType: string, contentBase64: string): Promise<{ status: string; mediaEvents: number }> {
  const workflowId = `adr0818.emit.${++emitSeq}`;
  const reg = await jsonFetch('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'img', typeId: 'local.openwop-app.image-emit' }], edges: [] }),
  });
  expect([200, 201]).toContain(reg.status);
  const create = await jsonFetch<{ runId: string }>('/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowId, inputs: { contentBase64, mimeType } }),
  });
  expect(create.status).toBe(201);
  // Run settle has no awaitable hook over HTTP — poll the real condition (the
  // honest ceiling for a run-settle wait), never a fixed sleep count.
  let status = 'running';
  await vi.waitFor(async () => {
    status = (await jsonFetch<{ status: string }>(`/runs/${create.body.runId}`)).body.status;
    expect(['completed', 'failed', 'cancelled']).toContain(status);
  }, { timeout: 10_000, interval: 25 });
  const bundle = await jsonFetch<{ events?: { type?: string }[] }>(`/runs/${create.body.runId}/debug-bundle`);
  return { status, mediaEvents: (bundle.body.events ?? []).filter((e) => e.type === 'media.image').length };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('ADR 0818 — asset serve hardening', () => {
  it('a stored text/html asset is not served as a page on the app origin', async () => {
    const res = await fetch(`${BASE}${await stored('text/html', HTML)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Script cannot run: the response is sandboxed, and it downloads instead of rendering.
    expect(res.headers.get('content-security-policy') ?? '').toMatch(/sandbox/);
    expect(res.headers.get('content-disposition') ?? '').toMatch(/^attachment/);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('SVG and JavaScript download, sandboxed (a same-origin <script src> must not load as script)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    for (const [type, b64] of [['image/svg+xml', svg], ['text/javascript', Buffer.from('alert(1)').toString('base64')], ['text/html; charset=utf-8', HTML], ['text/css', Buffer.from('*{}').toString('base64')], ['application/xhtml+xml', HTML]] as const) {
      const res = await fetch(`${BASE}${await stored(type, b64)}`);
      expect(res.headers.get('content-type'), type).toBe('application/octet-stream');
      expect(res.headers.get('content-security-policy') ?? '', type).toMatch(/sandbox/);
      expect(res.headers.get('content-disposition') ?? '', type).toMatch(/^attachment/);
    }
  });

  it('an inert image still renders inline, with nosniff + a sandbox CSP', async () => {
    const res = await fetch(`${BASE}${await stored('image/png', PNG)}`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy') ?? '').toMatch(/sandbox/);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('an inert office download keeps its type, as an attachment', async () => {
    const res = await fetch(`${BASE}${await stored('application/vnd.openxmlformats-officedocument.wordprocessingml.document', PNG)}`);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.headers.get('content-disposition') ?? '').toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy') ?? '').toMatch(/sandbox/);
  });

  it('a PDF renders inline with nosniff and no CSP (a restrictive policy can stop the built-in viewer)', async () => {
    const res = await fetch(`${BASE}${await stored('application/pdf', Buffer.from('%PDF-1.4').toString('base64'))}`);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('assetServeHeaders: case, parameters, +xml under an inert major, empty type', () => {
    const h = (t: string | undefined) => assetServeHeaders(t);
    expect(h('TEXT/HTML ; charset=utf-8')['Content-Type']).toBe('application/octet-stream');
    expect(h('audio/x-evil+xml')['Content-Type']).toBe('application/octet-stream');
    expect(h('audio/x-evil+xml')['Content-Disposition']).toBe('attachment');
    expect(h('video/mp4')['Content-Disposition']).toBeUndefined();
    expect(h('text/x-anything')['Content-Type']).toBe('application/octet-stream');
    expect(h(undefined)['Content-Type']).toBe('application/octet-stream');
    expect(h('')['Content-Disposition']).toBe('attachment');
    expect(h('application/epub+zip')['Content-Type']).toBe('application/epub+zip');
    for (const t of ['text/html', 'image/png', 'application/zip', '']) expect(h(t)['Content-Security-Policy'], t).toMatch(/sandbox/);
  });

  it('the image-emit node refuses a non-image type instead of minting one', async () => {
    const html = await emit('text/html', HTML);
    expect(html.status).toBe('failed');
    expect(html.mediaEvents).toBe(0);
    const png = await emit('image/png', PNG);
    expect(png.status).toBe('completed');
    expect(png.mediaEvents).toBe(1);
  });
});
