/**
 * ADR 0554 P2 — the unwind driven through the REAL executor, plus the
 * `host-sample-test-seams.md` §21 seams the RFC 0151 behavioural witness calls.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `compensation-unwind.test.ts`. That file
 * drives the engine with injected deps, which is where the ordering, retry and
 * identity rules live — but it builds its own plan. A green engine over a
 * hand-built plan says nothing about whether the executor RECORDS obligations
 * when nodes commit, or whether `finalizeRun` runs the unwind at all. This file
 * closes that: every assertion below goes through `executeRun` and the same
 * terminal path a production failure takes.
 *
 * §21 states the requirement as a MUST for exactly this reason: the seams "MUST
 * NOT be a mock that returns a canned event list: the executor, plan
 * persistence, and ordering must be the ones the production failure path uses,
 * or the witness proves nothing."
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { _resetCompensationLedgerForTest } from '../src/host/compensationLedger.js';
import { __resetCompensationSeamForTest } from '../src/routes/compensationSeam.js';

let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  // A cross-tenant operator key, which is exactly what the conformance harness
  // carries. Without it every request lands on its own anonymous tenant, so the
  // seam's run and the follow-up `GET /v1/runs/{runId}` would be scoped to
  // DIFFERENT tenants and the read would 404 — a false red that says nothing
  // about compensation.
  process.env.OPENWOP_API_KEYS = 'seam-operator-key:*';
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      res();
    });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  delete process.env.OPENWOP_API_KEYS;
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  __resetCompensationSeamForTest();
  await _resetCompensationLedgerForTest();
});

interface UnwindBody {
  runId?: string;
  events?: { type: string; payload: Record<string, unknown> }[];
  compensatedOrder?: number[];
}

const AUTH = { authorization: 'Bearer seam-operator-key' } as const;

async function unwind(nodes?: number): Promise<UnwindBody> {
  const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(nodes === undefined ? {} : { nodes }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as UnwindBody;
}

describe('host-sample-test-seams.md §21 — the compensation unwind seam', () => {
  it('returns the runId it created, so the §D rollup has a black-box witness', async () => {
    const body = await unwind();
    // Without this the rollup leg has no path to a snapshot and lands as
    // another shape-only claim — which is the whole reason §21 requires it.
    expect(typeof body.runId).toBe('string');
    expect(body.runId?.length ?? 0).toBeGreaterThan(0);
  });

  it('drives the REAL executor: the run fails forward AND unwinds', async () => {
    const body = await unwind(3);
    const snap = await fetch(`${BASE}/v1/runs/${encodeURIComponent(body.runId!)}?tenantId=default`, { headers: AUTH });
    expect(snap.status).toBe(200);
    const run = (await snap.json()) as { status?: string };
    // RFC 0151 §D — the FORWARD status is untouched. There is deliberately no
    // `compensating` run status: a run that failed and unwound cleanly is
    // `status: failed` with a separate `compensationStatus: completed`, and
    // that is the SUCCESSFUL outcome, not a contradiction.
    expect(run.status).toBe('failed');
    expect(['running', 'pending', 'waiting-approval']).not.toContain(run.status);
  });

  it('compensation.requested strictly precedes compensation.started', async () => {
    const body = await unwind(2);
    const types = (body.events ?? []).map((e) => e.type);
    const requested = types.indexOf('compensation.requested');
    const started = types.indexOf('compensation.started');
    expect(requested).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(requested);
  });

  it('compensatedOrder is strictly DESCENDING, and is what the inverse nodes recorded', async () => {
    const body = await unwind(4);
    expect(body.compensatedOrder).toEqual([4, 3, 2, 1]);
    // Non-vacuity: the order comes from the fake inverse node's own recorder as
    // it executed, so a plan that was built descending but RUN forward would
    // show up here. A `compensatedOrder` echoed from the plan could not.
    expect(body.compensatedOrder).toHaveLength(4);
  });

  it('a clean unwind ends with compensation.completed and no failures', async () => {
    const body = await unwind(2);
    const types = (body.events ?? []).map((e) => e.type);
    expect(types).toContain('compensation.completed');
    expect(types).not.toContain('compensation.failed');
    expect(types).not.toContain('compensation.manual_intervention_required');
  });

  it('event payloads are content-free — no credentials, no provider bodies', async () => {
    const body = await unwind(2);
    for (const e of body.events ?? []) {
      const serialized = JSON.stringify(e).toLowerCase();
      for (const forbidden of ['-----begin', 'bearer ', 'sk-', 'authorization', 'providerresponse']) {
        expect(serialized.includes(forbidden), `found ${forbidden} in a durable compensation event`).toBe(false);
      }
      expect(e.payload['orderingModel']).toBe('reverse-completion');
    }
  });

  it('every emitted payload validates against the CORPUS run-event-payloads schema', async () => {
    // Not the vendored copy — the pinned `@openwop/openwop-conformance`
    // package, which is where the six `compensation.*` `$defs` actually landed
    // (openwop#1007). The repo's `schemas/` copy has none of them, so
    // validating against it would certify these events against a contract that
    // does not mention them: green, and meaningless.
    //
    // The `$defs` are `additionalProperties: false` with a CLOSED `reason`
    // enum, which makes this the assertion that would catch an open reason
    // string or a stray field leaking provider detail onto the durable log —
    // the §D/§G failure the content-free leg above only spot-checks by keyword.
    const { corpusSchema } = await import('./support/corpusSchema.js');
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const schema = corpusSchema('run-event-payloads.schema.json') as { $defs: Record<string, object> };
    const ajv = new Ajv2020({ strict: false, allErrors: true });

    const body = await unwind(3);
    const events = body.events ?? [];
    expect(events.length, 'nothing to validate means this leg proves nothing').toBeGreaterThan(0);
    for (const e of events) {
      // The schema's own documented convention: dotted type → camelCase `$defs`
      // key (`compensation.requested` → `compensationRequested`).
      const key = e.type.replace(/\.([a-z_])/g, (_m, c: string) => c.toUpperCase()).replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      const def = schema.$defs[key];
      expect(def, `no $defs entry for ${e.type} (looked up '${key}')`).toBeDefined();
      const validate = ajv.compile(def!);
      const ok = validate(e.payload);
      expect(ok, `${e.type} payload invalid: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  // H73 / §21 `fail?: boolean` (default true). The healthy-run leg exists so the
  // §D rollup can be asserted as `none` against a run that legitimately HAS
  // compensator declarations and simply never needed them — before this the
  // seam ignored `fail:false` and fired the trigger anyway, so the leg's
  // positive control recorded `blocked` instead of asserting anything.
  it('`fail: false` runs the SAME compensator-declaring workflow to completion', async () => {
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ nodes: 2, fail: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnwindBody;
    const run = await fetch(`${BASE}/v1/runs/${body.runId}`, { headers: AUTH });
    expect(((await run.json()) as { status?: string }).status).toBe('completed');
    // No unwind happened, so no compensation events and nothing compensated.
    expect(body.events ?? []).toEqual([]);
    expect(body.compensatedOrder ?? []).toEqual([]);
  });

  it('POSITIVE CONTROL: the default (fail omitted) still fails and unwinds', async () => {
    // Without this, `fail:false` could be satisfied by a seam that never fails
    // at all, and every ordering leg above would be asserting about nothing.
    const body = await unwind(2);
    expect(body.compensatedOrder).toEqual([2, 1]);
    expect((body.events ?? []).length).toBeGreaterThan(0);
  });

  it('rejects a non-boolean `fail` rather than coercing it', async () => {
    // `"false"` is truthy: a coercing seam would run the FAILING workflow and
    // the healthy leg would assert `none` about a run that unwound — a pass
    // for the wrong reason, which is worse than a refusal.
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ nodes: 2, fail: 'false' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a node count outside 1..8 rather than silently clamping', async () => {
    for (const nodes of [0, 9]) {
      const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ nodes }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe('host-sample-test-seams.md §21 — the replay seam (RFC 0151 §F)', () => {
  it('replaying a run that already unwound re-fires NOTHING', async () => {
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId?: string; refiredEffects?: number };
    expect(typeof body.runId).toBe('string');
    // §F: "a replay that re-executes inverse effects turns a recovery into a
    // second outage". Measured from the fake inverse node's own recorder under
    // the REPLAY's runId — an event count could not tell the two apart.
    expect(body.refiredEffects).toBe(0);
  });

  it('a replay mints NO obligations of its own — the first of §F\'s two fences', async () => {
    // TWO-FENCE WARNING, stated rather than left implicit. `refiredEffects: 0`
    // above is kept green by THREE independent mechanisms, so disabling any one
    // of them alone would leave it green and the leg would measure nothing:
    //   1. this one — a replay never records an obligation, so its tree is empty
    //      (`recordForwardObligation` returns early on `forkMode: 'replay'`);
    //   2. `unwindRun`'s own `replaying` guard, pinned SEPARATELY and with a
    //      non-empty plan in `compensation-unwind.test.ts` ADVERSARY 4;
    //   3. ADR 0531's `assertEffectAllowed`, which fails an inverse effect
    //      closed during a replay.
    // Each is asserted somewhere it is the ONLY fence standing.
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: '{}',
    });
    const body = (await res.json()) as { runId?: string };
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    expect(await obligationsForRunTree('default', body.runId!)).toHaveLength(0);
  });

  it('reports the SOURCE run\'s recorded plan as `replayed` — §F is "uses recorded outcomes", not "has none"', async () => {
    // THE DISTINCTION THIS LEG EXISTS FOR. A replay mints no obligations, so
    // reading the REPLAY's own tree finds an empty plan and reports nothing —
    // and "reported nothing because it correctly re-fired nothing" is
    // indistinguishable from "reported nothing because it had nothing" until
    // someone asks what it compensated. §F says a replay uses the RECORDED
    // outcomes of the run it reproduces, so the plan is read from the SOURCE.
    //
    // The deep-equality below is therefore NOT arranged by the seam: it holds
    // because the replay genuinely resolved the source's plan. If the host
    // regressed to reading the replay's own tree, `replayed` would come back
    // EMPTY and this fails — where a laxer assertion would compare two empty
    // arrays and pass.
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: '{}',
    });
    const body = (await res.json()) as {
      refiredEffects?: number;
      source?: Array<{ ordinal: number; effectId: string; input: unknown }>;
      replayed?: Array<{ ordinal: number; effectId: string; input: unknown }>;
    };
    const norm = (xs: typeof body.source) =>
      [...(xs ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    expect(body.source?.length, 'vacuity guard: the source run must have had a plan to compare').toBeGreaterThan(0);
    expect(body.replayed?.length, 'an empty `replayed` is the regression this leg is for').toBeGreaterThan(0);
    expect(norm(body.replayed)).toEqual(norm(body.source));
    expect(body.refiredEffects, 'same identities, same inputs, and NOTHING fired').toBe(0);
  });

  it('the §21 report carries the retry-stable identity the compensator actually presented', async () => {
    // §C's rule made observable: three attempts, ONE downstream key. The keys
    // are recorded by the fake downstream, not reported by the host, so a host
    // that presented a different key per attempt cannot hide it here.
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ nodes: 2, failFirstInverseAttempts: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      inverseActions?: Array<{ ordinal: number; attempts: number; outcome: string; downstreamKeys: string[]; effectId: string }>;
    };
    const first = (body.inverseActions ?? []).find((a) => a.ordinal === 2);
    expect(first, 'reverse-completion runs the highest forward ordinal first').toBeDefined();
    expect(first!.attempts, 'two transient failures then success is THREE attempts of ONE obligation').toBe(3);
    expect(first!.outcome).toBe('completed');
    expect(first!.downstreamKeys, 'one key per attempt').toHaveLength(3);
    expect(
      new Set(first!.downstreamKeys).size,
      'a second key at the downstream is a second obligation — two refunds',
    ).toBe(1);
    expect(first!.downstreamKeys[0]).toBe(first!.effectId);
    // ...and exactly one plan entry per forward ordinal: no duplicate obligations.
    const ordinals = (body.inverseActions ?? []).map((a) => a.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('`hold: true` leaves a HELD plan the snapshot reports as `manual`', async () => {
    const res = await fetch(`${BASE}/v1/host/sample/test/compensation/unwind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ nodes: 2, hold: true }),
    });
    const body = (await res.json()) as {
      runId?: string;
      events?: Array<{ type: string }>;
      inverseActions?: Array<{ outcome: string }>;
    };
    expect((body.events ?? []).some((e) => e.type === 'compensation.manual_intervention_required')).toBe(true);
    expect((body.inverseActions ?? []).some((a) => a.outcome === 'held')).toBe(true);
    const snap = await fetch(`${BASE}/v1/runs/${encodeURIComponent(body.runId!)}`, { headers: AUTH });
    expect((await snap.json() as { compensationStatus?: string }).compensationStatus).toBe('manual');
  });
});

/**
 * INVERTED 2026-08-16 (ADR 0554 wire flip). This block read "the behaviour
 * ships, the advert does not" and asserted BOTH halves of the §D pair were
 * absent. That was the correct claim while the wire half was unwritten, and the
 * two legs were deliberately written as a pair so neither could move alone.
 *
 * They still are a pair — the direction is what changed. The host advertises,
 * so what needs watching is that the advert never stands without the field and
 * the field never appears without the advert. The presence assertions replace
 * the absence assertions in the SAME positions, which is the whole reason the
 * legs were paired in the first place.
 */
