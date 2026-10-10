/**
 * ADR 0807 — `GET /runs/{runId}/compensation`, the v2 compensation read
 * projection. `v2-compensation-read-projection` (suite) failed its MUST while
 * `compensation` sat on `major2Ledger.ts`; this pins the host side of both of
 * that scenario's legs, plus what the scenario cannot see: the projection of a
 * run that actually owes something, and the major-1 refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { projectCompensation } from '../src/host/compensationProjection.js';
import { recordObligation, resolveObligation, type CompensationObligation } from '../src/host/compensationLedger.js';

const schemasDir = locateRepoSchemasDir(process.cwd(), 'ai-envelope.schema.json');
const v2 = (name: string): object => JSON.parse(readFileSync(join(schemasDir, 'v2', name), 'utf8')) as object;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(v2('ids.schema.json'));
ajv.addSchema(v2('compensation-policy.schema.json'));
const validate = ajv.compile(v2('compensation-projection.schema.json'));

let server: http.Server; let base = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = V2): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}
async function terminal(runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const s = await call(`/runs/${encodeURIComponent(runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(String(s.json.status))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not settle');
}

describe('ADR 0807 — the route (the suite scenario\'s two legs)', () => {
  it('a fresh noop run projects status none, no attempts, and validates', async () => {
    const created = await call('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    expect(created.status).toBe(201);
    const runId = String(created.json.runId);
    await terminal(runId);
    const res = await call(`/runs/${encodeURIComponent(runId)}/compensation`);
    expect(res.status).toBe(200);
    expect(validate(res.json), JSON.stringify(validate.errors)).toBe(true);
    expect(res.json).toMatchObject({ runId, status: 'none', attempts: [] });
  });

  it('an unknown tenant-bound run is 404 not_found in the flat envelope', async () => {
    const probe = await call('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    const tenant = String(probe.json.runId).split('/')[0];
    const res = await call(`/runs/${encodeURIComponent(`${tenant}/conformance-no-such-run-0807`)}/compensation`);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('not_found');
  });

  it('a run that owes something is projected from ITS ledger rows, through the route', async () => {
    const created = await call('/runs', { method: 'POST', body: JSON.stringify({ workflowId: 'conformance-noop', inputs: {} }) });
    const bound = String(created.json.runId);
    await terminal(bound);
    // The host's own spelling of the run and its tenant. ADR 0812 P3c-0 — this
    // was read off the v1 snapshot; the caller (`dev-token`) acts in `default`,
    // whose wire spelling is the storage one, so the bound id carries both.
    const [tenantId, v1Id] = [bound.slice(0, bound.indexOf('/')), bound.slice(bound.indexOf('/') + 1)];
    expect(tenantId).toBe('default');
    const row = await recordObligation({
      tenantId, runId: v1Id, forwardLogicalInvocationId: 'fwd-1', compensationOrdinal: 1, effectKind: 'email',
      shape: 'irreversible', resultDigest: 'r', contractDigest: 'c', nodeId: 'send-receipt',
    });
    await resolveObligation({ tenantId, inverseActionId: row.inverseActionId, to: 'started', reason: 'unwind began' });
    await resolveObligation({ tenantId, inverseActionId: row.inverseActionId, to: 'failed', attempts: 2, reason: 'cannot unsend' });
    const res = await call(`/runs/${encodeURIComponent(bound)}/compensation`);
    expect(res.status).toBe(200);
    expect(validate(res.json), JSON.stringify(validate.errors)).toBe(true);
    expect(res.json.plan).toEqual([{ nodeId: 'send-receipt', order: 0, irreversibleEffect: true }]);
    expect(res.json.attempts).toMatchObject([{ nodeId: 'send-receipt', attempt: 2, outcome: 'failed', reason: 'cannot unsend' }]);
    expect(res.json.status).not.toBe('none');
  });

  // ADR 0812 P3c-0: "under major 1 the operation does not exist" was deleted with
  // major 1 — `/v1/runs` is the retired path space.

  it('the v2 discovery document declares compensation with the v1 owner\'s facets and no `supported`', async () => {
    const doc = (await call('/.well-known/openwop')).json;
    const rec = doc.compensation as Record<string, unknown> | undefined;
    // `witness` is the declaration's (stamped at assembly): `seam-gated` for
    // compensation, not the `witnessable-gated` this record was first typed with.
    expect(rec).toMatchObject({ status: 'experimental', witness: 'seam-gated', orderingModels: ['reverse-completion'] });
    expect(rec).not.toHaveProperty('supported');
  });
});

function row(over: Partial<CompensationObligation>): CompensationObligation {
  return {
    inverseActionId: `ia-${Math.random()}`, tenantId: 't', runId: 'r', forwardLogicalInvocationId: 'f', compensationOrdinal: 0,
    profileVersion: '1', effectKind: 'email', shape: 'forward-effect', resultDigest: 'd', contractDigest: 'c', requiredScopes: [],
    state: 'requested', attempts: 0, committedAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
    ...over,
  } as CompensationObligation;
}

describe('ADR 0807 — the projection of a run that owes something', () => {
  const BOUND = 'tenant-a/0123456789abcdef0123';

  it('plan is the ledger order; an irreversible effect is flagged; resolved rows are attempts', () => {
    const p = projectCompensation(BOUND, [
      row({ nodeId: 'refund', state: 'completed', attempts: 2, updatedAt: '2026-10-03T01:00:00.000Z', planRequestedAt: '2026-10-03T00:30:00.000Z' }),
      row({ nodeId: 'email', shape: 'irreversible', state: 'failed', attempts: 3, reason: 'retries exhausted', updatedAt: '2026-10-03T01:01:00.000Z' }),
      row({ nodeId: 'notify', state: 'started', attempts: 1 }),
    ]);
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
    // The rollup is the ledger's own fold, not re-derived here: one row is still
    // `started`, so the unwind is `running`.
    expect(p.status).toBe('running');
    expect(p.plan).toEqual([
      { nodeId: 'refund', order: 0 },
      { nodeId: 'email', order: 1, irreversibleEffect: true },
      { nodeId: 'notify', order: 2 },
    ]);
    expect(p.attempts).toEqual([
      { nodeId: 'refund', attempt: 2, outcome: 'succeeded', at: '2026-10-03T01:00:00.000Z' },
      { nodeId: 'email', attempt: 3, outcome: 'failed', at: '2026-10-03T01:01:00.000Z', reason: 'retries exhausted' },
    ]);
  });

  it('the ledger\'s `manual` rollup is spelled `manual-intervention` here, and validates', () => {
    const p = projectCompensation(BOUND, [row({ nodeId: 'wire', state: 'manual_intervention_required', attempts: 1 })]);
    expect(p.status).toBe('manual-intervention');
    expect(p.attempts[0]?.outcome).toBe('manual');
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });

  it('a row with no nodeId (pre-ADR-0554-P2) is omitted, never given an invented id', () => {
    const p = projectCompensation(BOUND, [row({ state: 'completed', attempts: 1 }), row({ nodeId: 'kept', state: 'completed', attempts: 1 })]);
    expect(p.plan).toEqual([{ nodeId: 'kept', order: 0 }]);
    expect(p.attempts.map((a) => a.nodeId)).toEqual(['kept']);
    expect(validate(p), JSON.stringify(validate.errors)).toBe(true);
  });
});
