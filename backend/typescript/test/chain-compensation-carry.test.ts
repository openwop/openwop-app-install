/**
 * RFC 0157 (an RFC 0013 revision × RFC 0151 §B) — CHAIN EXPANSION CARRIES
 * COMPENSATION. ADR 0554 / H13.
 *
 * WHAT WAS BROKEN, and why every test stayed green while it was:
 *
 * On this host every workflow is a chain or a stack, and `expandChain` rebuilt
 * each expanded node from an ALLOWLIST — `{nodeId, typeId, config, inputs,
 * outputRole}`. `validateWorkflowDefinition` then rebuilt it from a SECOND
 * allowlist, and the conformance expand seam from a THIRD. A field absent from
 * an allowlist is not rejected; it is silently discarded. So a chain author
 * could declare an inverse action, the pack would load, the workflow would
 * register, the run would commit real effects — and the unwind would mint no
 * obligation and report a clean `none`. RFC 0151 §B was reachable only through a
 * hand-authored `POST /v1/workflows`, which on a chains-or-stacks host is
 * nothing. #3274 found the same class in `validateWorkflowDefinition` for
 * `compensation`; this file pins the chain half and the `irreversibleEffect`
 * sibling, END TO END, so a re-drop goes red rather than quiet.
 *
 * THE TESTS ARE WRITTEN TO FAIL ON A DROP, not on a rewrite. Each carry
 * assertion reads the field off the definition that actually reaches the
 * registry (`expandChain` returns `validateWorkflowDefinition(...)` output, and
 * the route-level leg reads it back through `GET /v1/workflows/{id}`), so
 * removing the carry from ANY of the allowlists reds this file.
 *
 * The advertised-set leg deliberately imports `COMPENSATION_ORDERING_MODEL` /
 * `COMPENSATION_PROFILE_VERSION` rather than hard-coding `'reverse-completion'`
 * / `'1'`: the values are the host's advert, and a test that restates them would
 * keep passing after the advert moved — asserting its own copy, not the host.
 *
 * @see ../../../docs/adr — ADR 0554 (compensation), RFC 0157, RFC 0151 §B UQ4
 * @see spec/v1/workflow-chain-packs.md §"Compensation (RFC 0157)"
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OpenwopError } from '../src/types.js';
import {
  expandChain,
  loadWorkflowChainPacks,
  getChain,
  type WorkflowChain,
} from '../src/host/workflowChainPackLoader.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { setCapabilityOverlay, resetCapabilityOverlay } from '../src/host/capabilityOverlay.js';
import { COMPENSATION_ORDERING_MODEL, type CompensationPolicy } from '../src/host/compensationUnwind.js';
import { COMPENSATION_PROFILE_VERSION } from '../src/host/compensationLedger.js';
import { createApp } from '../src/index.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const POLICY: CompensationPolicy = {
  triggers: ['node-failure', 'run-cancel'],
  orderingModel: COMPENSATION_ORDERING_MODEL,
  retry: { maxAttempts: 2, backoffMs: 100 },
};

/** A 3-node chain: `reserve` (compensated, inputMapping reads a param AND its
 *  own node output), `charge` (compensated, approval-gated), `notify`
 *  (uncompensated). */
function chain(over: Partial<WorkflowChain> = {}): WorkflowChain {
  return {
    chainId: 'test.compensating',
    version: '1.0.0',
    label: 'Compensating chain',
    description: 'reserve → charge → notify',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string', default: 'SKU-9' } },
    },
    dag: {
      nodes: [
        {
          id: 'reserve',
          typeId: 'vendor.shop.reserve',
          compensation: {
            nodeTypeId: 'vendor.shop.release',
            retry: { maxAttempts: 3, backoffMs: 250 },
            inputMapping: {
              sku: '{{params.sku}}',
              reservationId: '${nodes.reserve.output.id}',
              parentRef: '${nodes.upstream-in-parent.output.x}',
            },
          },
        },
        {
          id: 'charge',
          typeId: 'vendor.pay.charge',
          compensation: {
            nodeTypeId: 'vendor.pay.refund',
            requiresApproval: true,
            // RFC 0151 §B (S36). Absent from ANY of the three allowlists it is
            // silently discarded, not rejected — the #3274/#3292 class.
            waiveRequiresApproval: false,
            inputMapping: { chargeId: 'nodes.charge.output.chargeId' },
          },
        },
        { id: 'notify', typeId: 'vendor.mail.send' },
      ],
      edges: [
        { from: 'reserve', to: 'charge' },
        { from: 'charge', to: 'notify' },
      ],
    },
    ...over,
  } as WorkflowChain;
}

