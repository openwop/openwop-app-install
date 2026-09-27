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
// Host-resolvable = shipped pack manifests ∪ built-in registrations — derived,
// never hard-coded (the pinned list drifted when the clusters moved onto the
// ADR 0186 core.openwop.connectors.* built-ins: hris-action, ticket-create, …).
import { isHostResolvableTypeId } from './packTypeIds.js';
let isKnownTypeId: (typeId: string) => boolean;
beforeAll(async () => { isKnownTypeId = await isHostResolvableTypeId(); });

const PACKS: Record<string, string[]> = {
  'core.openwop.workflows.people-hr': ['people-hr.onboarding', 'people-hr.offboarding', 'people-hr.pto-routing'],
  'core.openwop.workflows.finance': ['finance.invoice-ap', 'finance.month-end-close', 'finance.expense-approval'],
  'core.openwop.workflows.marketing': ['marketing.campaign-launch', 'marketing.ad-optimization', 'marketing.content-brief', 'marketing.content-repurposing'],
  'core.openwop.workflows.it-support': ['it-support.incident-triage'],
};

const SAMPLE: Record<string, Record<string, unknown>> = {
  'people-hr.onboarding': { newHireName: 'Sam Rivera', newHireEmail: 'sam.rivera@acme.test' },
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
      expect(isKnownTypeId(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('ADR 0149 clusters — expansion (RFC 0013, frozen + validated)', () => {
  it.each(ALL)('%s expands to a validated definition, params substituted, no leaks', (id) => {
    const def = expandChain(getChain(id)!.chain, { params: SAMPLE[id]! });
    expect(def.workflowId).toMatch(new RegExp(`^${id.replace('.', '\\.')}:[0-9a-f]{12}$`));
    expect(def.nodes.length).toBeGreaterThan(0);
    for (const n of def.nodes) {
      expect(n.nodeId.startsWith(id.replace(/\./g, '_') + '_')).toBe(true);
      expect(isKnownTypeId(n.typeId)).toBe(true);
      const sys = (n.config as { systemPrompt?: string }).systemPrompt;
      if (typeof sys === 'string') expect(sys).not.toContain('{{params');
    }
  });

  it('binds the remaining http node via connectionRef; HRIS/ticketing ride ADR 0186 capability nodes', () => {
    const onb = expandChain(getChain('people-hr.onboarding')!.chain, { params: { newHireName: 'Sam', newHireEmail: 'sam@acme.test' } });
    // Only IT provisioning still pins a connection; Workday/Jira moved to the
    // provider-agnostic capability-dispatch built-ins (no pinned ref by design).
    const refs = onb.nodes.filter((n) => n.typeId === 'core.openwop.http.openapi-call').map((n) => (n.config as { connectionRef: string }).connectionRef);
    expect(refs).toContain('core.openwop.connections.microsoft365');
    expect(onb.nodes.some((n) => n.typeId === 'core.openwop.connectors.hris-action')).toBe(true);
    expect(onb.nodes.some((n) => n.typeId === 'core.openwop.connectors.ticket-create')).toBe(true);
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

  it('RFC 0013 Path A — required params declared on the CHAIN; expand freezes (no run-time variables[])', () => {
    // The "required" contract lives on chain.parameters.required (author-facing).
    // Path A expansion FREEZES values — it does not emit run-overridable
    // variables[], and the persisted def carries zero {{params.*}} tokens.
    expect(((getChain('finance.invoice-ap')!.chain.parameters as { required?: string[] }).required)).toContain('invoiceText');
    const inv = expandChain(getChain('finance.invoice-ap')!.chain, { params: {} });
    expect(inv.variables).toBeUndefined();
    expect(JSON.stringify(inv.nodes)).not.toContain('{{params');
    expect(((getChain('it-support.incident-triage')!.chain.parameters as { required?: string[] }).required)).toContain('alert');
    const inc = expandChain(getChain('it-support.incident-triage')!.chain, { params: {} });
    expect(inc.variables).toBeUndefined();
    expect(JSON.stringify(inc.nodes)).not.toContain('{{params');
  });
});
