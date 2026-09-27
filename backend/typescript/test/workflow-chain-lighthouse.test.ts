/**
 * Lighthouse workflow-chain pack (ADR 0149 / ADR 0163 follow-on).
 *
 * The five zero-config real-work workflows authored over this host's shipped
 * node typeIds. Asserts each chain loads, expands to a FROZEN validated
 * WorkflowDefinition (R8), substitutes run params, and references only the
 * intended registered typeIds — so a `:fork` replays the same DAG and the
 * gallery's "Use template" mints a real, runnable workflow.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  listChains,
  expandChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import { buildGraph, freshSnapshot, evaluateTrigger } from '../src/executor/scheduler.js';

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

const PACK = 'core.openwop.workflows.lighthouse';
const CHAINS = [
  'lighthouse.lead-triage',
  'lighthouse.account-brief',
  'lighthouse.renewal-risk',
  'lighthouse.rfp-response',
  'lighthouse.post-meeting',
];

/** Every typeId the pack uses must be one of this host's shipped/known node ids
 *  (the portability contract — no invented typeIds). */
const KNOWN_TYPEIDS = new Set([
  'feature.crm.nodes.triage-enriched',
  'feature.crm.nodes.get-company',
  'feature.crm.nodes.list-deals',
  'feature.analytics.nodes.query',
  'feature.kb.nodes.rag',
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'core.openwop.integration.email-send',
  'core.flow.noop', // ADR 0655 D6 — the rejected-run completion leg (ADR 0582 §10)
  'feature.notifications.nodes.notify',
]);

describe('lighthouse pack — discovery', () => {
  it('loads all five lighthouse chains from the vendored pack', () => {
    for (const id of CHAINS) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(PACK);
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(5);
  });
});