const nodeEndingIn = (
  def: ReturnType<typeof expandChain>,
  suffix: string,
): (typeof def)['nodes'][number] => {
  const n = def.nodes.find((x) => x.nodeId.endsWith(suffix));
  expect(n, `expected an expanded node ending in "${suffix}"`).toBeTruthy();
  return n!;
};

beforeAll(() => { setCapabilityOverlay('compensation.supported', true); });
afterEach(() => { setCapabilityOverlay('compensation.supported', true); });
afterAll(() => { resetCapabilityOverlay(); });

// ── §A — the per-node declaration survives expansion ────────────────────────

describe('RFC 0157 §A — the node declaration survives expansion (steps 3b/5b/6b)', () => {
  it('carries `compensation` VERBATIM onto the expanded WorkflowNode', () => {
    const def = expandChain(chain(), { params: { sku: 'SKU-9' } });
    const reserve = nodeEndingIn(def, '_reserve');
    // Dropped by any of the three allowlists, every one of these reads undefined
    // and the unwind mints no obligation for a node that committed a real effect.
    expect(reserve.compensation?.nodeTypeId).toBe('vendor.shop.release');
    expect(reserve.compensation?.retry).toEqual({ maxAttempts: 3, backoffMs: 250 });
    const charge = nodeEndingIn(def, '_charge');
    expect(charge.compensation?.nodeTypeId).toBe('vendor.pay.refund');
    expect(charge.compensation?.requiresApproval).toBe(true);
    // Explicitly `false`, which is the value most likely to be lost: a carry that
    // drops the key and one that writes `undefined` are indistinguishable unless
    // the fixture declares a NON-default value. `toBe(false)` — never `toBeFalsy`.
    expect(charge.compensation?.waiveRequiresApproval).toBe(false);
    // A node that declared none gains none — the host NEVER infers an inverse.
    expect(nodeEndingIn(def, '_notify').compensation).toBeUndefined();
  });

  it('step 5b — `{{params.*}}` inside `inputMapping` is substituted at expansion', () => {
    const def = expandChain(chain(), { params: { sku: 'SKU-42' } });
    const reserve = nodeEndingIn(def, '_reserve');
    expect(reserve.compensation?.inputMapping?.sku).toBe('SKU-42');
    // The persisted definition must carry ZERO residual param tokens anywhere —
    // including inside a compensator, which is exactly where a partial
    // substitution would hide until a failure.
    expect(JSON.stringify(def.nodes)).not.toContain('{{params.');
  });

  it('step 6b — fragment node-id refs inside `inputMapping` get the expansion prefix; a PARENT-workflow ref passes through', () => {
    const def = expandChain(chain(), {});
    const reserve = nodeEndingIn(def, '_reserve');
    // Not rewritten, the compensator reads a node id that no longer exists under
    // that name and the unwind resolves nothing.
    expect(reserve.compensation?.inputMapping?.reservationId).toBe(`\${nodes.${reserve.nodeId}.output.id}`);
    // Conservative, same rule as edge refs: an id that is NOT a fragment node id
    // belongs to the parent workflow and MUST survive verbatim.
    expect(reserve.compensation?.inputMapping?.parentRef).toBe('${nodes.upstream-in-parent.output.x}');
    // The bare `nodes.<id>.…` form is rewritten too.
    const charge = nodeEndingIn(def, '_charge');
    expect(charge.compensation?.inputMapping?.chargeId).toBe(`nodes.${charge.nodeId}.output.chargeId`);
  });

  it('step 3b — an unresolvable `compensation.nodeTypeId` is refused, exactly as `typeId` is', () => {
    // §B: "an unwind MUST NOT fail on a typo first discovered during a failure —
    // the worst possible moment to learn of one."
    const err = (): unknown => {
      try {
        expandChain(chain(), { isTypeIdKnown: (t) => t !== 'vendor.pay.refund' });
      } catch (e) { return e; }
      return null;
    };
    const e = err();
    expect(e).toBeInstanceOf(OpenwopError);
    expect((e as OpenwopError).message).toContain('chain_unresolvable_typeid');
    expect((e as OpenwopError).details?.typeId).toBe('vendor.pay.refund');
    // …and it does NOT fire when every compensator resolves.
    expect(() => expandChain(chain(), { isTypeIdKnown: () => true })).not.toThrow();
  });

  it('carries the declaration in DEFERRED mode too (RFC 0124) — an inputMapping is a recorded-facts read, frozen at drop time (UQ1)', () => {
    const def = expandChain(chain(), { deferred: true, params: { sku: 'SKU-7' } });
    expect(nodeEndingIn(def, '_reserve').compensation?.nodeTypeId).toBe('vendor.shop.release');
    expect(nodeEndingIn(def, '_reserve').compensation?.inputMapping?.sku).toBe('SKU-7');
  });
});

