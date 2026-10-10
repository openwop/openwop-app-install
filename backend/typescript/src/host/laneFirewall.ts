/**
 * ADR 0834 D1 — the ONE place a tool-executing lane builds its capability firewall.
 *
 * Before this, four lanes (chat, run, dispatch route, voice) each repeated the five
 * posture reads and an option list by hand, and a fifth (the anonymous widget) built
 * none at all. They had already drifted: one lane passed the egress flag and two did
 * not, one passed approvals, and only the chat lane wrote decisions to the governance
 * log — so a tenant reviewing `shadow` would-blocks before flipping to `enforce` never
 * saw run, dispatch, voice or anonymous traffic.
 *
 * A lane now says WHO it is and what the human pre-authorized; this module reads the
 * tenant posture + the platform floor, derives the safe-mode baseline (the hand-kept
 * name set ∪ every tool that DECLARES `safeModeApproval`, ADR 0834 D4), and wires
 * decision + shadow logging with `detail.lane`. `buildFirewallHook` stays the pure
 * evaluator; `test/firewall-lane-census.test.ts` pins this file as its only production
 * caller.
 *
 * Lives in host/ (not the feature) because it reads the agent-tool registry, which the
 * feature must not import (the feature registry import order — ADR 0833's lesson).
 *
 * @see docs/adr/0834-capability-firewall-exit-decision.md
 */
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS, type FirewallHook } from '../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules } from '../features/capability-firewall/ruleStore.js';
import type { CapabilityRule, FirewallMode } from '../features/capability-firewall/types.js';
import { declaredSafeModeApprovals } from './agentToolProvider.js';
import { recordGovernanceDecision } from './governanceDecisionLog.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.laneFirewall');

export type FirewallLane = 'chat' | 'run' | 'dispatch' | 'voice' | 'anon';

export interface LaneFirewallInput {
  tenantId: string;
  lane: FirewallLane;
  /** The user's own `bypass`, ALREADY authorized by the caller (ADR 0834 D3). It skips
   *  only `baseline` asks (D2). Lanes with no interactive human pass false/absent. */
  bypass?: boolean;
  /** Ledger approvals raised by a `policy` ask (satisfy any ask). */
  approvedTools?: ReadonlySet<string>;
  /** Approvals that answered only a `baseline` ask (ledger rows, voice's one-shot card). */
  approvedBaselineTools?: ReadonlySet<string>;
  /** The governance-log `resource` (a conversation id, run id, session). */
  resource?: string;
  /** Dedupe shadow would-blocks per run/session rather than per hook (voice builds a
   *  hook per call). Absent ⇒ per hook. */
  dedupeKey?: string;
}

export interface LaneFirewall {
  hook: FirewallHook;
  /** The resolved posture, for the run.metadata provenance stamp (chat lane). */
  posture: { rules: CapabilityRule[]; mode: FirewallMode; defaultDenyVerdict: 'deny' | 'require-approval'; platformRules: CapabilityRule[] };
}

/** The safe-mode baseline: the hand-kept name set ∪ declared tools, with per-tool reasons. */
export function safeModeBaseline(): { tools: Set<string>; reasons: Map<string, string> } {
  const tools = new Set<string>(SENSITIVE_APPROVAL_TOOLS);
  const reasons = new Map<string, string>();
  for (const [id, reason] of declaredSafeModeApprovals()) {
    tools.add(id);
    if (reason) reasons.set(id, reason);
  }
  return { tools, reasons };
}

// Shadow would-block dedupe, keyed by run/session. Bounded: a lane that never ends
// (a long voice session) keeps its key; the map is cleared wholesale past the cap,
// which at worst logs one would-block twice.
const SHADOW_DEDUPE_CAP = 2000;
const shadowSeen = new Map<string, Set<string>>();
function shadowSetFor(key: string | undefined): Set<string> | undefined {
  if (!key) return undefined;
  let s = shadowSeen.get(key);
  if (!s) {
    if (shadowSeen.size >= SHADOW_DEDUPE_CAP) shadowSeen.clear();
    s = new Set();
    shadowSeen.set(key, s);
  }
  return s;
}

export async function buildLaneFirewall(input: LaneFirewallInput): Promise<LaneFirewall> {
  const { tenantId, lane } = input;
  const [rules, unknownToolPolicy, mode, defaultDenyVerdict, platformRules] = await Promise.all([
    getCapabilityRules(tenantId),
    getUnknownToolPolicy(tenantId),
    getFirewallMode(tenantId),
    getDefaultDenyVerdict(tenantId),
    getPlatformRules(),
  ]);
  const baseline = safeModeBaseline();
  const shadowLogged = shadowSetFor(input.dedupeKey ? `${tenantId}:${lane}:${input.dedupeKey}` : undefined);
  const hook = buildFirewallHook({
    rules, unknownToolPolicy, mode, defaultDenyVerdict, platformRules,
    requireApprovalTools: baseline.tools,
    baselineReasons: baseline.reasons,
    gateHostMediatedEgress: true, // ADR 0610 D5 — explicit on every lane (ADR 0724 made it implied)
    bypassApproval: input.bypass === true,
    ...(input.approvedTools ? { approvedTools: input.approvedTools } : {}),
    ...(input.approvedBaselineTools ? { approvedBaselineTools: input.approvedBaselineTools } : {}),
    ...(shadowLogged ? { shadowLogged } : {}),
    onUnclassified: (toolName) => log.debug('firewall_unclassified_tool', { toolName, unknownToolPolicy, lane }),
    // ADR 0397 Phase 1 / ADR 0834 D1 — every narrowing verdict, every lane. Fire-and-
    // forget (recordGovernanceDecision swallows its own errors). Both verdicts kept the
    // call from running this turn, so the coarse outcome is `deny`; `detail.decision`
    // carries the tri-state and `detail.origin` who imposed an ask (D2).
    onDecision: (toolName, v) => {
      // The tool loop already writes this operator line for the lanes it runs (CGOV-6);
      // voice evaluates outside the loop, so it writes its own.
      if (lane === 'voice') log.info('capability_firewall_blocked', { lane, toolName, decision: v.decision, reason: v.reason, origin: v.origin });
      void recordGovernanceDecision({
        tenantId, kind: 'firewall', outcome: 'deny',
        ...(v.reason ? { reason: v.reason } : {}),
        ...(input.resource ? { resource: input.resource } : {}),
        detail: { toolName, decision: v.decision, lane, ...(v.ruleId ? { ruleId: v.ruleId } : {}), ...(v.origin ? { origin: v.origin } : {}) },
      });
    },
    onShadowWouldBlock: (toolName, wouldBe) => {
      void recordGovernanceDecision({
        tenantId, kind: 'firewall',
        outcome: 'allow', // shadow APPLIED allow — the tool ran; this is a would-block record.
        reason: 'shadow (log-only): would block under enforce',
        ...(input.resource ? { resource: input.resource } : {}),
        detail: { toolName, decision: wouldBe, shadow: true, wouldBlock: wouldBe, lane },
      });
    },
  });
  return { hook, posture: { rules, mode, defaultDenyVerdict, platformRules } };
}
