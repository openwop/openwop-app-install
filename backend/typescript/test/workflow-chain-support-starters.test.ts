/**
 * Support + Starters workflow-chain packs (ADR 0190 Phase 1).
 *
 * The customer-support cluster (the #1 surveyed agent use case the gallery
 * previously had zero templates for) and the simple-pipe starter tier.
 * Asserts each chain loads, expands to a FROZEN validated WorkflowDefinition
 * (RFC 0013 R8), references only this host's shipped node typeIds (the
 * portability contract — a typo'd typeId otherwise ships silently as a
 * degraded template, ADR 0163 R6), and that every chain sending EXTERNALLY
 * (email-send / slack-message / sms-send) carries a human approval gate —
 * draft-only (`core.email.draft`) and in-app (`notification-push`) sinks are
 * exempt by the it-support precedent.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  listChains,
  expandChain,
  chainRequirements,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

beforeAll(() => {
  _resetChainRegistryForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

const PACKS: Record<string, string[]> = {
  'core.openwop.workflows.support': [
    'support.kb-answer',
    'support.email-triage',
    'support.ticket-routing',
    'support.sentiment-escalation',
    'support.csat-followup',
  ],
  'core.openwop.workflows.starters': [
    'starters.webhook-notify',
    'starters.form-to-table',
    'starters.scheduled-digest',
    'starters.fetch-to-storage',
    'starters.verified-webhook-router',
    'starters.webhook-to-slack',
  ],
};
const ALL_CHAINS = Object.values(PACKS).flat();

/** Every typeId the packs use must be one of this host's shipped/known node
 *  ids (the portability contract — no invented typeIds). */
const KNOWN_TYPEIDS = new Set([
  'feature.kb.nodes.rag',
  'core.ai.chatCompletion',
  'core.chat.approvalGate',
  'core.flow.if',
  'core.flow.noop',
  'core.email.draft',
  'core.openwop.connectors.ticket-create',
  'core.openwop.integration.email-send',
  'core.openwop.integration.slack-message',
  'feature.notifications.nodes.notify',
  'core.trigger.webhook',
  'core.trigger.form',
  'core.trigger.schedule',
  'core.openwop.http.fetch',
  'core.openwop.http.webhook-verify',
  'core.storage.table-insert',
  'core.storage.blob-put',
]);

/** External-send sinks that MUST sit behind a human approval gate. */
const GATED_SINKS = new Set([
  'core.openwop.integration.email-send',
  'core.openwop.integration.slack-message',
  'core.openwop.integration.sms-send',
]);

describe('support + starters packs — discovery', () => {
  it.each(Object.entries(PACKS))('%s loads all its chains', (pack, ids) => {
    for (const id of ids) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(pack);
    }
    expect(listChains().filter((c) => c.packName === pack)).toHaveLength(ids.length);
  });

  it('gallery categories derive from the pack keywords', () => {
    expect(getChain('support.kb-answer')!.category).toBe('Support');
    expect(getChain('starters.webhook-notify')!.category).toBe('Starters');
  });
});

