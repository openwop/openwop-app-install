/**
 * ADR 0677 D1 part 3 + D2 — the two halves that make the route-side ACL fix reachable, and
 * the mailbox writer's replay classification.
 *
 * Tracker TST-BGF-8. Red when: `core.chat.approvalGate` stops forwarding the ACL to
 * `ctx.suspend`, forwards blanks, or forwards empty arrays; the REGISTERED
 * `core.email.draft` module loses `sideEffecting: true` (D2 legs 1–2 read the real
 * module out of the node registry, not a literal); `core.email.send` gets
 * classified; or the trigger lane stops seeding the variable bag.
 *
 * CEILING: the ISWF-6a leg is a source check. A behavioural trigger-ingest leg
 * would be new coverage, not an upgrade of this claim.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('ADR 0677 D1 part 3 — core.chat.approvalGate forwards the approver ACL', () => {
  /** The slice of the pack ctx `approvalGate` reads. */
  interface GateCtx {
    nodeId: string;
    config: Record<string, unknown>;
    inputs: Record<string, unknown>;
    variables: { get: (k: string) => unknown; set: (k: string, v: unknown) => void };
    chat: { sendMessage: () => Promise<void>; progressCard: () => Promise<void>; updateCard: () => Promise<void> };
    suspend: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
  }
  const loadGate = async () => {
    const mod = (await import(join(REPO, 'packs', 'vendor.myndhyve.chat', 'index.mjs'))) as {
      nodes?: Record<string, (ctx: GateCtx) => Promise<unknown>>;
      default?: Record<string, (ctx: GateCtx) => Promise<unknown>>;
    };
    const nodes = mod.nodes ?? mod.default ?? {};
    const gate = nodes['core.chat.approvalGate'];
    if (!gate) throw new Error('core.chat.approvalGate is not exported by vendor.myndhyve.chat');
    return gate;
  };
  /** Capture what the node hands to `ctx.suspend` — `makeSuspendFn` persists that payload
   *  verbatim as `interrupt.data`, which is exactly what the route lanes read. */
  const runGate = async (config: Record<string, unknown>) => {
    const gate = await loadGate();
    let payload: Record<string, unknown> | undefined;
    const ctx: GateCtx = {
      nodeId: 'gate1', config, inputs: { artifact: 'x' },
      variables: { get: () => undefined, set: () => {} },
      chat: { sendMessage: async () => {}, progressCard: async () => {}, updateCard: async () => {} },
      suspend: async (p) => { payload = p; return { action: 'accept' }; },
    };
    try {
      await gate(ctx);
    } catch (err) {
      // The gate may fail AFTER suspend (this ctx is minimal); a failure BEFORE it is real.
      if (payload === undefined) throw err;
    }
    return payload;
  };

  it('leg 1: a declared ACL reaches interrupt.data — born red (the node forwarded 5 keys and not this one)', async () => {
    const p = await runGate({ title: 'T', approverRefs: ['urn:listed'], overrideScopes: ['approvals:override'] });
    expect(p, 'the gate must have suspended').toBeTruthy();
    expect(p!.approverRefs).toEqual(['urn:listed']);
    expect(p!.overrideScopes).toEqual(['approvals:override']);
  });

  it('leg 2: blanks are DROPPED, so the pack default stays an open gate', async () => {
    // `approvals.two-stage-sign-off` freezes both params to "" and documents
    // "blank = any team member". Forwarding [""] would refuse every member of every tenant.
    const p = await runGate({ title: 'T', approverRefs: [''] });
    expect(p).toBeTruthy();
    expect(p!.approverRefs, 'a blank ACL must not be forwarded').toBeUndefined();
  });

  it('leg 3: a gate declaring nothing forwards nothing — no empty arrays on the wire', async () => {
    const p = await runGate({ title: 'T' });
    expect(p).toBeTruthy();
    for (const k of ['approverRefs', 'approverGroupRefs', 'approverRoleRefs', 'overrideScopes']) {
      expect(p![k], `${k} must be absent, not []`).toBeUndefined();
    }
  });

  it('leg 4: the pack version moved — a pack behaviour change needs a bump + republish', () => {
    // A FLOOR, not a pin: the quorum forward shipped in 1.4.0, so the published pack must be
    // at least that. An exact pin churned on every later bump (dff32f4db) and caught nothing.
    const pack = JSON.parse(readFileSync(join(REPO, 'packs', 'vendor.myndhyve.chat', 'pack.json'), 'utf8')) as { version: string };
    const [maj, min, pat] = pack.version.split('.').map((n) => Number(n));
    expect([maj, min, pat].every((n) => Number.isInteger(n)), pack.version).toBe(true);
    const atLeast = maj! > 1 || (maj === 1 && min! >= 4);
    expect(atLeast, `vendor.myndhyve.chat ${pack.version} predates the 1.4.0 quorum forward`).toBe(true);
  });

  // WF-UP-2 (Book AI) — the quorum keys the host resolver reads were never forwarded.
  it('leg 5: requiredApprovals and rejectionPolicy reach interrupt.data (N-of-M is real on this node)', async () => {
    const p = await runGate({ title: 'T', approverRefs: ['urn:a', 'urn:b', 'urn:c'], requiredApprovals: 2, rejectionPolicy: 'majority' });
    expect(p!.requiredApprovals).toBe(2);
    expect(p!.rejectionPolicy).toBe('majority');
  });

  it('leg 6: a malformed quorum is dropped, never forwarded (the gate stays single-approver)', async () => {
    for (const bad of [0, -1, 1.5, '2', null]) {
      const p = await runGate({ title: 'T', requiredApprovals: bad, rejectionPolicy: 'sometimes' });
      expect(p!.requiredApprovals, String(bad)).toBeUndefined();
      expect(p!.rejectionPolicy).toBeUndefined();
    }
  });

  it('leg 7: the config schema DECLARES what the node forwards (no undeclared-but-enforced keys)', () => {
    const schema = JSON.parse(readFileSync(join(REPO, 'packs', 'vendor.myndhyve.chat', 'schemas', 'approvalGate.config.json'), 'utf8')) as { properties: Record<string, unknown> };
    for (const k of ['approverRefs', 'approverGroupRefs', 'approverRoleRefs', 'overrideScopes', 'requiredApprovals', 'rejectionPolicy']) {
      expect(schema.properties[k], k).toBeDefined();
    }
  });
});

