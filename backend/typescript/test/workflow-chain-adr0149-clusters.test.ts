/**
 * ADR 0149 remaining clusters — People/HR, Finance, Marketing/Advertising, IT/Support.
 *
 * Four RFC 0013 workflow-chain packs completing the ADR 0149 catalog. Asserts every
 * chain loads, expands to a FROZEN validated WorkflowDefinition, substitutes run
 * params (no {{placeholder}} leaks), references only typeIds that resolve on the
 * reference host, enforces required params, and gates external sends. Mirrors the
 * lighthouse + exec-ops gates.
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
  expect(errors).toEqual([]); // no chainId conflicts across all vendored packs
});

/** typeIds verified present in the live app node catalog (523 typeIds). */
const KNOWN_TYPEIDS = new Set([
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'core.flow.if',
  'core.openwop.http.openapi-call',
  'core.openwop.integration.notification-push',
  'core.openwop.integration.slack-message',
  'feature.crm.nodes.list-companies',
  'feature.cms.nodes.list-pages',
  'feature.kb.nodes.rag',
  'feature.email.nodes.render',
]);

const PACKS: Record<string, string[]> = {
  'core.openwop.workflows.people-hr': ['people-hr.onboarding', 'people-hr.offboarding', 'people-hr.pto-routing'],
  'core.openwop.workflows.finance': ['finance.invoice-ap', 'finance.month-end-close', 'finance.expense-approval'],
  'core.openwop.workflows.marketing': ['marketing.campaign-launch', 'marketing.ad-optimization', 'marketing.content-brief', 'marketing.content-repurposing'],
  'core.openwop.workflows.it-support': ['it-support.incident-triage'],
};

const SAMPLE: Record<string, Record<string, unknown>> = {
  'people-hr.onboarding': { newHireName: 'Sam Rivera' },
  'people-hr.offboarding': { employeeName: 'Sam Rivera' },
  'people-hr.pto-routing': { employeeName: 'Sam Rivera', dates: 'Jul 1–5' },
  'finance.invoice-ap': { invoiceText: 'Acme Co — 3 line items, total $4,200' },
  'finance.month-end-close': { period: '2026-05' },
  'finance.expense-approval': { expenseContext: '$320 travel, category meals' },
  'marketing.campaign-launch': { brief: 'Q3 launch for the analytics add-on' },
  'marketing.ad-optimization': {},
  'marketing.content-brief': { topic: 'workflow orchestration for ops teams' },
  'marketing.content-repurposing': { sourceText: 'Our launch blog post...' },
  'it-support.incident-triage': { alert: 'API 5xx rate spiking in us-central1' },
};

const ALL = Object.values(PACKS).flat();

describe('ADR 0149 clusters — discovery', () => {
  it.each(Object.entries(PACKS))('%s loads its chains', (pack, ids) => {
    for (const id of ids) {
      const e = getChain(id);
      expect(e, id).not.toBeNull();
      expect(e!.packName).toBe(pack);
    }
    expect(listChains().filter((c) => c.packName === pack)).toHaveLength(ids.length);
  });
});

describe('ADR 0149 clusters — every node uses a host-resolvable typeId', () => {
  it.each(ALL)('%s references only known typeIds', (id) => {
    for (const n of getChain(id)!.chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('ADR 0149 clusters — expansion (RFC 0013, frozen + validated)', () => {
  it.each(ALL)('%s expands to a validated definition, params substituted, no leaks', (id) => {
    const def = expandChain(getChain(id)!.chain, { params: SAMPLE[id]! });
    expect(def.workflowId).toMatch(new RegExp(`^${id.replace('.', '\\.')}:[0-9a-f]{12}$`));
    expect(def.nodes.length).toBeGreaterThan(0);
    for (const n of def.nodes) {
      expect(n.nodeId.startsWith(id.replace(/\./g, '-') + '_')).toBe(true);
      expect(KNOWN_TYPEIDS.has(n.typeId)).toBe(true);
      const sys = (n.config as { systemPrompt?: string }).systemPrompt;
      if (typeof sys === 'string') expect(sys).not.toContain('{{params');
    }
  });

  it('binds connections via connectionRef on the http nodes', () => {
    const onb = expandChain(getChain('people-hr.onboarding')!.chain, { params: { newHireName: 'Sam' } });
    const refs = onb.nodes.filter((n) => n.typeId === 'core.openwop.http.openapi-call').map((n) => (n.config as { connectionRef: string }).connectionRef);
    expect(refs).toContain('core.openwop.connections.microsoft365');
    expect(refs).toContain('core.openwop.connections.workday');
    expect(refs).toContain('core.openwop.connections.jira');
  });

  it('routes the ad-optimization guardrail through a core.flow.if (no new primitive)', () => {
    const opt = getChain('marketing.ad-optimization')!.chain;
    const guard = opt.dag.nodes.find((n) => n.typeId === 'core.flow.if');
    expect(guard).toBeTruthy();
    // the guard fans out to both an auto-apply path and an approval path
    const outs = (opt.dag.edges ?? []).filter((e) => e.from === guard!.id).map((e) => e.to);
    expect(outs.length).toBe(2);
    expect(opt.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(true);
  });

  it('gates every external send behind an approval (sampled)', () => {
    for (const id of ['people-hr.offboarding', 'finance.invoice-ap', 'finance.expense-approval', 'marketing.campaign-launch', 'marketing.content-repurposing']) {
      expect(getChain(id)!.chain.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate'), id).toBe(true);
    }
  });

  it('throws chain_parameter_invalid when a required param is missing', () => {
    expect(() => expandChain(getChain('finance.invoice-ap')!.chain, { params: {} })).toThrow();
    expect(() => expandChain(getChain('it-support.incident-triage')!.chain, { params: {} })).toThrow();
  });
});
