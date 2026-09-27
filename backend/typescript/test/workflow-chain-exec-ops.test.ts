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

// Host-resolvable = shipped pack manifests ∪ built-in registrations — derived,
// never hard-coded (the old pinned list drifted when #1149 moved this pack onto
// core.openwop.connectors.* built-ins and poisoned every local CI run).
import { isHostResolvableTypeId } from './packTypeIds.js';
let isKnownTypeId: (typeId: string) => boolean;
beforeAll(async () => { isKnownTypeId = await isHostResolvableTypeId(); });

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
      expect(isKnownTypeId(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
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
      expect(n.nodeId.startsWith(id.replace(/\./g, '_') + '_')).toBe(true);
      expect(isKnownTypeId(n.typeId)).toBe(true);
    }
  });

  it('RFC 0013 Path A — params FROZEN into config at expansion; connectionRef binding preserved', () => {
    const prep = expandChain(getChain('exec-ops.meeting-prep')!.chain, { params: { attendeeCompanyId: 'acme-co' } });
    expect(prep.variables).toBeUndefined();
    const company = prep.nodes.find((n) => n.typeId === 'feature.crm.nodes.get-company')!;
    expect((company.config as { companyId: string }).companyId).toBe('acme-co'); // frozen value, not a token
    // ADR 0186: the pack moved from a connectionRef-pinned openapi-call to the
    // provider-agnostic capability-dispatch node — the provider resolves from
    // the acting user's connections, so there is deliberately NO pinned ref.
    const cal = prep.nodes.find((n) => n.typeId === 'core.openwop.connectors.calendar-list-events')!;
    expect(cal, 'meeting-prep carries the calendar capability node').toBeTruthy();
    expect((cal.config as { connectionRef?: string }).connectionRef).toBeUndefined();
    const dossier = prep.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!;
    expect((dossier.config as { systemPrompt: string }).systemPrompt).not.toContain('{{params');

    const board = expandChain(getChain('exec-ops.board-update')!.chain, { params: { period: '2026-05' } });
    const fin = board.nodes.find((n) => n.typeId === 'core.openwop.connectors.erp-action')!;
    expect((fin.config as { action?: string }).action, 'erp capability node keeps its action config').toBeTruthy();
    expect((fin.config as { connectionRef?: string }).connectionRef).toBeUndefined();
    const boardSys = (board.nodes.find((n) => n.typeId === 'core.ai.chatCompletion')!.config as { systemPrompt: string }).systemPrompt;
    expect(boardSys).toContain('2026-05'); // frozen value at expansion (Path A)
    expect(boardSys).not.toContain('{{inputs.period}}');
    expect(board.variables).toBeUndefined();
  });

  it('gates the board update behind an approval but leaves the read-only briefing ungated', () => {
    const board = getChain('exec-ops.board-update')!.chain;
    expect(board.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(true);
    const briefing = getChain('exec-ops.daily-briefing')!.chain;
    expect(briefing.dag.nodes.some((n) => n.typeId === 'core.chat.approvalGate')).toBe(false);
  });

  it('RFC 0013 Path A — a required param is declared on the CHAIN; expand freezes (no variables[])', () => {
    expect(((getChain('exec-ops.meeting-prep')!.chain.parameters as { required?: string[] }).required)).toContain('attendeeCompanyId');
    const prep = expandChain(getChain('exec-ops.meeting-prep')!.chain, { params: {} });
    expect(prep.variables).toBeUndefined();
    expect(JSON.stringify(prep.nodes)).not.toContain('{{params');
  });
});