describe('ADR 0554 wire flip — the behaviour ships AND the advert does, as a pair', () => {
  it('advertises capabilities.compensation, with the shape §A closes', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    const caps = (await res.json()) as { capabilities?: Record<string, unknown> };
    const comp = caps.capabilities?.['compensation'] as Record<string, unknown> | undefined;
    expect(comp, 'the advert is the claim — the seam being wired never was').toBeDefined();
    expect(comp!['supported']).toBe(true);
    // §A: an advertising host MUST implement `reverse-completion`, and this seam
    // suite is the witness that it does — the legs above drive the REAL executor
    // and read the order the inverse actions actually ran in.
    expect(comp!['orderingModels']).toEqual(['reverse-completion']);
    // The closed object, so a host-private key cannot ride along on the advert.
    expect(Object.keys(comp!).sort()).toEqual(
      ['manualIntervention', 'orderingModels', 'profileVersion', 'supported'],
    );
  });

  it('and carries compensationStatus on the run snapshot, which is the other half', async () => {
    // `compensation.md` §D: a host that does not advertise MUST omit the field,
    // one that advertises MUST carry it on EVERY snapshot. The unwind driven by
    // `unwind()` completes, so the fold is `completed` — and the run's forward
    // `status` stays `failed`, which §D calls the normal successful outcome of a
    // compensation and the reason the two fields are separate.
    const body = await unwind();
    const snap = await fetch(`${BASE}/v1/runs/${encodeURIComponent(body.runId!)}`, { headers: AUTH });
    const run = (await snap.json()) as Record<string, unknown>;
    expect(run['compensationStatus']).toBe('completed');
    expect(run['status'], 'RFC 0151 forbids reinterpreting the forward status').toBe('failed');
  });
});
