/**
 * Exec-ops workflow-chain pack (ADR 0149 — Executive / Chief-of-Staff cluster).
 *
 * Daily Briefing, Meeting Prep, Board Update. Asserts each chain loads, expands
 * to a FROZEN validated WorkflowDefinition, substitutes run params, references
 * only known shipped typeIds, and binds connection packs via http.openapi-call
 * `connectionRef` config (the ADR 0149 connector pattern). Mirrors the lighthouse
 * pack's gate.
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

const PACK = 'core.openwop.workflows.exec-ops';
const CHAINS = ['exec-ops.daily-briefing', 'exec-ops.meeting-prep', 'exec-ops.board-update'];

const KNOWN_TYPEIDS = new Set([
  'feature.crm.nodes.list-deals',
  'feature.crm.nodes.list-tasks',
  'feature.crm.nodes.get-company',
  'feature.analytics.nodes.query',
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'core.openwop.http.openapi-call',
  'core.openwop.integration.notification-push',
]);

describe('exec-ops pack — discovery', () => {
  it('loads all three exec-ops chains', () => {
    for (const id of CHAINS) {
      const e = getChain(id);
      expect(e, id).not.toBeNull();
      expect(e!.packName).toBe(PACK);
    }
    expect(listChains().filter((c) => c.packName === PACK)).toHaveLength(3);
  });
});

describe('exec-ops pack — every node uses a known shipped typeId', () => {
  it.each(CHAINS)('%s references only registered typeIds', (id) => {
    for (const n of getChain(id)!.chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('exec-ops pack — expansion (RFC 0013, frozen + validated)', () => {
  const sample: Record<string, Record<string, unknown>> = {
    'exec-ops.daily-briefing': {},
    'exec-ops.meeting-prep': { attendeeCompanyId: 'acme-co' },
    'exec-ops.board-update': { period: '2026-05' },
  };

  it.each(CHAINS)('%s expands to a validated definition with a deterministic id', (id) => {
    const def = expandChain(getChain(id)!.chain, { params: sample[id]! });
    expect(def.workflowId).toMatch(new RegExp(`^${id.replace('.', '\\.')}:[0-9a-f]{12}$`));
    for (const n of def.nodes) {
      expect(n.nodeId.startsWith(id.replace(/\./g, '-') + '_')).toBe(true);
      expect(KNOWN_TYPEIDS.has(n.typeId)).toBe(true);
    }
  });

  it('substitutes params + leaves no {{placeholder}} leaks, and binds connections via connectionRef', () => {
    const prep = expandChain(getChain('exec-ops.meeting-prep')!.chain, { params: { attendeeCompanyId: 'acme-co' } });
    const company = prep.nodes.find((n) => n.typeId === 'feature.crm.nodes.get-company')!;
    expect((company.config as { companyId: string }).companyId).toBe('acme-co');
    const cal = prep.nodes.find((n) => n.typeId === 'core.openwop.http.openapi-call')!;
    expect((cal.config as { connectionRef: string }).connectionRef).toBe('core.openwop.connections.microsoft365');
    const dossier = prep.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    expect((dossier.config as { systemPrompt: string }).systemPrompt).not.toContain('{{params');

    const board = expandChain(getChain('exec-ops.board-update')!.chain, { params: { period: '2026-05' } });
    const fin = board.nodes.find((n) => n.typeId === 'core.openwop.http.openapi-call')!;
    expect((fin.config as { connectionRef: string }).connectionRef).toBe('core.openwop.connections.netsuite');
    expect((board.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!.config as { systemPrompt: string }).systemPrompt).toContain('2026-05');
  });

  it('gates the board update behind an approval but leaves the read-only briefing ungated', () => {
    const board = getChain('exec-ops.board-update')!.chain;
    expect(board.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(true);
    const briefing = getChain('exec-ops.daily-briefing')!.chain;
    expect(briefing.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(false);
  });

  it('throws chain_parameter_invalid when a required param is missing', () => {
    expect(() => expandChain(getChain('exec-ops.meeting-prep')!.chain, { params: {} })).toThrow();
  });
});
