/**
 * W-2 / RFC 0091 — the `callai-multimodal` behavioral contract over HTTP. Boots
 * the real app via createApp and exercises POST /v1/host/openwop-app/ai/call:
 *   - a `string` content stays valid (back-compat)
 *   - an advertised modality ContentPart (image / document) is accepted
 *   - an UNADVERTISED modality (audio) is rejected with `unsupported_modality`
 *     BEFORE dispatch (never silently dropped)
 * Mirrors the openwop `callai-multimodal.test.ts` seam contract (steward-authored)
 * so the reference host passes it non-vacuously under OPENWOP_REQUIRE_BEHAVIOR.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let BASE: string;
const H = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
let URL: string;

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; URL = `${BASE}/v1/host/openwop-app/ai/call`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const post = (body: unknown) => fetch(URL, { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('RFC 0091 — callai-multimodal seam', () => {
  it('advertises aiProviders.input.modalities including image + document + audio', async () => {
    const doc = await (await fetch(`${BASE}/.well-known/openwop`, { headers: H })).json() as {
      aiProviders?: { input?: { modalities?: string[] } };
    };
    const mods = doc.aiProviders?.input?.modalities ?? [];
    expect(mods).toContain('image');
    expect(mods).toContain('document');
    // ADR 0085 Phase 1 — audio is now advertised (and accepted, in lockstep).
    expect(mods).toContain('audio');
  });

  it('accepts a plain string content (back-compat)', async () => {
    const res = await post({ messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect((await res.json() as { accepted?: boolean }).accepted).toBe(true);
  });

  it('accepts an advertised image ContentPart', async () => {
    const res = await post({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'describe this' },
      { type: 'image', mimeType: 'image/png', dataBase64: 'aGVsbG8=' },
    ] }] });
    expect(res.status).toBe(200);
    const body = await res.json() as { accepted?: boolean; modalities?: string[] };
    expect(body.accepted).toBe(true);
    expect(body.modalities).toContain('image');
  });

  it('accepts an advertised document (file) ContentPart', async () => {
    const res = await post({ messages: [{ role: 'user', content: [
      { type: 'file', mimeType: 'application/pdf', dataBase64: 'JVBERi0=' },
    ] }] });
    expect(res.status).toBe(200);
    expect((await res.json() as { modalities?: string[] }).modalities).toContain('document');
  });

  it('accepts an advertised audio ContentPart (ADR 0085 Phase 1)', async () => {
    const res = await post({ messages: [{ role: 'user', content: [
      { type: 'text', text: 'transcribe this' },
      { type: 'audio', mimeType: 'audio/wav', dataBase64: 'UklGRg==' },
    ] }] });
    expect(res.status).toBe(200);
    expect((await res.json() as { modalities?: string[] }).modalities).toContain('audio');
  });

  it('rejects an UNADVERTISED modality (video) with unsupported_modality', async () => {
    const res = await post({ messages: [{ role: 'user', content: [
      { type: 'video', mimeType: 'video/mp4', dataBase64: 'AAAA' },
    ] }] });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: { code?: string } };
    expect(body.error?.code).toBe('unsupported_modality');
  });

  it('400s on a missing/empty messages array', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ messages: [] })).status).toBe(400);
  });
});
