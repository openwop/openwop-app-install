/**
 * WHD-14 — `callbackUrl` on run creation is REFUSED at both majors.
 *
 * The defect: `POST /runs` copied `body.callbackUrl` onto the RunRecord, both
 * storage adapters persisted it, and nothing read it back to deliver anything.
 * A caller asking for a callback got `201` and silence. The corpus defines the
 * member (`api/openapi.yaml`, `api/v2/openapi.yaml`, `spec/v2/core/runs.md:40`)
 * but no delivery contract, no RFC 2119 keyword and no capability flag, so the
 * honest behaviour is to say no rather than to say yes and do nothing.
 *
 * Every refusal leg has a CONTROL beside it: the identical body without the
 * member must answer 201. Without the control a 400 proves nothing — this route
 * has a dozen other ways to answer 400 (unknown workflow, bad inputs, a closed
 * v2 root key) and any of them would satisfy a bare status assertion. The
 * message + `details.field` assertions pin WHICH refusal fired, for the same
 * reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { createApp } from '../src/index.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

interface Reply { status: number; json: Record<string, unknown>; text: string }

/** One major = one (path, headers) pair. v2 is the unprefixed path + the version header. */
const MAJORS = [
  { major: 1, path: '/v1/runs', headers: AUTH },
  { major: 2, path: '/runs', headers: { ...AUTH, 'OpenWOP-Version': '2' } },
] as const;

async function send(method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* a non-JSON body fails the assertions below on its own */ }
  return { status: res.status, json, text };
}

async function runCount(m: (typeof MAJORS)[number]): Promise<number> {
  const r = await send('GET', `${m.path}?limit=100`, m.headers);
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  const runs = r.json['runs'];
  expect(Array.isArray(runs), 'the run list is how this test proves no run was created').toBe(true);
  return (runs as unknown[]).length;
}

const BODY = { workflowId: 'conformance-noop', inputs: {} };

describe.each(MAJORS)('WHD-14 — callbackUrl on run creation (major $major)', (m) => {
  it('CONTROL: the same body WITHOUT callbackUrl is accepted', async () => {
    const r = await send('POST', m.path, m.headers, BODY);
    expect(r.status, r.text.slice(0, 200)).toBe(201);
    expect(typeof r.json['runId']).toBe('string');
  });

  it('a callbackUrl is refused with validation_error naming the field — never a 201', async () => {
    const before = await runCount(m);
    const r = await send('POST', m.path, m.headers, { ...BODY, callbackUrl: 'https://receiver.example/hook' });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    // The FLAT envelope on both majors: `error` is the code string.
    expect(r.json['error']).toBe('validation_error');
    expect(r.json['runId'], 'a refusal that also minted a run is the old lie with a new status').toBeUndefined();
    const details = r.json['details'] as Record<string, unknown> | undefined;
    expect(details?.['field']).toBe('callbackUrl');
    expect(details?.['reason']).toBe('callback_delivery_not_supported');
    // The message must tell the caller what to use instead, not just "no".
    expect(String(r.json['message'])).toMatch(/does not deliver run callbacks/);
    expect(String(r.json['message'])).toMatch(/webhook subscription/);
    expect(await runCount(m), 'the refusal created a run').toBe(before);
  });

  it('a schema-invalid callbackUrl (null) is refused by the same arm, not silently dropped', async () => {
    const r = await send('POST', m.path, m.headers, { ...BODY, callbackUrl: null });
    expect(r.status, r.text.slice(0, 200)).toBe(400);
    expect((r.json['details'] as Record<string, unknown> | undefined)?.['field']).toBe('callbackUrl');
  });

  it('the refusal does not strand an Idempotency-Key: the corrected retry is accepted', async () => {
    // The guard sits BEFORE the idempotency claim, so a refused request never
    // touches the ledger. What this pins is the caller-visible consequence: fixing
    // the body and retrying under the SAME key works. (A guard placed after the
    // claim would have to rely on the handler's `finally` release to get here;
    // this leg does not care which mechanism holds, only that the retry is a 201
    // and not a `409 idempotency_key_mismatch` for a request that created nothing.)
    // 24 random bytes → 32 base64url chars: major 2 refuses a key under 22 chars
    // / 128 bits with `idempotency_key_invalid` BEFORE this handler runs, which
    // would make the 400 below pass for a reason unrelated to the guard. (It did,
    // on this test's first run — hence the `field` assertion on the refusal.)
    const key = randomBytes(24).toString('base64url');
    const headers = { ...m.headers, 'Idempotency-Key': key };
    const refused = await send('POST', m.path, headers, { ...BODY, callbackUrl: 'https://receiver.example/hook' });
    expect(refused.status).toBe(400);
    expect((refused.json['details'] as Record<string, unknown> | undefined)?.['field'], refused.text.slice(0, 200)).toBe('callbackUrl');
    const retried = await send('POST', m.path, headers, BODY);
    expect(retried.status, retried.text.slice(0, 200)).toBe(201);
  });
});
