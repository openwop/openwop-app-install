/**
 * RFC 0243 — the v2 `agents.fanOut` seat (ADR 0858 P4, suite 2.46.4).
 *
 * The host runs RFC 0118 parallel fan-out, so v2 discovery advertises
 * `agents.fanOut`, projected from `dispatchCapability()`. A `core.dispatch`
 * node pinning what the facet does not admit is refused:
 * - at load: `checkMappingCapability` names the seat in
 *   `details.requiredCapability`;
 * - at createRun, when such a workflow is nonetheless readable:
 *   `400 validation_error` naming the seat, and no run. The suite observes
 *   this half through the fixture `conformance-dispatch-fanout-race`, which is
 *   loaded without registration validation (`host/index.ts`).
 *
 * The advertised VALUES are pinned as literals as well as the projection: an
 * expectation read from `dispatchCapability()` alone would move with a sabotage
 * inside it. Note (grade-code row FANOUT-TWO-COPIES-1, outside this file's claim):
 * the load-time refusal (`workflowDefinitionValidation.ts` checkMappingCapability)
 * re-implements the join checks rather than calling `fanOutAdmissionRefusal`, so
 * the two refusals are two copies, each witnessed by its own describe below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import { dispatchCapability, fanOutAdmissionRefusal, v2FanOutFacet } from '../src/host/dispatchFanOut.js';
import { checkMappingCapability } from '../src/host/workflowDefinitionValidation.js';
import { OpenwopError } from '../src/types.js';
import { corpusSchema } from './support/corpusSchema.js';

const FIXTURE = 'conformance-dispatch-fanout-race';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };

let server: http.Server;
let BASE = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function discovery(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('fanOutAdmissionRefusal — the seat a dispatch config lacks', () => {
  const cap = dispatchCapability();
  it('admits non-parallel configs and the advertised parallel joins', () => {
    expect(fanOutAdmissionRefusal({}, cap)).toBeNull();
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'sequential' }, cap)).toBeNull();
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel' }, cap)).toBeNull();
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } }, cap)).toBeNull();
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'absorb' } }, cap)).toBeNull();
  });
  it('names agents.fanOut.joinModes for race, agents.fanOut.onChildFailureModes for fail-fast', () => {
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'race', onChildFailure: 'collect' } }, cap)?.seat).toBe('agents.fanOut.joinModes');
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'fail-fast' } }, cap)?.seat).toBe('agents.fanOut.onChildFailureModes');
  });
  it('names agents.fanOut when parallel is not among the policies', () => {
    expect(fanOutAdmissionRefusal({ fanOutPolicy: 'parallel' }, { ...cap, fanOutPolicies: ['sequential', 'reject'] })?.seat).toBe('agents.fanOut');
  });
});

describe('v2 discovery advertises agents.fanOut (RFC 0243)', () => {
  it('projects dispatchCapability() beside agents.dispatch: true, schema-valid', async () => {
    const agents = (await discovery())['agents'] as Record<string, unknown>;
    expect(agents['dispatch']).toBe(true);
    const cap = dispatchCapability();
    expect(agents['fanOut']).toEqual({
      joinModes: [...cap.joinModes],
      onChildFailureModes: [...cap.onChildFailureModes],
      maxFanOut: cap.maxFanOut,
      perItemInput: cap.perItemInput,
    });
    expect(agents['fanOut']).toEqual(v2FanOutFacet());
    // What THIS host advertises, as literals (HOST_MAX_FAN_OUT = 16; perItemInput is
    // on unless OPENWOP_DISPATCH_PER_ITEM_INPUT=false, which this file never sets).
    expect(agents['fanOut']).toEqual({ joinModes: ['wait-all'], onChildFailureModes: ['collect', 'absorb'], maxFanOut: 16, perItemInput: true });

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const caps = corpusSchema('v2/capabilities.schema.json') as { $id?: string };
    const dir = dirname(createRequire(`${process.cwd()}/`).resolve('@openwop/spec-artifacts/schemas/v2/capabilities.schema.json'));
    let added = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try { ajv.addSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>); added += 1; } catch { /* a malformed sibling is its own test's problem */ }
    }
    // A broken corpus path must not let the $ref compile against nothing.
    expect(added, 'no v2 schema sibling was loaded').toBeGreaterThanOrEqual(1);
    const validate = ajv.compile({ $ref: `${caps.$id ?? ''}#/properties/agents` });
    expect(validate(agents), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('the refusal at load names the seat', () => {
  function refusalDetails(config: Record<string, unknown>): Record<string, unknown> | undefined {
    try {
      checkMappingCapability([{ nodeId: 'dispatch', typeId: 'core.dispatch', config }]);
    } catch (err) {
      if (!(err instanceof OpenwopError)) throw err;
      return err.details;
    }
    return undefined;
  }
  it('race → agents.fanOut.joinModes; fail-fast → agents.fanOut.onChildFailureModes', () => {
    expect(refusalDetails({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'race', onChildFailure: 'collect' } })?.['requiredCapability']).toBe('agents.fanOut.joinModes');
    expect(refusalDetails({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'fail-fast' } })?.['requiredCapability']).toBe('agents.fanOut.onChildFailureModes');
    expect(refusalDetails({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } })).toBeUndefined();
  });
});

describe('createRun refuses a readable unadmitted fan-out (the suite-observable half)', () => {
  it('the race fixture is advertised and readable', async () => {
    expect((await discovery())['fixtures']).toContain(FIXTURE);
    const res = await fetch(`${BASE}/workflows/${FIXTURE}`, { headers: H });
    expect(res.status).toBe(200);
  });

  it('POST /runs answers 400 validation_error with requiredCapability agents.fanOut.joinModes, and creates no run', async () => {
    const listed = async (): Promise<number> => {
      const r = await fetch(`${BASE}/runs?workflowId=${FIXTURE}`, { headers: H });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { runs?: Array<{ workflowId?: string }> };
      return (body.runs ?? []).filter((x) => x.workflowId === FIXTURE).length;
    };
    const before = await listed();
    const res = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: FIXTURE }) });
    const body = (await res.json()) as { error?: unknown; details?: Record<string, unknown>; runId?: string };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toBe('validation_error');
    expect(body.details?.['requiredCapability']).toBe('agents.fanOut.joinModes');
    expect(body.runId).toBeUndefined();
    expect(await listed()).toBe(before);
  });
});
