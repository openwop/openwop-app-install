/**
 * RFC 0055 §C demo producer — `local.openwop-app.image-emit`.
 *
 * Runs a workflow whose single node emits a `media.image` event, then
 * verifies the run's debug bundle carries that event referenced BY URL
 * (never inlined) and that the served URL resolves — closing the §C loop
 * (produce → store → serve → debug bundle) the rails were built for.
 *
 * Breaks if the node stops emitting `media.image`, inlines the binary in the
 * payload, emits a URL that is not the host serve path, or stores bytes other
 * than the ones it references (sabotage probes w5g2-emit-*). The run must reach
 * `completed` — a failed run that happened to emit would not satisfy this.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
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

interface MediaPayload { url?: string; bytes?: number; base64?: string; mimeType?: string; alt?: string }

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
interface BundleBody { events?: { type?: string; payload?: MediaPayload }[] }

describe('media-emit demo node (RFC 0055 §C producer)', () => {
  it('emits a media.image referenced by URL in the run debug bundle, and the URL resolves', async () => {
    // Register the image-emit node as a one-node workflow.
    const reg = await jsonFetch('/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: 'openwop-app.image',
        nodes: [{ nodeId: 'img', typeId: 'local.openwop-app.image-emit' }],
        edges: [],
      }),
    });
    expect([200, 201]).toContain(reg.status);

    const create = await jsonFetch<{ runId: string }>('/runs', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'openwop-app.image', inputs: {} }),
    });
    expect(create.status).toBe(201);
    const { runId } = create.body;

    // Wait on the real condition (a terminal run status), not a fixed sleep.
    const snap = await vi.waitFor(async () => {
      const s = await jsonFetch<{ status: string }>(`/runs/${runId}`);
      if (!['completed', 'failed', 'cancelled'].includes(s.body.status)) throw new Error(`run still ${s.body.status}`);
      return s;
    }, { timeout: 5000, interval: 25 });
    expect(snap.body.status).toBe('completed');

    const bundle = await jsonFetch<BundleBody>(`/runs/${runId}/debug-bundle`);
    expect(bundle.status).toBe(200);
    const mediaEvents = (bundle.body.events ?? []).filter((e) => typeof e.type === 'string' && e.type.startsWith('media.'));
    expect(mediaEvents.length, 'debug bundle MUST carry the emitted media.image event').toBeGreaterThanOrEqual(1);
    const ev = mediaEvents[0]!;
    // RFC 0055 §C rule 3: referenced by URL, never inlined.
    expect(typeof ev.payload?.url).toBe('string');
    expect(ev.payload?.base64, 'media.image MUST NOT inline the binary').toBeUndefined();
    expect(ev.payload?.url).toMatch(/^\/host\/openwop-app\/assets\//);
    expect(ev.payload).toMatchObject({ mimeType: 'image/png', alt: expect.any(String) });

    // The served URL resolves (public, token-authed).
    const served = await fetch(`${BASE}${ev.payload!.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    // …and serves exactly the bytes the event references (a PNG of the advertised size).
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes.length).toBe(ev.payload!.bytes);
    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });
});
