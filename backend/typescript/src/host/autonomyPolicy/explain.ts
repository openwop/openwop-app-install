/**
 * ADR 0942 P6 — the model-facing explanation of a review policy.
 *
 * `projectPolicyForModel` turns the ONE read model (`describePolicy`, the same
 * document the review-policy panel renders) into a compact shape for the
 * Strategist's `get-autonomy` tool. It re-derives nothing: every step's rule is
 * the `effective` row the resolver itself would find.
 *
 * `ALWAYS_APPLIES` is the one backend list of what holds whatever a policy says
 * (D3 layers 1, 2, 3 and 5, plus D10). It is keyed by the layer rule ids that
 * `resolve.ts` raises, so a layer added there without a line here fails
 * `adr0942-p6-strategist-tool.test.ts`.
 */
import type { ActionRule, Condition, Decision } from './types.js';

export const ALWAYS_APPLIES: Readonly<Record<string, string>> = {
  'ceiling:governance': "The workspace's spend limits and approval settings apply on top of the policy. Starting paid ad delivery always needs a person's single-use launch approval.",
  'floor:client': 'A client in preview, or paused, cannot send, post or spend.',
  'floor:vendor': 'A step whose vendor connection is not set up is blocked.',
  'floor:content-rules': "Content that breaks the client's content rules is blocked.",
  'floor:fidelity': 'Creative that fails the brand check is blocked; creative that needs review asks for approval.',
  'floor:mcp-origin': 'A step started by an outside agent (MCP) always needs a person to approve it.',
  'floor:fork-posture': 'A branch copy or a re-run asks for approval again before it reaches people or spends money.',
  'agent:never': 'An agent\'s own "never do this" rules block the step.',
  'agent:hitl': 'An agent set to need a human asks for approval.',
  'live:campaign-status': 'A paused or stopped campaign does not send, post or spend.',
  'live:halt': 'An emergency halt stops every external step.',
  'self-approval': 'Nobody can approve their own request.',
};

type Step = {
  step: string;
  stage?: string;
  outcome: Decision['outcome'];
  approvers?: { roles: string[]; required: number; clientApprover?: boolean };
  notify?: { roles: string[]; digest: string };
  blockedReason?: string;
  asksWhen?: Array<{ when: Condition[]; then: Decision['outcome'] }>;
};

function decisionFacts(d: Decision): Pick<Step, 'approvers' | 'notify' | 'blockedReason'> {
  if (d.outcome === 'approve') {
    return { approvers: { roles: [...(d.approver.roleRefs ?? []), ...(d.approver.groupRefs ?? [])], required: d.approver.requiredApprovals, ...(d.approver.clientApprover ? { clientApprover: true } : {}) } };
  }
  if (d.outcome === 'notify-after') return { notify: { roles: [...(d.notify.roleRefs ?? [])], digest: d.notify.digest } };
  if (d.outcome === 'blocked') return { blockedReason: d.reason };
  return {};
}

export interface ModelPolicyView {
  campaignId: string;
  source: string;
  policy: { name: string; kind: 'preset' | 'custom'; preset?: string };
  steps: Step[];
  unknownFactsAsk: true;
  alwaysApplies: string[];
}

/** Project the `describePolicy` read model for the model. */
export function projectPolicyForModel(campaignId: string, view: {
  source: string;
  policy: { policyId: string; version: number; name: string };
  effective: Array<{ actionClass: string; stage?: string; rule: ActionRule }>;
}): ModelPolicyView {
  const preset = /^preset:(.+)$/.exec(view.policy.policyId)?.[1];
  return {
    campaignId,
    source: view.source,
    policy: { name: view.policy.name, kind: preset ? 'preset' : 'custom', ...(preset ? { preset: `${preset}@${view.policy.version}` } : {}) },
    steps: view.effective.map((r) => ({
      step: r.actionClass,
      ...(r.stage ? { stage: r.stage } : {}),
      outcome: r.rule.default.outcome,
      ...decisionFacts(r.rule.default),
      ...(r.rule.escalations?.length ? { asksWhen: r.rule.escalations.map((e) => ({ when: e.when, then: e.then.outcome })) } : {}),
    })),
    unknownFactsAsk: true,
    alwaysApplies: Object.values(ALWAYS_APPLIES),
  };
}
