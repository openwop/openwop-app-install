/**
 * ADR 0484 — gap-category workflow-chain packs (whitespace Phase 6, T8
 * template depth). Eight new galleries in categories the library had zero
 * templates for: customer onboarding, feedback triage, incident postmortem,
 * SEO content ops, meeting ops, release comms, sales outreach, weekly digest.
 *
 * Same portability contract the support/starters suite enforces: each chain
 * loads, references ONLY this host's shipped node typeIds (a typo'd typeId
 * otherwise ships a silently degraded template, ADR 0163 R6), expands to a
 * FROZEN validated WorkflowDefinition.
 *
 * Grade-tests wave 64 cut two cases, each with a covering probe red in its
 * covering file: "derives zero missing typeIds against the known set" ran
 * `chainRequirements` over the SAME hand-copied set as the typeId case here
 * (probe 8fw5g3-gap-typeid reds both), and the per-chain "external sends declare
 * an approval gate" precondition is enforced for EVERY vendored chain by
 * `workflow-chain-knowledge-inbox.test.ts` › "every vendored chain DECLARES an
 * approval-gate node…" (probe 8fw5g3-gap-cover-ki). The behavioural guarantee is
 * `workflow-chain-effect-reject-witness.test.ts`.
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

const PACKS: Record<string, string[]> = {
  'core.openwop.workflows.customer-onboarding': [
    'onboarding.welcome-sequence', 'onboarding.kickoff-checklist', 'onboarding.health-check-30d',
  ],
  'core.openwop.workflows.feedback-triage': [
    'feedback-triage.classify-and-route', 'feedback-triage.weekly-themes',
  ],
  'core.openwop.workflows.incident-postmortem': [
    'postmortem.draft-blameless', 'postmortem.action-items',
  ],
  'core.openwop.workflows.seo-content-ops': [
    'seo.keyword-brief', 'seo.draft-for-review',
  ],
  'core.openwop.workflows.meeting-ops': [
    'meeting.agenda-prep', 'meeting.notes-to-actions',
  ],
  'core.openwop.workflows.release-comms': [
    'release.notes-from-changelog', 'release.internal-announce',
  ],
  'core.openwop.workflows.sales-outreach': [
    'outreach.researched-firsttouch', 'outreach.quiet-thread-nudge',
  ],
  'core.openwop.workflows.weekly-digest': [
    'digest.topic-watch', 'digest.team-status',
  ],
};
const ALL_CHAINS = Object.values(PACKS).flat();

/** The portable node palette these packs draw from — every id is one this
 *  host ships (cross-checked against the existing passing packs). A chain
 *  referencing anything outside this set is a portability defect. */
const KNOWN_TYPEIDS = new Set([
  'core.trigger.webhook',
  'core.trigger.event',
  'core.trigger.form',
  'core.trigger.schedule',
  'core.ai.chatCompletion',
  'core.web.search',
  'core.chat.approvalGate',
  // WF-EM-1: the `falsy approved → noop` completion branch (ADR 0582 §10) —
  // without a second terminal-by-graph node that COMPLETES, a rejected run
  // reports `failed`, and a human declining is not a run failure.
  'core.flow.noop',
  'core.email.draft',
  'core.openwop.integration.email-send',
  'core.openwop.integration.slack-message',
  'feature.notifications.nodes.notify',
  'feature.crm.nodes.create-task',
]);

describe('gap packs — discovery', () => {
  it.each(Object.entries(PACKS))('%s loads all its chains', (pack, ids) => {
    for (const id of ids) {
      const entry = getChain(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.packName).toBe(pack);
    }
    expect(listChains().filter((c) => c.packName === pack)).toHaveLength(ids.length);
  });
});

describe('gap packs — every node uses a shipped typeId', () => {
  it.each(ALL_CHAINS)('%s references only the shipped-palette typeIds', (id) => {
    const chain = getChain(id)!.chain;
    for (const n of chain.dag.nodes) {
      expect(KNOWN_TYPEIDS.has(n.typeId), `${id}:${n.id} → ${n.typeId}`).toBe(true);
    }
  });
});

describe('gap packs — expansion (RFC 0013, frozen + validated)', () => {
  it.each(ALL_CHAINS)('%s expands to a frozen validated definition', (id) => {
    const chain = getChain(id)!.chain;
    const def = expandChain(chain, { params: {}, isTypeIdKnown: (t) => KNOWN_TYPEIDS.has(t) });
    expect(def.nodes).toHaveLength(chain.dag.nodes.length);
    expect(JSON.stringify(def.nodes), `${id} kept a param token`).not.toContain('{{params');
    expect(def.nodes.filter((n) => n.outputRole === 'primary')).toHaveLength(1);
  });
});
