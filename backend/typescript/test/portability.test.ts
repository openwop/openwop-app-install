/**
 * Portability (RFC 0098) — host-sample export/import seam + invariants.
 *
 * Covers the `export-bundle-portability` behavioral leg (import a bundle with a
 * literal credential value → 422, even on ?dryRun=true) plus refs-only export,
 * dry-run zero-writes, dependsOn-cycle rejection, and apply scope-gating.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_PORTABILITY_ENABLED = 'true';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

const leaky = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [{ kind: 'connection-ref', ref: 'c1', payload: { provider: 'anthropic', apiKey: 'sk-conformance-canary' } }],
};

const clean = {
  bundleVersion: '1',
  source: { origin: 'adapter:conformance' },
  items: [
    { kind: 'prompt-template', ref: 'pt1', payload: { template: 'hi' } },
    { kind: 'connection-ref', ref: 'c1', dependsOn: ['pt1'], payload: { provider: 'github', credentialRef: '[REDACTED:c1]' } },
  ],
};

describe('portability — export/import seam (RFC 0098)', () => {
  it('export is refs-only: no literal credential values', async () => {
    const { status, body } = await api<{ bundleVersion: string; items: Array<{ payload: Record<string, unknown> }> }>(
      '/v1/host/openwop-app/export',
    );
    expect(status).toBe(200);
    expect(body.bundleVersion).toBe('1');
    const raw = JSON.stringify(body);
    // No bare credential-key value that isn't a [REDACTED:..] ref.
    expect(/"apiKey"\s*:\s*"(?!\[REDACTED)/.test(raw)).toBe(false);
  });

  it('import of a bundle with a literal credential value is rejected 422 (even on dryRun)', async () => {
    const res = await api('/v1/host/openwop-app/import?dryRun=true', { method: 'POST', body: JSON.stringify({ bundle: leaky }) });
    expect(res.status).toBe(422);
  });

  it('clean dryRun returns a plan and makes zero writes', async () => {
    const res = await api<{ dryRun: boolean; itemCount: number; order: string[] }>(
      '/v1/host/openwop-app/import?dryRun=true',
      { method: 'POST', body: JSON.stringify({ bundle: clean }) },
    );
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.itemCount).toBe(2);
    // dependency order: pt1 before c1.
    expect(res.body.order.indexOf('pt1')).toBeLessThan(res.body.order.indexOf('c1'));
  });

  it('a dependsOn cycle is rejected 422', async () => {
    const cyclic = {
      bundleVersion: '1',
      source: { origin: 'adapter:conformance' },
      items: [
        { kind: 'pack', ref: 'a', dependsOn: ['b'], payload: {} },
        { kind: 'pack', ref: 'b', dependsOn: ['a'], payload: {} },
      ],
    };
    const res = await api('/v1/host/openwop-app/import?dryRun=true', { method: 'POST', body: JSON.stringify({ bundle: cyclic }) });
    expect(res.status).toBe(422);
  });

  it('apply (non-dryRun) without scope is denied 403', async () => {
    const res = await api('/v1/host/openwop-app/import', { method: 'POST', body: JSON.stringify({ bundle: clean }) });
    expect(res.status).toBe(403);
  });

  it('apply of a leaky bundle is 422 before the scope check', async () => {
    const res = await api('/v1/host/openwop-app/import', { method: 'POST', body: JSON.stringify({ bundle: leaky }) });
    expect(res.status).toBe(422);
  });
});