describe('lighthouse pack — every node uses a known shipped typeId', () => {
  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('lighthouse pack — expansion (RFC 0013, frozen + validated)', () => {
  const sampleParams: Record<string, Record<string, unknown>> = {
    'lighthouse.lead-triage': {},
    'lighthouse.account-brief': { companyId: 'acme-co' },
    'lighthouse.renewal-risk': {},
    'lighthouse.rfp-response': { rfpText: 'Vendor must support SSO and 99.9% uptime.' },
    'lighthouse.post-meeting': { transcript: 'Alice: ship Friday. Bob: I will own QA.' },
  };

  it.each(CHAINS)('%s expands to a validated definition with a deterministic id', (id) => {
    const def = expandChain(getChain(id)!.chain, { params: sampleParams[id]! });
    expect(def.workflowId).toMatch(new RegExp(`^${id.replace('.', '\\.')}:[0-9a-f]{12}$`));
    expect(def.nodes.length).toBeGreaterThan(0);
    // node ids rewritten with the collision-free prefix; typeIds preserved verbatim
    for (const n of def.nodes) {
      expect(n.nodeId.startsWith(id.replace(/\./g, '_') + '_')).toBe(true);
      expect(KNOWN_TYPEIDS.has(n.typeId)).toBe(true);
    }
  });

  it('RFC 0013 Path A — {{params.*}} FROZEN into config at expansion (no run-time variables[])', () => {
    const brief = expandChain(getChain('lighthouse.account-brief')!.chain, { params: { companyId: 'acme-co' } });
    // Path A: no run-overridable variables[]; the value is frozen into config.
    expect(brief.variables).toBeUndefined();
    const getCompany = brief.nodes.find((n) => n.typeId === 'feature.crm.nodes.get-company')!;
    expect((getCompany.config as { companyId: string }).companyId).toBe('acme-co'); // frozen
    const synth = brief.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    const sys = (synth.config as { systemPrompt: string }).systemPrompt;
    expect(sys).toContain('acme-co');       // frozen value
    expect(sys).not.toContain('{{params');  // no token survives (portability)
    expect(sys).not.toContain('{{inputs');

    // No params supplied → substituted away (empty); still no residual tokens.
    const lead = expandChain(getChain('lighthouse.lead-triage')!.chain, { params: {} });
    const draft = lead.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    expect((draft.config as { systemPrompt: string }).systemPrompt).not.toContain('{{params');
  });

  it('RFC 0013 Path A — a required param is declared on the CHAIN; expand freezes (no variables[])', () => {
    expect(((getChain('lighthouse.rfp-response')!.chain.parameters as { required?: string[] }).required)).toContain('rfpText');
    const rfp = expandChain(getChain('lighthouse.rfp-response')!.chain, { params: {} });
    expect(rfp.variables).toBeUndefined();
    expect(JSON.stringify(rfp.nodes)).not.toContain('{{params');
  });
});

/**
 * ADR 0582 §11 — a rejected review MUST NOT egress.
 *
 * Every lighthouse gate is followed by an external side effect (an outbound
 * email or a notification). `core.chat.approvalGate` returns
 * `status:'success'` on REJECT as well as approve, and neither
 * `core.openwop.integration.email-send` (packs/core.openwop.integration/
 * index.mjs — it sends unconditionally) nor `host/emailAdapter.ts` intercepts
 * an approval. So without a `truthy approved` edge condition the reviewer's
 * "no" still sent the mail — strictly worse than the CRM-task case, because
 * the effect leaves the building.
 *
 * These assert against the REAL scheduler (`evaluateTrigger`), not the JSON,
 * because a conditioned edge alone is NOT sufficient and asserting on the
 * pack shape would have missed it. MEASURED 2026-08-18: with the effect node
 * also fed by an UNCONDITIONAL data edge (`draft.content → send.text`, the
 * shape these chains shipped), `all_success` returns `ready` on reject anyway
 * — one completed upstream satisfies `anyCompleted` even though the gate edge
 * folded to `skipped`. The fix routes the content THROUGH the gate
 * (`draft.content → approve.artifact → send.text`) so the effect node has
 * exactly one, conditioned, incoming edge.
 */
describe('lighthouse pack — a REJECTED review cannot reach the side effect', () => {
  const EFFECTS = new Set([
    'core.openwop.integration.email-send',
    'feature.notifications.nodes.notify',
  ]);

  /** Verdict for every side-effecting node, with the gate resolved `approved`. */
  function effectVerdicts(chainId: string, approved: boolean): Record<string, string> {
    const def = expandChain(getChain(chainId)!.chain, { params: {} });
    const graph = buildGraph(def);
    const snap = freshSnapshot(def);
    const effects = def.nodes.filter((n) => EFFECTS.has(n.typeId));
    expect(effects.length, `${chainId} should have a side-effecting node`).toBeGreaterThan(0);
    const effectIds = new Set(effects.map((n) => n.nodeId));
    // Everything upstream succeeded; only the effect node is still pending.
    for (const n of def.nodes) {
      if (effectIds.has(n.nodeId)) continue;
      snap.nodeState.set(n.nodeId, 'completed');
      snap.nodeOutputs.set(
        n.nodeId,
        n.typeId === 'core.chat.approvalGate'
          ? { decision: approved ? 'accept' : 'reject', approved, artifact: 'body text' }
          : { content: 'body text', message: 'body text' },
      );
    }
    return Object.fromEntries(
      effects.map((n) => [n.nodeId, evaluateTrigger(n.nodeId, graph, snap)]),
    );
  }

  const GATED = ['lighthouse.lead-triage', 'lighthouse.account-brief', 'lighthouse.post-meeting'];

  it.each(GATED)('%s — REJECT skips every side-effecting node', (chainId) => {
    for (const [nodeId, verdict] of Object.entries(effectVerdicts(chainId, false))) {
      expect(verdict, `${chainId}:${nodeId} must NOT run on a rejection`).toBe('skip');
    }
  });

  // The paired positive leg — so the reject assertion cannot be satisfied by a
  // chain that simply never sends at all.
  it.each(GATED)('%s — APPROVE still reaches every side-effecting node', (chainId) => {
    for (const [nodeId, verdict] of Object.entries(effectVerdicts(chainId, true))) {
      expect(verdict, `${chainId}:${nodeId} must run on an approval`).toBe('ready');
    }
  });
});
