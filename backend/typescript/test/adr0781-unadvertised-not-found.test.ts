/**
 * ADR 0781 — errors.md § "Unadvertised operations" (RFC 0228, suite 2.44.6):
 * under major 2 an operation gated on a family or facet this host does not
 * advertise answers `404 not_found` in the closed v2 envelope. Major 1 keeps
 * its prior refusal.
 *
 * Pinned per gate, on BOTH majors, and against discovery: the family is absent
 * from v2 discovery exactly when its operations 404. Covered gates:
 * `prompts` (endpointsSupported, facet mutableLibrary), `content` (host i18n),
 * `triggerBridge` (facet ingestion).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApp } from '../src/index.js';
import { protocolVersionMiddleware } from '../src/middleware/protocolVersion.js';
import { registerPromptRoutes } from '../src/routes/prompts.js';

const V2 = { 'OpenWOP-Version': '2' };
const TOKEN = 'dev-token';

/** The closed v2 envelope the scenario checks: `error` + non-empty `message`, optional object `details`, nothing else. */
function expectV2NotFound(res: { status: number; body: Record<string, unknown> }, family: string): void {
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('not_found');
  expect(typeof res.body.message === 'string' && (res.body.message as string).length > 0).toBe(true);
  expect(Object.keys(res.body).every((k) => ['error', 'message', 'details'].includes(k))).toBe(true);
  expect((res.body.details as Record<string, unknown> | undefined)?.family).toBe(family);
}

async function call(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

describe('ADR 0781 — content + triggerBridge through the real app', () => {
  let server: http.Server; let base = '';
  const saved = { locales: process.env.OPENWOP_I18N_LOCALES, ingest: process.env.OPENWOP_TRIGGER_INGESTION_ENABLED };
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    delete process.env.OPENWOP_I18N_LOCALES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    if (saved.locales === undefined) delete process.env.OPENWOP_I18N_LOCALES; else process.env.OPENWOP_I18N_LOCALES = saved.locales;
    if (saved.ingest === undefined) delete process.env.OPENWOP_TRIGGER_INGESTION_ENABLED; else process.env.OPENWOP_TRIGGER_INGESTION_ENABLED = saved.ingest;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('content, i18n off: v2 discovery omits `content` and every content operation is 404 not_found', async () => {
    delete process.env.OPENWOP_I18N_LOCALES;
    const disco = await call(base, 'GET', '/.well-known/openwop', V2);
    expect(disco.body.content, 'content must not be advertised with i18n off').toBeUndefined();
    expectV2NotFound(await call(base, 'GET', '/content/settings', V2), 'content');
    expectV2NotFound(await call(base, 'GET', '/content/pages', V2), 'content');
    expectV2NotFound(await call(base, 'GET', '/content/pages/home', V2), 'content');
    expectV2NotFound(await call(base, 'POST', '/content/pages', V2, { slug: 'x' }), 'content');
  });

  // ADR 0812 P3c-0: "content, i18n off: major 1 is unchanged" was deleted with
  // major 1 (it read `/v1/content/settings`, the retired path space).

  it('content, i18n on: advertised, and the v2 operation is not refused as unadvertised', async () => {
    process.env.OPENWOP_I18N_LOCALES = 'en,es';
    const disco = await call(base, 'GET', '/.well-known/openwop', V2);
    expect(disco.body.content).toBeDefined();
    const res = await call(base, 'GET', '/content/settings', V2);
    expect(res.status === 404 && res.body.error === 'not_found', JSON.stringify(res.body)).toBe(false);
  });

  it('triggerBridge ingestion off: v2 404 not_found', async () => {
    process.env.OPENWOP_TRIGGER_INGESTION_ENABLED = 'false';
    const disco = await call(base, 'GET', '/.well-known/openwop', V2);
    expect(JSON.stringify(disco.body)).not.toContain('externalSources');
    expectV2NotFound(await call(base, 'POST', '/trigger-subscriptions', V2, { workflowId: 'w', source: 'webhook' }), 'triggerBridge');
    // ADR 0812 P3c-0: the "v1 keeps 501 host_capability_missing" half went with major 1.
  });
});

async function promptsApp(capability: { endpointsSupported: boolean; mutableLibrary: boolean }): Promise<{ server: http.Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use(protocolVersionMiddleware());
  registerPromptRoutes(app, { capability });
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('ADR 0781 — prompts gates (capability flags are a constant in the real app, so injected here)', () => {
  const apps: http.Server[] = [];
  afterAll(async () => { await Promise.all(apps.map((s) => new Promise<void>((r) => s.close(() => r())))); });

  it('endpointsSupported off: v2 GET /prompts is 404 not_found', async () => {
    const { server, base } = await promptsApp({ endpointsSupported: false, mutableLibrary: false }); apps.push(server);
    expectV2NotFound(await call(base, 'GET', '/prompts', V2), 'prompts');
    // ADR 0812 P3c-0: the "v1 keeps 501 capability_not_provided" half went with major 1.
  });

  it('mutableLibrary facet off: v2 POST /prompts is 404 not_found naming the facet', async () => {
    const { server, base } = await promptsApp({ endpointsSupported: true, mutableLibrary: false }); apps.push(server);
    const v2 = await call(base, 'POST', '/prompts', V2, { templateId: 't', version: '1', kind: 'system', text: 'x' });
    expectV2NotFound(v2, 'prompts');
    expect((v2.body.details as Record<string, unknown>).facet).toBe('mutableLibrary');
    // ADR 0812 P3c-0: the "v1 keeps 501" half went with major 1.
  });
});
