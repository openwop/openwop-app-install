/**
 * CC-CHAIN-5 — a run whose inputs give a chain-bound parameter a DIFFERENT value
 * is refused at run creation, never run against the bound record.
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 03:35–03:37Z):
 * the Messaging-kernel copy instantiated for brief KT
 * (`params.briefId` = KT, so `generate_kernel` and `promote` declare
 * `inputs.briefId = KT`) was run from the builder with run inputs
 * `{ briefId: MH }`. Run 28eb5e4a recorded `inputs.briefId = MH`, but declared
 * node inputs win over run inputs (ADR 0237, `buildNodeCtxInputs`), so generate
 * read KT and, on approval, promote wrote a new kernel onto the KT brief. The
 * builder's Default-inputs panel and run dialog invite exactly this, and the
 * approval gate does not name the target brief.
 *
 * Pins: `POST /runs` refuses (400 `validation_error`, reason
 * `bound_param_conflict`, naming the parameter and both values)
 * when a run input names a value other than the one a node declared from the
 * chain's params; controls — the SAME value runs, and no such input runs.
 *
 * Sabotage witness: remove the `boundParamConflicts` check from `routes/runs.ts`
 * ⇒ "a different briefId is refused" goes red (201).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail } from './planningHarness.js';
import { boundParamConflicts } from '../src/host/chainParamBinding.js';

let BASE = '';
let close: () => Promise<void>;
const H = '/host/openwop-app';
const CHAIN = 'campaign-studio.messaging-kernel';

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  for (const id of ['users', 'campaign-brief', 'campaign-orchestration']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

async function boundCopy() {
  const tenantId = `org:cc5-${Date.now()}`;
  const owner = makeClient(() => BASE);
  expect((await owner.post(`${H}/test/login`, { email: uniqEmail('cc5'), tenantId })).status).toBe(201);
  const inst = await owner.post(`${H}/workflows/from-chain`, { chainId: CHAIN, params: { briefId: 'brief-KT' } });
  expect(inst.status, JSON.stringify(inst.body)).toBe(201);
  const workflowId = (inst.body.workflowId ?? inst.body.workflow?.workflowId ?? inst.body.id) as string;
  expect(typeof workflowId).toBe('string');
  return { owner, workflowId };
}
const run = (c: ReturnType<typeof makeClient>, workflowId: string, inputs: Record<string, unknown>) =>
  c.post('/runs', { workflowId, inputs, metadata: { launch: 'draft' } });

describe('CC-CHAIN-5 — run inputs vs a chain-bound parameter', () => {
  it('a different briefId is refused at run creation, naming the parameter and both values', async () => {
    const { owner, workflowId } = await boundCopy();
    const r = await run(owner, workflowId, { briefId: 'brief-MH' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.details, JSON.stringify(r.body)).toMatchObject({ reason: 'bound_param_conflict', param: 'briefId', bound: 'brief-KT', given: 'brief-MH' });
  });

  it('control: the same briefId, or none, is accepted', async () => {
    const { owner, workflowId } = await boundCopy();
    expect((await run(owner, workflowId, { briefId: 'brief-KT' })).status).toBe(201);
    expect((await run(owner, workflowId, {})).status).toBe(201);
  });

  it('only a parameter a node declared counts; an unbound chain param is not a conflict', () => {
    const def = {
      metadata: { expandedFrom: { chainId: 'c', version: '1', params: { briefId: 'A', label: 'x' } } },
      nodes: [{ id: 'n', typeId: 't', inputs: { briefId: 'A' } }],
    };
    expect(boundParamConflicts(def, { briefId: 'B', label: 'y' })).toEqual([{ param: 'briefId', bound: 'A', given: 'B' }]);
    expect(boundParamConflicts(def, { briefId: 'A' })).toEqual([]);
    expect(boundParamConflicts({ nodes: [] }, { briefId: 'B' })).toEqual([]);
  });
});
