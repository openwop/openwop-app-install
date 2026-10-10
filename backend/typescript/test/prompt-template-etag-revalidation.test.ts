/**
 * `GET /prompts/{templateId}` revalidation (host-services.md §Library SHOULD;
 * RFC 9110 §13.1.2). The route compared `If-None-Match` with a bare `===`, so a
 * `W/`-weakened echo (a compressing front door weakens a strong tag) and any
 * list answered `200`: the production certification bundle recorded
 * `prompts.etag-revalidation` as `executed-fail` under suite 2.45.16. It now
 * uses the shared `ifNoneMatchSatisfied` (the discovery + run routes'), and the
 * `304` carries the validator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { issueApiKey } from '../src/features/developer-keys/apiKeyService.js';

let server: http.Server;
let BASE = '';
let TOKEN = '';
let PATH = '';
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ['OPENWOP_AUTH_DISABLE_COOKIES']) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'prompt-etag', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  TOKEN = (await issueApiKey({ tenantId: 'prompt-etag', name: 'etag', createdBy: 'user:etag', scopes: ['prompts:read'] })).token;
  const list = await get('/prompts');
  expect(list.status).toBe(200);
  const items = ((await list.json()) as { items?: Array<{ templateId: string }> }).items ?? [];
  expect(items.length, 'the host library lists at least one template').toBeGreaterThan(0);
  PATH = `/prompts/${encodeURIComponent(items[0]!.templateId)}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
}

describe('GET /prompts/{templateId} — If-None-Match revalidation', () => {
  it('answers 304, carrying the ETag, for the exact tag, a W/-weakened echo, a list and *', async () => {
    const first = await get(PATH);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    for (const candidate of [etag!, `W/${etag!}`, `"nope", ${etag!}`, '*']) {
      const again = await get(PATH, { 'if-none-match': candidate });
      expect(again.status, `If-None-Match: ${candidate}`).toBe(304);
      expect(again.headers.get('etag')).toBe(etag);
    }
  });

  it('a non-matching tag still answers 200 with the body', async () => {
    const res = await get(PATH, { 'if-none-match': '"0000000000000000"' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { templateId?: string }).templateId).toBeTruthy();
  });
});
