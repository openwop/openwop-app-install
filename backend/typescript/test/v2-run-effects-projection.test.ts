/**
 * RFC 0173 §C.2 — `GET /runs/{runId}/effects`.
 *
 * The projection is over the Layer-2 INVOCATION LOG, not the escape ledger, and
 * that choice is the substance. Only invocation-log rows carry `attempt`, which
 * the schema requires; and a projection over escapes alone would read EMPTY for
 * a correctly-suppressed effect, so `v2-effect-seam-no-refire` would pass while
 * witnessing nothing — a green leg certifying the obligation it cannot see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';

let server: Server; let base = ''; let dbPath = ''; let storage: Awaited<ReturnType<typeof openStorage>>;
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };
const V2 = { ...AUTH, 'OpenWOP-Version': '2' };

beforeAll(async () => {
  // A FILE-backed sqlite DSN, not `memory://`, and the reason is the whole
  // reliability of this file: `memory://` opens a SEPARATE `:memory:` database
  // per `openStorage` call, so rows planted from the test are invisible to the
  // app. The first draft did exactly that — the projection legs iterated an
  // EMPTY `effects[]` and passed while asserting nothing. Sabotaging the route
  // (leak the provider result; randomise the effectId) left them green, which is
  // how the vacuity surfaced.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  dbPath = join(mkdtempSync(join(tmpdir(), 'owp-effects-')), 'app.db');
  const dsn = `sqlite://${dbPath}`;
  process.env.OPENWOP_STORAGE_DSN = dsn;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: dsn, serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = await openStorage(dsn);
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function makeRun(): Promise<string> {
  const res = await fetch(`${base}/runs`, {
    method: 'POST', headers: V2,
    body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { message: 'effects' } }),
  });
  return String(((await res.json()) as { runId?: string }).runId ?? '');
}

describe('run effects projection (RFC 0173 §C.2)', () => {
  it('answers 200 with a schema-valid body — the shape `idempotency` promises', async () => {
    const wireId = await makeRun();
    expect(wireId, 'no run means the legs below assert nothing').not.toBe('');
    const res = await fetch(`${base}/runs/${encodeURIComponent(wireId)}/effects`, { headers: V2 });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    const { readdirSync } = await import('node:fs');
    const root = join(process.cwd(), '..', '..', 'schemas', 'v2');
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    for (const f of readdirSync(root).filter((x) => x.endsWith('.schema.json') && x !== 'effect-ledger-projection.schema.json')) {
      try { ajv.addSchema(JSON.parse(readFileSync(join(root, f), 'utf8'))); } catch { /* duplicate $id */ }
    }
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'effect-ledger-projection.schema.json'), 'utf8')) as object);
    expect(validate(body), `violates the projection schema: ${JSON.stringify(validate.errors ?? []).slice(0, 600)}`).toBe(true);
    // Non-vacuity: the validator must reject something, or a mis-compiled
    // schema would report every body clean.
    expect(validate({ runId: 'x', effects: [{ nodeId: 'n' }] })).toBe(false);
  });

  it('is content-free of provider payloads — identity and timing only', async () => {
    const wireId = await makeRun();
    const rawId = wireId.split('/').pop() ?? '';
    // Plant a real attempt WITH a provider result, so "content-free" is a claim
    // about a populated projection rather than an empty array.
    await storage.putInvocation({ runId: rawId, nodeId: 'n1', attempt: 1, invocationId: 'inv-1' }, { secret: 'PROVIDER-PAYLOAD' });
    const body = await (await fetch(`${base}/runs/${encodeURIComponent(wireId)}/effects`, { headers: V2 })).json() as { effects: Array<Record<string, unknown>> };
    expect(body.effects.length, 'a vacuous loop over [] is how this leg first passed a sabotaged route').toBeGreaterThan(0);
    expect(JSON.stringify(body), 'the recorded provider result must not appear anywhere in the response').not.toContain('PROVIDER-PAYLOAD');
    for (const e of body.effects) {
      expect(Object.keys(e).sort(), 'a recorded provider `result` must never reach this projection').toEqual(
        ['at', 'attempt', 'effectId', 'invocationId', 'keying', 'nodeId', 'state'],
      );
    }
  });

  it('never answers an empty projection for a run the caller cannot read', async () => {
    // The IDOR shape this guards: an empty `effects` array for someone else's
    // run is still a cross-tenant existence oracle. Two distinct refusals, and
    // the distinction is the point.
    //
    // A FOREIGN-TENANT id is `403 id_tenant_mismatch` — `identity.md` §5
    // requires it, and it is decided from the ID ALONE, so it reveals nothing
    // about whether that run exists. (I first asserted 404 here and was wrong:
    // the check runs before any lookup.)
    const foreign = await fetch(`${base}/runs/${encodeURIComponent('other-tenant/aaaaaaaaaaaaaaaaaaaa')}/effects`, { headers: V2 });
    expect(foreign.status).toBe(403);

    // A SAME-TENANT id that names no run is 404 — this is where an oracle would
    // actually live, and it must not answer 200 with an empty list.
    const mine = await makeRun();
    const tenant = mine.split('/')[0] ?? '';
    const ghost = await fetch(`${base}/runs/${encodeURIComponent(`${tenant}/zzzzzzzzzzzzzzzzzzzzzz`)}/effects`, { headers: V2 });
    expect(ghost.status, 'an empty 200 would confirm nothing exists — but a 200 for ANY unreadable run is the leak').not.toBe(200);
    expect(ghost.status).toBe(404);
  });

  it('effectId is DETERMINISTIC across reads and tenant-bound', async () => {
    const wireId = await makeRun();
    const rawId = wireId.split('/').pop() ?? '';
    await storage.putInvocation({ runId: rawId, nodeId: 'n2', attempt: 2, invocationId: 'inv-2' }, { ok: true });
    const read = async (): Promise<Array<{ effectId: string; attempt: number }>> =>
      ((await (await fetch(`${base}/runs/${encodeURIComponent(wireId)}/effects`, { headers: V2 })).json()) as { effects: Array<{ effectId: string; attempt: number }> }).effects;

    const first = await read();
    const second = await read();
    expect(first.length, 'no rows means the comparison below is vacuous').toBeGreaterThan(0);
    // A projection re-read must NAME THE SAME EFFECT. A per-request id would
    // look fine in one response and be useless to a consumer correlating two.
    expect(second.map((e) => e.effectId)).toEqual(first.map((e) => e.effectId));
    const tenant = wireId.split('/')[0] ?? '';
    for (const e of first) expect(e.effectId.startsWith(`${tenant}/`), 'effectId is tenant-bound').toBe(true);
    expect(first.some((e) => e.attempt === 2), 'the planted attempt must be projected').toBe(true);
  });

  it('two ATTEMPTS of one logical effect share an effectId — the retry counter is not in the identity', async () => {
    // `idempotency.md` §Layer 2: the effect is "identified once and stable across
    // every transport or provider retry", and "the retry counter MUST NOT
    // participate in the identity". This projection once hashed `attempt` into
    // `effectId`, so a retried effect reported as TWO effects — a violation of
    // the exact rule the projection exists to witness.
    //
    // Same (nodeId, invocationId), different attempt: ONE effect, two rows.
    const wireId = await makeRun();
    const rawId = wireId.split('/').pop() ?? '';
    await storage.putInvocation({ runId: rawId, nodeId: 'retried', attempt: 1, invocationId: 'inv-same' }, { ok: true });
    await storage.putInvocation({ runId: rawId, nodeId: 'retried', attempt: 2, invocationId: 'inv-same' }, { ok: true });

    const body = await (await fetch(`${base}/runs/${encodeURIComponent(wireId)}/effects`, { headers: V2 })).json() as { effects: Array<{ effectId: string; nodeId: string; attempt: number }> };
    const rows = body.effects.filter((e) => e.nodeId === 'retried');
    expect(rows.length, 'both attempt rows must be projected — the ledger records attempts').toBe(2);
    expect(
      new Set(rows.map((e) => e.effectId)).size,
      'the two attempts are ONE effect, so they must share one effectId; distinct ids mean `attempt` is back in the preimage',
    ).toBe(1);
    expect(new Set(rows.map((e) => e.attempt)), 'the attempt is carried by its own field').toEqual(new Set([1, 2]));
  });
});