describe('support + starters packs — every node uses a known shipped typeId', () => {
  it.each(ALL_CHAINS)('%s references only registered typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });

  it.each(ALL_CHAINS)('%s derives zero missing typeIds against the known set', (id) => {
    const chain = getChain(id)!.chain;
    const req = chainRequirements(chain, KNOWN_TYPEIDS, () => true);
    expect(req.missingNodeTypeIds).toEqual([]);
  });
});

/**
 * WF-EM-4 — this assertion is a PRECONDITION, not the gating guarantee, and it
 * used to claim otherwise. `chainRequirements.approvalGateCount` counts NODES
 * whose typeId matches `/approvalgate|\.hitl\./i`
 * (`workflowChainPackLoader.ts`) — presence, never behaviour. Ten chains that
 * sent the mail on a REJECT passed this assertion, and two sibling suites'
 * copies of it, for as long as it has existed: a gate node that is present and
 * ignored is indistinguishable here from a gate that gates.
 *
 * The behavioural witness lives in `workflow-chain-email-reject-witness.test.ts`
 * — it drives the REAL `core.chat.approvalGate` handler with the REAL UI
 * payloads and asserts against the REAL scheduler that no email-send node is
 * reachable on `{action:'reject'}`. Keep this one for what it can actually see
 * (a sink shipped with no gate node at all, and the `side-effectful`
 * capability), and do not read a green here as "the gate works".
 */
describe('support + starters packs — external sends declare an approval gate', () => {
  it.each(ALL_CHAINS)('%s declares a gate node + side-effectful for every external-send sink', (id) => {
    const chain = getChain(id)!.chain;
    const sendsExternally = chain.dag.nodes.some((n) => GATED_SINKS.has(n.typeId));
    if (sendsExternally) {
      const req = chainRequirements(chain, KNOWN_TYPEIDS, () => true);
      expect(req.approvalGateCount, `${id} sends externally with no gate node at all`).toBeGreaterThanOrEqual(1);
      // Marked side-effectful so existing capability gates apply uniformly.
      expect(chain.capabilities ?? []).toContain('side-effectful');
    }
  });

  it('draft-only email triage carries no gate — the draft IS the human gate', () => {
    const chain = getChain('support.email-triage')!.chain;
    expect(chain.dag.nodes.some((n) => n.typeId === 'core.email.draft')).toBe(true);
    expect(chain.dag.nodes.some((n) => n.typeId === 'core.openwop.integration.email-send')).toBe(false);
  });
});

describe('support + starters packs — expansion (RFC 0013, frozen + validated)', () => {
  const sampleParams: Record<string, Record<string, unknown>> = {
    'support.kb-answer': { question: 'How do I rotate my API key?' },
    'support.email-triage': { emailText: 'Subject: refund. My invoice was charged twice.' },
    'support.ticket-routing': { requestText: 'Exports fail with a 500 since yesterday.' },
    'support.sentiment-escalation': { message: 'This is the third outage this month. Cancelling.' },
    'support.csat-followup': { resolutionSummary: 'Restored SSO login for Acme (ticket SUP-42).' },
    'starters.webhook-notify': {},
    'starters.form-to-table': {},
    'starters.scheduled-digest': {},
    'starters.fetch-to-storage': { url: 'https://example.com/report.pdf' },
    'starters.verified-webhook-router': {},
    'starters.webhook-to-slack': {},
  };

  it.each(ALL_CHAINS)('%s expands to a validated definition with a deterministic id', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: sampleParams[id]! });
    expect(def.workflowId.startsWith(`${id}:`)).toBe(true);
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
    // Deterministic: same (chain, params) ⇒ byte-identical definition (R2).
    expect(expandChain(chain, { params: sampleParams[id]! })).toEqual(def);
    // RFC 0013 Path A: params are FROZEN into config at expansion — not emitted
    // as run-overridable variables[]. The persisted definition is portable: it
    // retains no {{params.*}} tokens (required-ness lives on chain.parameters).
    expect(def.variables).toBeUndefined();
    expect(JSON.stringify(def.nodes)).not.toContain('{{params');
  });

  it.each(ALL_CHAINS)('%s: every declared parameter is live in some node config', (id) => {
    // Guards the dead-param defect: expansion drops node `name` fields, so a
    // param referenced only outside config/inputs never affects execution.
    const chain = getChain(id)!.chain;
    const configText = JSON.stringify(chain.dag.nodes.map((n) => ({ c: n.config, i: n.inputs })));
    const params = Object.keys(
      ((chain.parameters as { properties?: Record<string, unknown> }).properties) ?? {},
    );
    for (const name of params) {
      expect(configText.includes(`{{params.${name}}}`), `${id} param ${name} is dead`).toBe(true);
    }
  });

  it('starter chains with no required params qualify for the zero-config tier', () => {
    for (const id of ['starters.webhook-notify', 'starters.form-to-table', 'starters.scheduled-digest', 'starters.verified-webhook-router']) {
      const chain = getChain(id)!.chain;
      expect(((chain.parameters as { required?: string[] }).required) ?? []).toEqual([]);
      const req = chainRequirements(chain, KNOWN_TYPEIDS, () => true);
      expect(req.connections).toEqual([]);
    }
  });
});