// ── UQ4 — irreversibleEffect ────────────────────────────────────────────────

describe('RFC 0151 §B UQ4 (× RFC 0157 step 6c) — irreversibleEffect', () => {
  const irreversibleChain = (): WorkflowChain => chain({
    dag: {
      nodes: [
        { id: 'send', typeId: 'vendor.mail.send', irreversibleEffect: true },
        { id: 'log', typeId: 'vendor.audit.write' },
      ],
      edges: [{ from: 'send', to: 'log' }],
    },
  } as Partial<WorkflowChain>);

  it('copies `irreversibleEffect` UNCHANGED onto the expanded node', () => {
    const def = expandChain(irreversibleChain(), {});
    // Dropped, the §D rollup can claim a full undo for a run that committed an
    // effect with no inverse — strictly worse than dropping a `compensation`.
    expect(nodeEndingIn(def, '_send').irreversibleEffect).toBe(true);
    // Absent stays absent: `false`/absent means NOTHING (an undeclared
    // compensator is still not implied), so the host must not materialize one.
    expect(nodeEndingIn(def, '_log').irreversibleEffect).toBeUndefined();
  });

  it('refuses a node declaring BOTH, with `chain_irreversible_with_compensation` (400, non-retriable) BEFORE any node is emitted', () => {
    const bad = chain({
      dag: {
        nodes: [{
          id: 'send',
          typeId: 'vendor.mail.send',
          irreversibleEffect: true,
          compensation: { nodeTypeId: 'vendor.mail.unsend' },
        }],
      },
    } as Partial<WorkflowChain>);
    let thrown: unknown = null;
    try { expandChain(bad, {}); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(OpenwopError);
    const e = thrown as OpenwopError;
    expect(e.code).toBe('chain_irreversible_with_compensation');
    expect(e.httpStatus).toBe(400);
    expect(e.details).toMatchObject({ chainId: 'test.compensating', nodeId: 'send', retriable: false });
    // Flat envelope, per `capabilities.md`: the CODE is the top-level `error`.
    expect(e.toEnvelope().error).toBe('chain_irreversible_with_compensation');
  });

  it('the both-declared refusal is NOT gated on the host knowing the typeIds', () => {
    // The contradiction is a property of the manifest, not of this host's
    // registry — so it must fire with no `isTypeIdKnown` predicate supplied
    // (which is how `from-chain` calls the expander).
    const bad = chain({
      dag: { nodes: [{ id: 'x', typeId: 't.a', irreversibleEffect: true, compensation: { nodeTypeId: 't.b' } }] },
    } as Partial<WorkflowChain>);
    expect(() => expandChain(bad, {})).toThrow(/chain_irreversible_with_compensation/);
  });

  it('registration refuses the same contradiction (`validation_error`) — the second gate, for a hand-authored definition', () => {
    // `workflow-definition.schema.json` §WorkflowNode: "a host MUST reject it at
    // registration (`validation_error`)". The chain gate cannot see this path.
    expect(() => validateWorkflowDefinition({
      workflowId: 'wf.x',
      nodes: [{ nodeId: 'send', typeId: 't', irreversibleEffect: true, compensation: { nodeTypeId: 't.undo' } }],
    })).toThrow(/both/i);
  });

  it('registration CARRIES `irreversibleEffect` and type-checks it', () => {
    const out = validateWorkflowDefinition({
      workflowId: 'wf.x',
      nodes: [{ nodeId: 'send', typeId: 't', irreversibleEffect: true }],
    });
    expect(out.nodes[0]?.irreversibleEffect).toBe(true);
    expect(() => validateWorkflowDefinition({
      workflowId: 'wf.x',
      nodes: [{ nodeId: 'send', typeId: 't', irreversibleEffect: 'yes' }],
    })).toThrow(/MUST be a boolean/);
  });
});

// ── §B — the chain-level policy → settings.compensation (step 9b) ───────────

describe('RFC 0157 §B — the chain policy becomes settings.compensation (step 9b)', () => {
  it('COPIES the policy when the parent has none', () => {
    const def = expandChain(chain({ compensation: POLICY }), {});
    expect(def.settings?.compensation).toEqual(POLICY);
    // A copy, not the manifest's own object — a registered definition must not
    // alias a shared, loader-owned chain entry.
    expect(def.settings?.compensation).not.toBe(POLICY);
    expect(def.settings?.compensation?.triggers).not.toBe(POLICY.triggers);
  });

  it('ACCEPTS a parent policy that is deep-equal in any key order', () => {
    const sameOtherOrder = {
      retry: { backoffMs: 100, maxAttempts: 2 },
      orderingModel: COMPENSATION_ORDERING_MODEL,
      triggers: ['node-failure', 'run-cancel'],
    } as CompensationPolicy;
    const def = expandChain(chain({ compensation: POLICY }), { parentSettingsCompensation: sameOtherOrder });
    expect(def.settings?.compensation).toEqual(sameOtherOrder);
  });

  it('REFUSES a differing parent policy with `chain_compensation_policy_conflict` (409) — never merges', () => {
    const parent: CompensationPolicy = { triggers: ['node-failure'] };
    let thrown: unknown = null;
    try { expandChain(chain({ compensation: POLICY }), { parentSettingsCompensation: parent }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(OpenwopError);
    const e = thrown as OpenwopError;
    expect(e.code).toBe('chain_compensation_policy_conflict');
    expect(e.httpStatus).toBe(409);
    expect(e.details).toMatchObject({ chainId: 'test.compensating' });
    expect(e.toEnvelope()).toMatchObject({
      error: 'chain_compensation_policy_conflict',
      details: { chainId: 'test.compensating' },
    });
  });

  it('a merged policy is NEVER produced — the refusal is the whole behaviour', () => {
    const parent: CompensationPolicy = { triggers: ['operator-request'] };
    try {
      const def = expandChain(chain({ compensation: POLICY }), { parentSettingsCompensation: parent });
      // If a future edit "helpfully" merges instead of refusing, this is what it
      // would look like — and a merged policy nobody wrote is exactly the
      // guess-at-a-contract failure the policy exists to prevent.
      expect.unreachable(`expected a conflict, got ${JSON.stringify(def.settings?.compensation)}`);
    } catch (e) {
      expect((e as OpenwopError).code).toBe('chain_compensation_policy_conflict');
    }
  });

  it('a chain declaring NO policy INHERITS the parent\'s (or none) — silence is not "no compensation"', () => {
    const parent: CompensationPolicy = { triggers: ['run-cancel'] };
    expect(expandChain(chain(), { parentSettingsCompensation: parent }).settings?.compensation).toEqual(parent);
    expect(expandChain(chain(), {}).settings).toBeUndefined();
  });

  it('the policy is refused with `capability_required` when the host does not advertise compensation', () => {
    // RFC 0157 §B: the same rule as a hand-authored `settings.compensation`. A
    // policy is a claim ABOUT THE HOST; accepting one the host will never honour
    // tells the author an unwind will happen when it will not.
    setCapabilityOverlay('compensation.supported', false);
    let thrown: unknown = null;
    try { expandChain(chain({ compensation: POLICY }), {}); } catch (e) { thrown = e; }
    expect((thrown as OpenwopError).code).toBe('capability_required');
    // …while the NODE declaration alone stays acceptable anywhere (it is
    // descriptive, not a claim about the host).
    expect(() => expandChain(chain(), {})).not.toThrow();
    expect(expandChain(chain(), {}).nodes.some((n) => n.compensation)).toBe(true);
  });

  it('`orderingModel` / `profileVersion` are validated at REGISTRATION against the host ADVERT, not a literal', () => {
    // Deliberately derived from the advert constants: a test restating
    // 'reverse-completion' / '1' would keep passing after the advert moved.
    const ok = expandChain(chain({
      compensation: { ...POLICY, profileVersion: COMPENSATION_PROFILE_VERSION },
    }), {});
    expect(ok.settings?.compensation?.profileVersion).toBe(COMPENSATION_PROFILE_VERSION);

    const otherOrdering = COMPENSATION_ORDERING_MODEL === 'reverse-completion' ? 'dependency-graph' : 'reverse-completion';
    expect(() => expandChain(chain({
      compensation: { ...POLICY, orderingModel: otherOrdering as CompensationPolicy['orderingModel'] },
    }), {})).toThrow(/orderingModel/);

    expect(() => expandChain(chain({
      compensation: { ...POLICY, profileVersion: `${Number(COMPENSATION_PROFILE_VERSION) + 1}` },
    }), {})).toThrow(/profileVersion/);
  });
});

// ── UQ2 — sub-chain nesting ─────────────────────────────────────────────────

describe('RFC 0157 UQ2 (resolved for v1) — a child chain owns its own policy', () => {
  it('a child policy DIFFERENT from the parent\'s is not a conflict: each co-registered workflow owns its `settings`', () => {
    const parentPolicy: CompensationPolicy = { triggers: ['node-failure'] };
    const childPolicy: CompensationPolicy = { triggers: ['run-cancel', 'operator-request'] };
    // The parent's own expansion carries the parent policy…
    const parentDef = expandChain(chain({ compensation: parentPolicy }), {});
    expect(parentDef.settings?.compensation).toEqual(parentPolicy);
    // …and the child, expanded as its own workflow (which is what
    // `coRegisterSubChains` does — it never threads a parent policy into a
    // child), carries the child's. A difference is NOT `chain_compensation_policy_conflict`.
    const childDef = expandChain(chain({ chainId: 'test.child', compensation: childPolicy }), {});
    expect(childDef.settings?.compensation).toEqual(childPolicy);
    expect(childDef.settings?.compensation).not.toEqual(parentDef.settings?.compensation);
  });
});

// ── the reachable wire: from-chain, end to end ──────────────────────────────

describe('RFC 0157 — the carry survives the real `POST /workflows/from-chain` lane', () => {
  let server: http.Server;
  let PORT: number;
  const CHAIN_ID = 'test.compensating-pack';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({
      port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
    });
    server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    PORT = (server.address() as AddressInfo).port;

    // A REAL pack on disk, validated by the loader against the VENDORED manifest
    // schema. This is the leg that catches a stale `schemas/` copy: before RFC
    // 0157 was vendored, `FragmentNode` was closed over
    // [id,typeId,name,position,config,inputs] and this pack failed
    // `workflow_chain_pack_manifest_invalid` at load — the chain never even
    // reached the expander.
    const root = mkdtempSync(join(tmpdir(), 'owp-h13-packs-'));
    mkdirSync(join(root, 'compensating'));
    writeFileSync(join(root, 'compensating', 'pack.json'), JSON.stringify({
      name: 'vendor.openwop-h13.workflows.compensating',
      version: '1.0.0',
      kind: 'workflow-chain',
      engines: { openwop: '>=1.0.0' },
      chains: [{
        chainId: CHAIN_ID,
        version: '1.0.0',
        label: 'Compensating pack chain',
        description: 'reserve → send',
        parameters: { type: 'object', properties: { sku: { type: 'string', default: 'SKU-1' } } },
        compensation: POLICY,
        dag: {
          nodes: [
            {
              id: 'reserve',
              typeId: 'core.openwop.flow.noop',
              compensation: {
                nodeTypeId: 'core.openwop.flow.noop',
                inputMapping: { sku: '{{params.sku}}', ref: '${nodes.reserve.output.id}' },
                requiresApproval: true,
                waiveRequiresApproval: false,
              },
            },
            { id: 'send', typeId: 'core.openwop.flow.noop', irreversibleEffect: true },
          ],
          edges: [{ from: 'reserve', to: 'send' }],
        },
      }],
    }, null, 2));
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    expect(errors, 'the RFC 0157 pack MUST validate against the vendored manifest schema').toEqual([]);
    expect(getChain(CHAIN_ID)).not.toBeNull();
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const url = (p: string): string => `http://127.0.0.1:${PORT}/v1/host/openwop-app${p}`;
  const cookie = async (): Promise<string> =>
    (await fetch(url('/workflows'))).headers.get('set-cookie')!.split(';')[0]!;

  it('instantiates, and the STORED definition carries the declaration, the irreversible flag, and settings.compensation', async () => {
    const c = await cookie();
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: c },
      body: JSON.stringify({ chainId: CHAIN_ID, params: { sku: 'SKU-77' } }),
    });
    expect(r.status).toBe(201);
    const { workflowId } = (await r.json()) as { workflowId: string };

    // Read it back through the wire, not from an in-process object: this is the
    // artifact the executor and the unwind actually load.
    const def = (await (await fetch(
      `http://127.0.0.1:${PORT}/v1/workflows/${workflowId}`,
      { headers: { cookie: c } },
    )).json()) as {
      nodes: Array<{ nodeId: string; compensation?: { nodeTypeId: string; inputMapping?: Record<string, unknown>; requiresApproval?: boolean; waiveRequiresApproval?: boolean }; irreversibleEffect?: boolean }>;
      settings?: { compensation?: CompensationPolicy };
    };
    const reserve = def.nodes.find((n) => n.nodeId.endsWith('_reserve'))!;
    const send = def.nodes.find((n) => n.nodeId.endsWith('_send'))!;
    expect(reserve.compensation?.nodeTypeId).toBe('core.openwop.flow.noop');
    expect(reserve.compensation?.requiresApproval).toBe(true);
    expect(reserve.compensation?.waiveRequiresApproval).toBe(false);
    expect(reserve.compensation?.inputMapping?.sku).toBe('SKU-77');
    expect(reserve.compensation?.inputMapping?.ref).toBe(`\${nodes.${reserve.nodeId}.output.id}`);
    expect(send.irreversibleEffect).toBe(true);
    expect(def.settings?.compensation).toEqual(POLICY);
  });

  it('refuses the chain with `capability_required` when the host does not advertise compensation — a FLAT envelope, not a 500', async () => {
    setCapabilityOverlay('compensation.supported', false);
    const r = await fetch(url('/workflows/from-chain'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie() },
      body: JSON.stringify({ chainId: CHAIN_ID, params: {} }),
    });
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('capability_required');
    expect(r.status).toBe(400);
  });

  it('a manifest declaring BOTH `irreversibleEffect: true` and a `compensation` never loads (the schema is the first gate)', () => {
    const root = mkdtempSync(join(tmpdir(), 'owp-h13-bad-'));
    mkdirSync(join(root, 'contradictory'));
    writeFileSync(join(root, 'contradictory', 'pack.json'), JSON.stringify({
      name: 'vendor.openwop-h13.workflows.contradictory',
      version: '1.0.0',
      kind: 'workflow-chain',
      engines: { openwop: '>=1.0.0' },
      chains: [{
        chainId: 'test.contradictory',
        version: '1.0.0',
        label: 'Contradictory',
        description: 'both',
        parameters: { type: 'object' },
        dag: {
          nodes: [{
            id: 'send',
            typeId: 'core.openwop.flow.noop',
            irreversibleEffect: true,
            compensation: { nodeTypeId: 'core.openwop.flow.noop' },
          }],
        },
      }],
    }, null, 2));
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    expect(errors.map((e) => e.code)).toContain('workflow_chain_pack_manifest_invalid');
    expect(getChain('test.contradictory')).toBeNull();
  });
});
