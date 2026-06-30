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
  'core.openwop.integration.notification-push',
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
      expect(n.nodeId.startsWith(id.replace(/\./g, '-') + '_')).toBe(true);
      expect(KNOWN_TYPEIDS.has(n.typeId)).toBe(true);
    }
  });

  it('substitutes required + defaulted params, leaving no {{placeholder}} leaks', () => {
    const brief = expandChain(getChain('lighthouse.account-brief')!.chain, { params: { companyId: 'acme-co' } });
    const getCompany = brief.nodes.find((n) => n.typeId === 'feature.crm.nodes.get-company')!;
    expect((getCompany.config as { companyId: string }).companyId).toBe('acme-co');
    const synth = brief.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    const sys = (synth.config as { systemPrompt: string }).systemPrompt;
    expect(sys).toContain('acme-co');
    expect(sys).not.toContain('{{params');

    // A defaulted param resolves to its default when omitted.
    const lead = expandChain(getChain('lighthouse.lead-triage')!.chain, { params: {} });
    const draft = lead.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    expect((draft.config as { systemPrompt: string }).systemPrompt).not.toContain('{{params');
  });

  it('throws chain_parameter_invalid when a required param is missing', () => {
    expect(() => expandChain(getChain('lighthouse.rfp-response')!.chain, { params: {} })).toThrow();
  });
});