describe('ADR 0677 D2 — core.email.draft is replay-classified', () => {
  it('leg 1: isSideEffectingNode is true via the module arm (the only arm available — no manifest exists)', () => {
    ensureNodesRegistered();
    const draft = getNodeRegistry().get('core.email.draft');
    expect(draft, 'core.email.draft must be registered').not.toBeNull();
    expect(isSideEffectingNode('core.email.draft', draft)).toBe(true);
    // The typeId alone must NOT be enough: there is no manifest and no pattern arm, which is
    // precisely why the module flag is load-bearing.
    expect(isSideEffectingNode('core.email.draft', null)).toBe(false);
  });

  it('leg 2: the flag is actually set at the registration site — mechanism vs wiring', () => {
    ensureNodesRegistered();
    expect(getNodeRegistry().get('core.email.draft')?.sideEffecting).toBe(true);
  });

  it('leg 3: the documented asymmetry with core.email.send is preserved, not silently broken', () => {
    // `core.email.send` carries a written rationale for staying unclassified (a fork mints a
    // new runId and correctly re-hits its mandatory approval interrupt). If someone later
    // classifies it, that is a decision to make deliberately — this leg makes it visible.
    ensureNodesRegistered();
    const send = getNodeRegistry().get('core.email.send');
    expect(send, 'core.email.send must be registered').not.toBeNull();
    expect(isSideEffectingNode('core.email.send', send), 'core.email.send is deliberately NOT classified — see ADR 0677 D2').toBe(false);
  });
});

describe('ADR 0677 ISWF-6a — the trigger lane seeds the variable bag', () => {
  it('leg 1: triggerIngestionService calls seedRunVariables — it was the ONLY run-start path that did not', () => {
    const src = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'host', 'triggerIngestionService.ts'), 'utf8');
    expect(src).toMatch(/seedRunVariables\(runId, wf\.definition\.variables, \{\}\)/);
    // Non-vacuity: the call must sit on the ingest path, i.e. before executeRun.
    expect(src.indexOf('seedRunVariables(runId')).toBeLessThan(src.indexOf('executeRun(deps.storage, run'));
  });
});
