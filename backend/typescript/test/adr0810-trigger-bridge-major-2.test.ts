/**
 * ADR 0810 — the trigger bridge at MAJOR 2, driven the way the 2.45.11
 * `v2-trigger-*` legs drive it (openwop-7b's contract, 2026-10-03):
 *
 *   - `POST /trigger-subscriptions` answers a TENANT-BOUND `subscriptionId`
 *     (`<tenant>/<opaque>`) and a signed `ingestUrl`;
 *   - a badly signed post to that URL is `401 signature_invalid`;
 *   - `GET /trigger-subscriptions/{seg}/dead-letters`, with `{seg}` in the `~`
 *     projection AND the percent spelling (`identity.md` §5), answers a page that
 *     validates against the CLOSED v2 page schema — which is what proves every
 *     id in it went out bound;
 *   - another tenant's bound id is `404`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createApp } from '../src/index.js';
import { projectBoundId } from '../src/host/boundIdProjection.js';

const OP = 'k-op-0810-operator';
const TB = 'k-tb-0810-tenant-b';
let server: http.Server; let base = '';
const saved: Record<string, string | undefined> = {};

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(V2)) {
  if (!f.endsWith('.json')) continue;
  try { ajv.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Record<string, unknown>, f); } catch { /* duplicate $id */ }
}
function pageErrors(doc: unknown): string[] {
  const fn = ajv.getSchema('https://openwop.dev/spec/v2/trigger-dead-letter-page.schema.json');
  if (!fn) throw new Error('v2 trigger-dead-letter-page did not register — validation would be vacuous');
  return fn(doc) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

async function v2(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'OpenWOP-Version': '2', authorization: `Bearer ${opts.key ?? OP}` },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

beforeAll(async () => {
  for (const k of ['OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_TRIGGER_INBOUND_SIGNING']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_API_KEYS = `${OP}:*,${TB}:tenant-b`;
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  process.env.OPENWOP_TRIGGER_INBOUND_SIGNING = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0810 — triggerBridge at major 2', () => {
  it('a registered subscription, a refused post, and a dead-letter page with bound ids under both segment spellings', async () => {
    const reg = await v2('POST', '/trigger-subscriptions', { body: { source: 'webhook', workflowId: 'openwop-app.uppercase', verification: { mode: 'required' } } });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const bound = reg.body.subscription.subscriptionId as string;
    expect(bound, 'identity.md §5 — a tenant-bound id at major 2').toMatch(/^[^/]+\/[A-Za-z0-9._~-]{16,128}$/);
    const ingestUrl = reg.body.binding.ingestUrl as string;
    expect(typeof ingestUrl).toBe('string');

    const canary = `canary-${randomBytes(8).toString('hex')}`;
    const refused = await fetch(`${base}${ingestUrl}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': `msg_${randomBytes(12).toString('hex')}`, 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      body: JSON.stringify({ canary }),
    });
    expect(refused.status).toBe(401);

    for (const seg of [projectBoundId(bound), encodeURIComponent(bound)]) {
      const page = await v2('GET', `/trigger-subscriptions/${seg}/dead-letters`);
      expect(page.status, `${seg}: ${JSON.stringify(page.body)}`).toBe(200);
      expect(pageErrors(page.body), 'the CLOSED v2 page schema').toEqual([]);
      expect(page.body.deliveries).toHaveLength(1);
      const rec = page.body.deliveries[0];
      expect(rec.subscriptionId, 'bound like the path segment').toBe(bound);
      expect(rec.attempt.subscriptionId).toBe(bound);
      expect(rec.reason).toBe('verification_failed');
      expect(JSON.stringify(page.body)).not.toContain(canary);
    }

    const sub = await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}`);
    expect(sub.status).toBe(200);
    expect(sub.body.subscription.state, 'a refused post changed no state').toBe('active');

    // At major 2 a bound id NAMES its tenant, so identity.md §5 decides first: a
    // segment that is not the caller's tenant is `403 id_tenant_mismatch` (a v2
    // MUST, enforced in the identity middleware before any handler). RFC 0232
    // §B.2's "the same 404 as an unknown id" holds for the caller's OWN tenant
    // wrapped around another tenant's opaque id: it resolves under the caller
    // and finds nothing.
    const foreign = await v2('GET', `/trigger-subscriptions/${projectBoundId(bound)}/dead-letters`, { key: TB });
    expect(foreign.status, 'identity.md §5').toBe(403);
    expect(foreign.body.error).toBe('id_tenant_mismatch');
    const opaque = bound.slice(bound.indexOf('/') + 1);
    const rebound = await v2('GET', `/trigger-subscriptions/${projectBoundId(`tenant-b/${opaque}`)}/dead-letters`, { key: TB });
    const unknown = await v2('GET', `/trigger-subscriptions/${projectBoundId(`tenant-b/tgsub-${randomBytes(8).toString('hex')}`)}/dead-letters`, { key: TB });
    expect(rebound.status, 'another tenant\'s opaque id under the caller\'s own tenant').toBe(404);
    expect(unknown.status).toBe(404);
    expect(rebound.body.error).toBe(unknown.body.error);
    expect(JSON.stringify(rebound.body)).not.toContain('verification_failed');
    // The 2.45.11 leg's own "unknown" case: the caller's OWN bound id with an
    // opaque that was never minted (openwop #1872).
    const neverMinted = await v2('GET', `/trigger-subscriptions/${projectBoundId(`${bound}-never-minted`)}/dead-letters`);
    expect(neverMinted.status).toBe(404);
    expect(neverMinted.body.error).toBe('not_found');
    expect(JSON.stringify(foreign.body), 'a 403 carries no record either').not.toContain('verification_failed');
  });
});
