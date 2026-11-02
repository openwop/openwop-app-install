/**
 * ADR 0942 P0 — the pure resolver (D3), the closed-world validator (D2, D10.1),
 * the presets and the strictness comparison (D9). No HTTP; the routes have
 * their own test (adr0942-p0-routes.test.ts).
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - drop the "escalation at least as strict as default" check in validateRule → red
 *    ('refuses an escalation that loosens');
 *  - make `holds()` treat a missing fact as false → red ('a missing fact escalates');
 *  - let `raise()` replace on a severity tie → red ('a tie keeps the policy approvers');
 *  - make `ruleAtLeastAsStrict` return true → red ('dropping an escalation is a loosen');
 *  - drop the client-floor external-class guard → red ('a preview client still generates').
 * Every refusal is asserted by the exact `details.field` path `fail()` writes
 * (`validate.ts`), not only a message fragment, so a neighbouring check that
 * refuses the same fixture cannot stand in for the one named. The two ladder
 * lists are written out by hand from `presets.ts` (autopilot vs guarded, and an
 * autopilot base vs review-everything), never computed by the comparison under
 * test.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES, FALLBACK_PRESET, NEW_CLIENT_PRESET, isAtLeastAsStrict, loosenedClasses, presetPolicy, presetRules,
  resolveCampaignAction, validateRules,
  type ActionRule, type ResolvedPolicy,
} from '../src/host/autonomyPolicy/index.js';
import { OpenwopError } from '../src/types.js';

const approveAdmins = { outcome: 'approve', approver: { roleRefs: ['admin'], requiredApprovals: 1, delegation: 'allowed' } } as const;
const custom = (rules: ActionRule[], basePreset?: ResolvedPolicy['basePreset']): ResolvedPolicy => ({
  policyId: 'apol_test', version: 1, name: 'test', rules, ...(basePreset ? { basePreset } : {}), hash: 'h',
});

function expectInvalid(rules: unknown, fragment: string, field: string): void {
  try {
    validateRules(rules);
  } catch (err) {
    if (!(err instanceof OpenwopError)) throw err;
    expect(err.code).toBe('validation_error');
    expect(err.message.startsWith(`${field}: `), err.message).toBe(true);
    expect(err.message).toContain(fragment);
    expect(err.details).toEqual({ field });
    return;
  }
  throw new Error(`expected validateRules to refuse (${fragment})`);
}

describe('ADR 0942 D2 — presets', () => {
  it('every preset covers all twenty classes and validates', () => {
    expect(ACTION_CLASSES).toHaveLength(20);
    for (const id of ['review-everything@1', 'guarded@1', 'autopilot@1'] as const) {
      const rules = presetRules(id);
      expect(validateRules(JSON.parse(JSON.stringify(rules)))).toEqual(rules);
      for (const c of ACTION_CLASSES) expect(rules.some((r) => r.actionClass === c), `${id} ${c}`).toBe(true);
    }
  });

  it('the seven review-added classes approve in every preset, and email.resume-sending can never be auto', () => {
    const seven = ['lead.grade-adjust', 'journey.publish', 'email.resume-sending', 'report.publish', 'asset.accept-vendor', 'vendor.engage', 'playbook.rollout'] as const;
    for (const id of ['review-everything@1', 'guarded@1', 'autopilot@1'] as const) {
      for (const c of seven) {
        const r = resolveCampaignAction({ policy: presetPolicy(id), actionClass: c, facts: {} });
        expect(r.decision.outcome, `${id} ${c}`).toBe('approve');
      }
    }
    expectInvalid([{ actionClass: 'email.resume-sending', default: { outcome: 'auto' } }], 'never be looser than approve', 'rules[0].default.outcome');
  });

  it('new clients bind to Guarded; the fallback is Review everything', () => {
    expect(NEW_CLIENT_PRESET).toBe('guarded@1');
    expect(FALLBACK_PRESET).toBe('review-everything@1');
    expect(isAtLeastAsStrict(presetPolicy('review-everything@1'), presetPolicy('guarded@1'))).toBe(true);
    expect(isAtLeastAsStrict(presetPolicy('guarded@1'), presetPolicy('review-everything@1'))).toBe(false);
    expect(isAtLeastAsStrict(presetPolicy('autopilot@1'), presetPolicy('guarded@1'))).toBe(false);
  });

  const calm = { audienceSize: 10, regulatedCategory: false, findingsHigh: 0, firstForDestination: false };
  it('Guarded: a budget cut under $500 is auto; any increase or $500+ asks', () => {
    const g = presetPolicy('guarded@1');
    expect(resolveCampaignAction({ policy: g, actionClass: 'ads.budget', facts: { ...calm, spendDeltaPct: -5, spendMinor: 10_000 } }).decision.outcome).toBe('auto');
    expect(resolveCampaignAction({ policy: g, actionClass: 'ads.budget', facts: { ...calm, spendDeltaPct: 5, spendMinor: 10_000 } }).ruleId).toBe('ads.budget#esc0');
    expect(resolveCampaignAction({ policy: g, actionClass: 'ads.budget', facts: { ...calm, spendDeltaPct: -5, spendMinor: 50_000 } }).decision.outcome).toBe('approve');
  });

  it('the presets are a monotonic ladder: review-everything ≥ guarded ≥ autopilot, per class and stage', () => {
    expect(loosenedClasses(presetPolicy('guarded@1'), presetPolicy('autopilot@1'))).toEqual([]);
    expect(loosenedClasses(presetPolicy('review-everything@1'), presetPolicy('guarded@1'))).toEqual([]);
    // Read off presets.ts: guarded approves plan.approve, creative.review (every stage), email.campaign-send,
    // social.post and experiment.promote where autopilot notifies or autos, and adds the $500 escalation to ads.budget.
    expect(loosenedClasses(presetPolicy('autopilot@1'), presetPolicy('guarded@1'))).toEqual([
      'plan.approve', 'creative.review:internal', 'creative.review:compliance', 'ads.budget', 'email.campaign-send', 'social.post', 'experiment.promote',
    ]);
  });

  it('Autopilot never launches or raises spend without approval (owner decision 4)', () => {
    const a = presetPolicy('autopilot@1');
    expect(resolveCampaignAction({ policy: a, actionClass: 'ads.launch', facts: { spendMinor: 100 } }).decision.outcome).toBe('approve');
    expect(resolveCampaignAction({ policy: a, actionClass: 'ads.budget', facts: { spendDeltaPct: 5, spendMinor: 100, audienceSize: 10, regulatedCategory: false, findingsHigh: 0, firstForDestination: false } }).decision.outcome).toBe('approve');
    expect(resolveCampaignAction({ policy: a, actionClass: 'ads.budget', facts: { spendDeltaPct: -20, spendMinor: 100, audienceSize: 10, regulatedCategory: false, findingsHigh: 0, firstForDestination: false } }).decision.outcome).toBe('auto');
    expect(resolveCampaignAction({ policy: a, actionClass: 'creative.review', stage: 'client', facts: {} }).decision.outcome).toBe('approve');
  });
});

describe('ADR 0942 D3 — the resolver', () => {
  const autoAll = custom(ACTION_CLASSES.filter((c) => c !== 'email.resume-sending').map((c) => ({ actionClass: c, default: { outcome: 'auto' } })));

  it('null policy is the fail-closed fallback', () => {
    const r = resolveCampaignAction({ policy: null, actionClass: 'email.campaign-send', facts: {} });
    expect(r.decision.outcome).toBe('approve');
    expect(r.reasons).toContain('policy_fallback');
    expect(r.policyId).toBe('preset:review-everything');
  });

  it('a missing fact escalates (unknown fails toward review)', () => {
    const r = resolveCampaignAction({ policy: presetPolicy('guarded@1'), actionClass: 'ads.budget', facts: {} });
    expect(r.decision.outcome).toBe('approve');
    expect(r.reasons).toContain('fact_missing:spendDeltaPct');
  });

  it('floors are not configurable: content block, client not live, vendor, fidelity', () => {
    const base = { policy: autoAll, actionClass: 'content.publish' as const, facts: {} };
    expect(resolveCampaignAction({ ...base, floors: { contentRulesBlock: true } }).decision).toEqual({ outcome: 'blocked', reason: 'content_rules_block' });
    expect(resolveCampaignAction({ ...base, floors: { client: { mode: 'preview', status: 'active' } } }).layer).toBe('floor');
    expect(resolveCampaignAction({ ...base, floors: { client: 'missing' } }).decision.outcome).toBe('blocked');
    expect(resolveCampaignAction({ ...base, floors: { vendorUnconfigured: true } }).decision).toEqual({ outcome: 'blocked', reason: 'vendor_unconfigured' });
    expect(resolveCampaignAction({ ...base, floors: { fidelity: 'needs_review' } }).decision.outcome).toBe('approve');
    expect(resolveCampaignAction({ ...base, floors: { fidelity: 'fail' } }).decision.outcome).toBe('blocked');
  });

  it('a preview client still generates (the client floor binds external effects only)', () => {
    const r = resolveCampaignAction({ policy: autoAll, actionClass: 'creative.generate', facts: {}, floors: { client: { mode: 'preview', status: 'active' } } });
    expect(r.decision.outcome).toBe('auto');
  });

  it('MCP origin and an attended fork floor every external class at approve, never the internal ones', () => {
    for (const floors of [{ mcpOrigin: true }, { forkPosture: 'attended' as const }]) {
      expect(resolveCampaignAction({ policy: autoAll, actionClass: 'email.campaign-send', facts: {}, floors }).decision.outcome).toBe('approve');
      expect(resolveCampaignAction({ policy: autoAll, actionClass: 'plan.approve', facts: {}, floors }).decision.outcome).toBe('auto');
    }
  });

  it('the tenant ceiling and the agent only tighten', () => {
    expect(resolveCampaignAction({ policy: autoAll, actionClass: 'ads.budget', facts: {}, ceiling: 'approve' }).layer).toBe('ceiling');
    expect(resolveCampaignAction({ policy: autoAll, actionClass: 'ads.budget', facts: {}, ceiling: 'blocked' }).decision.outcome).toBe('blocked');
    expect(resolveCampaignAction({ policy: autoAll, actionClass: 'ads.budget', facts: {}, agent: { never: true } }).decision).toEqual({ outcome: 'blocked', reason: 'agent_never' });
    expect(resolveCampaignAction({ policy: autoAll, actionClass: 'ads.budget', facts: {}, agent: { hitl: true } }).layer).toBe('agent');
    // A blocked policy is not loosened by a ceiling of approve.
    const blockedPolicy = custom([{ actionClass: 'ads.budget', default: { outcome: 'blocked', reason: 'no budget moves' } }]);
    expect(resolveCampaignAction({ policy: blockedPolicy, actionClass: 'ads.budget', facts: {}, ceiling: 'approve' }).decision.outcome).toBe('blocked');
  });

  it('a tie keeps the policy approvers (the floor does not replace them with the default)', () => {
    const p = custom([{ actionClass: 'ads.launch', default: { outcome: 'approve', approver: { roleRefs: ['media-lead'], requiredApprovals: 2, delegation: 'none' } } }]);
    const r = resolveCampaignAction({ policy: p, actionClass: 'ads.launch', facts: {}, floors: { mcpOrigin: true } });
    expect(r.layer).toBe('policy');
    expect(r.decision).toMatchObject({ outcome: 'approve', approver: { roleRefs: ['media-lead'], requiredApprovals: 2 } });
  });

  it('the live overlay blocks a paused campaign\'s external effects', () => {
    const r = resolveCampaignAction({ policy: autoAll, actionClass: 'social.post', facts: {}, live: { campaignStatus: 'paused' } });
    expect(r.decision).toEqual({ outcome: 'blocked', reason: 'campaign_paused' });
    expect(resolveCampaignAction({ policy: autoAll, actionClass: 'social.post', facts: {}, live: { emergencyHalt: true } }).layer).toBe('live');
  });

  it('a missing class falls back to the base preset, then to approve', () => {
    const p = custom([{ actionClass: 'ads.publish', default: { outcome: 'auto' } }], 'guarded@1');
    expect(resolveCampaignAction({ policy: p, actionClass: 'lead.contact', facts: {} }).ruleId).toMatch(/^lead\.contact#esc0#preset$/);
    const bare = custom([{ actionClass: 'ads.publish', default: { outcome: 'auto' } }]);
    const r = resolveCampaignAction({ policy: bare, actionClass: 'lead.contact', facts: {} });
    expect(r.ruleId).toBe('lead.contact#fallback');
    expect(r.decision.outcome).toBe('approve');
  });
});

describe('ADR 0942 D2/D10.1 — the closed-world validator', () => {
  it('refuses an escalation that loosens', () => {
    expectInvalid([{ actionClass: 'ads.budget', default: approveAdmins, escalations: [{ when: [{ fact: 'spendMinor', op: '<', value: 100 }], then: { outcome: 'auto' } }] }], 'at least as strict', 'rules[0].escalations[0].then.outcome');
  });
  it('refuses unknown classes, facts, ops, keys, and ops illegal for a fact type', () => {
    expectInvalid([{ actionClass: 'ads.nuke', default: { outcome: 'auto' } }], 'must be one of', 'rules[0].actionClass');
    expectInvalid([{ actionClass: 'ads.budget', default: { outcome: 'auto' }, extra: 1 }], 'unknown field', 'rules[0].extra');
    expectInvalid([{ actionClass: 'ads.budget', default: approveAdmins, escalations: [{ when: [{ fact: 'mood', op: '>', value: 1 }], then: approveAdmins }] }], 'must be one of', 'rules[0].escalations[0].when[0].fact');
    expectInvalid([{ actionClass: 'ads.budget', default: approveAdmins, escalations: [{ when: [{ fact: 'regulatedCategory', op: '>', value: 1 }], then: approveAdmins }] }], 'use ==', 'rules[0].escalations[0].when[0].op');
    expectInvalid([{ actionClass: 'ads.budget', default: approveAdmins, escalations: [{ when: [{ fact: 'spendMinor', op: 'in', value: ['a'] }], then: approveAdmins }] }], 'is a number', 'rules[0].escalations[0].when[0].op');
    expectInvalid([{ actionClass: 'ads.budget', default: approveAdmins, escalations: [{ when: [{ fact: 'spendMinor', op: '>', value: '5' }], then: approveAdmins }] }], 'compares against a number', 'rules[0].escalations[0].when[0].value');
  });
  it('an approval must name roles or groups; subjects alone are refused', () => {
    expectInvalid([{ actionClass: 'ads.budget', default: { outcome: 'approve', approver: { subjectRefs: ['u1'], requiredApprovals: 1, delegation: 'allowed' } } }], 'D10.1', 'rules[0].default.approver');
  });
  it('client approvers only on change sets, and a mixed spec needs a per-party quorum', () => {
    const client = { clientApprover: true, requiredApprovals: 1, delegation: 'allowed' };
    expectInvalid([{ actionClass: 'ads.budget', default: { outcome: 'approve', approver: client } }], 'Q4', 'rules[0].default.approver.clientApprover');
    expect(() => validateRules([{ actionClass: 'campaign.change-set.apply', default: { outcome: 'approve', approver: client } }])).not.toThrow();
    expectInvalid([{ actionClass: 'campaign.change-set.apply', default: { outcome: 'approve', approver: { ...client, roleRefs: ['admin'], requiredApprovals: 2 } } }], 'per-party quorum', 'rules[0].default.approver.perParty');
    expect(() => validateRules([{ actionClass: 'campaign.change-set.apply', default: { outcome: 'approve', approver: {
      ...client, roleRefs: ['admin'], requiredApprovals: 2,
      perParty: [{ party: 'agency', refs: 'roleRefs', min: 1 }, { party: 'client', refs: 'clientApprover', min: 1 }],
    } } }])).not.toThrow();
  });
  it('a veto window is at least an hour; SLA rungs come in order; one rule per class and stage', () => {
    expectInvalid([{ actionClass: 'content.publish', default: { outcome: 'notify-after', notify: { roleRefs: ['admin'], channels: ['inbox'], digest: 'immediate', vetoWindowMs: 60_000 } } }], 'between 3600000', 'rules[0].default.notify.vetoWindowMs');
    expectInvalid([{ actionClass: 'ads.budget', default: { outcome: 'approve', approver: { roleRefs: ['admin'], requiredApprovals: 1, delegation: 'allowed', sla: { remindAfterMs: 7_200_000, escalateAfterMs: 3_600_000 } } } }], 'in that order', 'rules[0].default.approver.sla');
    expectInvalid([{ actionClass: 'ads.budget', default: { outcome: 'auto' } }, { actionClass: 'ads.budget', default: approveAdmins }], 'a second rule', 'rules[1]');
    expectInvalid([{ actionClass: 'ads.budget', stage: 'client', default: { outcome: 'auto' } }], 'only creative.review', 'rules[0].stage');
  });
});

describe('ADR 0942 D9 — strictness comparison', () => {
  const guarded = presetPolicy('guarded@1');
  it('identical is not a loosen; raising requiredApprovals is a tighten; dropping an escalation is a loosen', () => {
    expect(loosenedClasses(guarded, guarded)).toEqual([]);
    const two = custom([{ actionClass: 'ads.launch', default: { outcome: 'approve', approver: { roleRefs: ['owner', 'admin'], requiredApprovals: 2, delegation: 'allowed' } } }], 'guarded@1');
    expect(loosenedClasses(two, guarded)).toEqual([]);
    const content = guarded.rules.find((r) => r.actionClass === 'content.publish');
    if (!content) throw new Error('guarded has no content.publish rule');
    const noEsc = custom([{ actionClass: 'content.publish', default: content.default }], 'guarded@1');
    expect(loosenedClasses(noEsc, guarded)).toEqual(['content.publish']);
  });
  it('adding an escalation that tightens is a tighten', () => {
    const base = guarded.rules.find((r) => r.actionClass === 'lead.contact');
    if (!base) throw new Error('guarded has no lead.contact rule');
    const p = custom([{ ...base, escalations: [...(base.escalations ?? []), { when: [{ fact: 'audienceSize', op: '>=', value: 1000 }], then: { outcome: 'approve', approver: { roleRefs: ['admin'], requiredApprovals: 1, delegation: 'allowed' } } }] }], 'guarded@1');
    expect(loosenedClasses(p, guarded)).toEqual([]);
  });
  it('changing who approves is a loosen (cannot be proven safe)', () => {
    const p = custom([{ actionClass: 'ads.launch', default: { outcome: 'approve', approver: { roleRefs: ['editor'], requiredApprovals: 1, delegation: 'allowed' } } }], 'guarded@1');
    expect(loosenedClasses(p, guarded)).toEqual(['ads.launch']);
  });
  it('dropping a class compares by what it falls back to', () => {
    const rev = presetPolicy('review-everything@1');
    // A rules set naming only one class, with no base preset, falls back to approve(admins) everywhere else.
    const p = custom([{ actionClass: 'creative.generate', default: { outcome: 'auto' } }]);
    expect(loosenedClasses(p, rev)).toEqual([]);
    const withAutopilotBase = custom([{ actionClass: 'creative.generate', default: { outcome: 'auto' } }], 'autopilot@1');
    // Read off presets.ts: every class autopilot does not approve, i.e. all but creative.generate (auto in both),
    // ads.launch, creative.review's stage-less and client asks, and the seven always-approve classes.
    expect(loosenedClasses(withAutopilotBase, rev)).toEqual([
      'plan.approve', 'creative.review:internal', 'creative.review:compliance', 'content.publish', 'ads.publish', 'ads.budget',
      'email.campaign-send', 'sms.send', 'social.post', 'experiment.promote', 'lead.contact', 'campaign.change-set.apply',
    ]);
  });
});
