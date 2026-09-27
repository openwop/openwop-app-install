/**
 * ADR 0677 D1 part 3 + D2 — the two halves that make the route-side ACL fix reachable, and
 * the mailbox writer's replay classification.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('ADR 0677 D1 part 3 — core.chat.approvalGate forwards the approver ACL', () => {
  const loadGate = async () => {
    const mod = await import(join(REPO, 'packs', 'vendor.myndhyve.chat', 'index.mjs'));
    const nodes = (mod.nodes ?? mod.default) as Record<string, (ctx: unknown) => Promise<unknown>>;
    return nodes['core.chat.approvalGate']!;
  };
  /** Capture what the node hands to `ctx.suspend` — `makeSuspendFn` persists that payload
   *  verbatim as `interrupt.data`, which is exactly what the route lanes read. */
  const runGate = async (config: Record<string, unknown>) => {
    const gate = await loadGate();
    let payload: Record<string, unknown> | undefined;
    const ctx = {
      nodeId: 'gate1', config, inputs: { artifact: 'x' },
      variables: { get: () => undefined, set: () => {} },
      chat: { sendMessage: async () => {}, progressCard: async () => {}, updateCard: async () => {} },
      suspend: async (p: Record<string, unknown>) => { payload = p; return { action: 'accept' }; },
    };
    try { await gate(ctx as never); } catch { /* the gate may continue past suspend; we only need the payload */ }
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
    const pack = JSON.parse(readFileSync(join(REPO, 'packs', 'vendor.myndhyve.chat', 'pack.json'), 'utf8')) as { version: string };
    expect(pack.version).toBe('1.3.0');
  });
});

describe('ADR 0677 D2 — core.email.draft is replay-classified', () => {
  it('leg 1: isSideEffectingNode is true via the module arm (the only arm available — no manifest exists)', () => {
    expect(isSideEffectingNode('core.email.draft', { sideEffecting: true })).toBe(true);
    // The typeId alone must NOT be enough: there is no manifest and no pattern arm, which is
    // precisely why the module flag is load-bearing.
    expect(isSideEffectingNode('core.email.draft', null)).toBe(false);
  });

  it('leg 2: the flag is actually set at the registration site — mechanism vs wiring', () => {
    const src = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'bootstrap', 'nodes.ts'), 'utf8');
    const decl = src.slice(src.indexOf('const emailDraftNode: NodeModule = {'));
    expect(decl.slice(0, decl.indexOf('async execute'))).toMatch(/sideEffecting:\s*true/);
  });

  it('leg 3: the documented asymmetry with core.email.send is preserved, not silently broken', () => {
    // `core.email.send` carries a written rationale for staying unclassified (a fork mints a
    // new runId and correctly re-hits its mandatory approval interrupt). If someone later
    // classifies it, that is a decision to make deliberately — this leg makes it visible.
    const src = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'bootstrap', 'nodes.ts'), 'utf8');
    const sendDecl = src.slice(src.indexOf('const emailSendNode'), src.indexOf('const emailSendNode') + 900);
    expect(sendDecl, 'core.email.send is deliberately NOT classified — see ADR 0677 D2').not.toMatch(/sideEffecting:\s*true/);
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
