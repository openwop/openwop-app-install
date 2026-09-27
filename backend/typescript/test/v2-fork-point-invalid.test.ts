/**
 * `runs.md` §Fork — "A `fromSeq` not in the source log MUST be rejected with
 * `422 fork_point_invalid`."
 *
 * FOUND BY ADVERTISING. This host answered `422 openwop-app.fork_invalid_seq`,
 * and nothing local could see it: `fork_invalid_seq` was OUR code, correctly
 * namespaced by `v2ErrorCode` because it is not in the registry. A namespaced
 * vendor code is the honest treatment of a code a host invents — the defect was
 * inventing one where the protocol already had a name. It surfaced only when
 * `replay` was briefly advertised and `v2-run-fork-refusals` stopped skipping.
 *
 * The negative case deliberately stays `400`: the request schema pins `fromSeq`
 * to `minimum: 0`, so a negative violates the schema and is malformed input
 * rather than an unsatisfiable fork point. I changed it to 422 first and an
 * existing test caught me — the schema, not the prose, is what settles it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApp } from '../src/index.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** v2 speaks UNVERSIONED paths — sending `OpenWOP-Version: 2` at a `/v1/...`
 *  path is a `protocol_version_mismatch`, which the first draft of this file
 *  did and which is why its refusal codes never got exercised. */
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

async function makeRun(): Promise<string> {
  const res = await fetch(`${base}/runs`, {
    method: 'POST', headers: V2,
    body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { message: 'fork-code' } }),
  });
  const body = await res.json() as { runId?: string };
  return String(body.runId ?? '');
}

async function fork(runId: string, fromSeq: unknown, _major: '1' | '2'): Promise<{ status: number; code: string }> {
  const res = await fetch(`${base}/runs/${encodeURIComponent(runId)}:fork`, {
    method: 'POST', headers: V2,
    body: JSON.stringify({ mode: 'branch', fromSeq }),
  });
  const body = await res.json() as { error?: unknown; code?: unknown };
  const code = typeof body.error === 'string' ? body.error
    : typeof (body.error as { code?: unknown } | undefined)?.code === 'string' ? String((body.error as { code: string }).code)
    : String(body.code ?? '');
  return { status: res.status, code };
}

describe('fork point refusals (runs.md §Fork)', () => {
  it('a fromSeq past the end of the log is 422 fork_point_invalid, UNPREFIXED at v2', async () => {
    const runId = await makeRun();
    expect(runId, 'the run must exist or the fork legs assert nothing').not.toBe('');
    const res = await fork(runId, 999_999, '2');
    expect(res.status).toBe(422);
    expect(res.code, 'a registered protocol code MUST NOT travel under the host vendor prefix').toBe('fork_point_invalid');
    expect(res.code.startsWith('openwop-app.'), 'the old spelling was ours and namespaced').toBe(false);
  });

  it('a NEGATIVE fromSeq stays 400 — the request schema pins minimum: 0', async () => {
    const runId = await makeRun();
    const res = await fork(runId, -1, '2');
    // I first routed this to 422 as well, on the reasoning that a negative
    // "names no event in the log". An existing test pinning 400 reddened, and it
    // was right: `api/v2/openapi.yaml` constrains fromSeq to `minimum: 0`, so a
    // negative is a SCHEMA violation and never reaches the semantic question.
    expect(res.status, 'a schema violation is malformed input, not a fork-point verdict').toBe(400);
  });

  it('a NON-INTEGER fromSeq stays a 400 — malformed input is a different fault', async () => {
    const runId = await makeRun();
    const res = await fork(runId, 'not-a-number', '2');
    expect(res.status).toBe(400);
    expect(res.code, 'a malformed body is validation_error, not a fork-point verdict').toContain('validation_error');
  });
});
