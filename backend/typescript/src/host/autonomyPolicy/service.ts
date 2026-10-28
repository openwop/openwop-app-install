/**
 * ADR 0942 D9 — the one policy-change path both route families use
 * (campaign-orchestration for a campaign override, campaign-ops for a client
 * default). Features must not import each other, so the shared steps live here:
 * parse → compare against what is in force → let the caller authorize the
 * direction → save (CAS) → audit → tell the org's admins about a loosen.
 *
 * Authority stays with the caller (the routes own RBAC); this module only
 * computes the direction it must authorize.
 */
import { OpenwopError } from '../../types.js';
import { appendAudit } from '../auditChainService.js';
import { resolveNotificationRecipients } from '../approverResolution.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { cleanString } from '../boundedStrings.js';
import { ensureDigestJob } from './notify.js';
import { createLogger } from '../../observability/logger.js';
import { loosenedClasses } from './compare.js';
import { validatePresetId, validateRules } from './validate.js';
import {
  clearCampaignBindingOverride, getBinding, isInheritedBinding, previewPolicy, resolveEffectivePolicy, savePolicy,
  type EffectivePolicy, type PolicyInput,
} from './store.js';
import { ACTION_CLASSES, PRESET_IDS, REVIEW_STAGES, type ActionClass, type ActionRule, type AutonomyBinding, type Decision, type PresetId, type ResolvedPolicy, type ReviewStage } from './types.js';
import { findRule } from './resolve.js';
import { DEFAULT_APPROVER, presetPolicy } from './presets.js';

const log = createLogger('autonomy-policy');

/** The ADR 0941 D5 sub-toggle: an `extraToggleDefaults` entry of `campaign-orchestration`. */
export const AUTONOMY_TOGGLE = 'campaign-orchestration.autonomy';
export const AUTONOMY_TOGGLE_LABEL = 'Campaign autonomy policy';
const AUTONOMY_PARENT_TOGGLE = 'campaign-orchestration';

/** Whether new runs freeze a policy: the parent AND the sub-toggle ON for the
 *  tenant (ADR 0941 D5 AND-gate). OFF ⇒ no stamp ⇒ today's posture. One helper
 *  for both freezing contributors (campaign-bound and client-bound). */
export async function autonomyToggleOn(tenantId: string): Promise<boolean> {
  const { resolveOne } = await import('../featureToggles/service.js');
  return Boolean((await resolveOne(AUTONOMY_PARENT_TOGGLE, { tenantId }))?.enabled) && Boolean((await resolveOne(AUTONOMY_TOGGLE, { tenantId }))?.enabled);
}

const BODY_KEYS = ['preset', 'name', 'basePreset', 'rules', 'ifMatch'] as const;

/** Parse a PUT body: `{preset}` or `{name, basePreset?, rules}`, plus an optional `ifMatch`. */
export function parsePolicyBody(body: unknown): { input: PolicyInput; ifMatch?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new OpenwopError('validation_error', 'body: must be an object.', 400, { field: 'body' });
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!(BODY_KEYS as readonly string[]).includes(k)) throw new OpenwopError('validation_error', `${k}: unknown field.`, 400, { field: k });
  }
  if (b.ifMatch !== undefined && typeof b.ifMatch !== 'string') throw new OpenwopError('validation_error', 'ifMatch: must be a string.', 400, { field: 'ifMatch' });
  const ifMatch = b.ifMatch as string | undefined;
  if (b.preset !== undefined) {
    if (b.rules !== undefined || b.basePreset !== undefined || b.name !== undefined) {
      throw new OpenwopError('validation_error', 'preset: send a preset OR custom rules, not both.', 400, { field: 'preset' });
    }
    return { input: { kind: 'preset', preset: validatePresetId(b.preset) }, ...(ifMatch !== undefined ? { ifMatch } : {}) };
  }
  if (b.rules === undefined) throw new OpenwopError('validation_error', 'rules: send a preset or a rules array.', 400, { field: 'rules' });
  const rules = validateRules(b.rules);
  const basePreset = b.basePreset === undefined ? undefined : validatePresetId(b.basePreset, 'basePreset');
  const name = typeof b.name === 'string' ? cleanString(b.name, 120, '').trim() : '';
  if (!name) throw new OpenwopError('validation_error', 'name: a custom policy needs a name.', 400, { field: 'name' });
  return { input: { kind: 'custom', name, ...(basePreset ? { basePreset } : {}), rules }, ...(ifMatch !== undefined ? { ifMatch } : {}) };
}

/** `ifMatch` names the binding the caller loaded: `<policyId>@<version>`, or `none`. */
export function bindingEtag(b: AutonomyBinding | null): string {
  return b && !isInheritedBinding(b) ? `${b.policyId}@${b.version}` : 'none';
}

export interface PolicyChangeResult {
  binding: AutonomyBinding;
  policy: ResolvedPolicy;
  direction: 'tighten' | 'loosen';
  loosened: string[];
}

/**
 * Apply a policy change for a client default (`campaignId` absent) or a campaign
 * override. `compareTo` adds a second baseline the change must not be looser than
 * (a campaign override vs its client default, D9). `authorize(loosened)` is called
 * before anything is written; it throws to refuse.
 */
export async function applyPolicyChange(args: {
  tenantId: string; orgId: string; campaignId?: string;
  input: PolicyInput; ifMatch?: string; actor: string;
  authorize: (loosened: string[]) => Promise<void>;
}): Promise<PolicyChangeResult> {
  const { tenantId, orgId, campaignId, actor } = args;
  const current = await getBinding(tenantId, orgId, campaignId);
  if (args.ifMatch !== undefined && args.ifMatch !== bindingEtag(current)) {
    throw new OpenwopError('conflict', 'This autonomy policy changed since you loaded it. Reload and try again.', 409, { reason: 'binding_changed' });
  }
  const loosened = await loosenedAgainstBaselines(tenantId, orgId, campaignId, previewPolicy(args.input));
  await args.authorize(loosened);
  const saved = await savePolicy({ tenantId, orgId, ...(campaignId ? { campaignId } : {}), input: args.input, actor, expected: current });
  const direction = loosened.length > 0 ? 'loosen' : 'tighten';
  await appendAudit(tenantId, 'campaign.autonomy.policy-set', {
    orgId, ...(campaignId ? { campaignId } : {}),
    policyId: saved.policy.policyId, version: saved.policy.version, policyHash: saved.policy.hash,
    previous: current && !isInheritedBinding(current) ? { policyId: current.policyId, version: current.version } : null,
    direction, loosened, actor,
  });
  if (direction === 'loosen') notifyLoosen(tenantId, orgId, campaignId, loosened, actor);
  // D7 — a policy that batches notices daily needs the tenant's digest chain scheduled.
  if (usesDailyDigest(saved.policy)) {
    await ensureDigestJob(tenantId).catch((err) => log.warn('autonomy_digest_job_failed', { tenantId, error: err instanceof Error ? err.message : String(err) }));
  }
  return { ...saved, direction, loosened };
}

/** Remove a campaign override so the client default applies again. Same authority rule. */
export async function clearCampaignOverride(args: {
  tenantId: string; orgId: string; campaignId: string; ifMatch?: string; actor: string;
  authorize: (loosened: string[]) => Promise<void>;
}): Promise<{ removed: boolean; direction: 'tighten' | 'loosen'; loosened: string[] }> {
  const { tenantId, orgId, campaignId, actor } = args;
  const current = await getBinding(tenantId, orgId, campaignId);
  if (args.ifMatch !== undefined && args.ifMatch !== bindingEtag(current)) {
    throw new OpenwopError('conflict', 'This autonomy policy changed since you loaded it. Reload and try again.', 409, { reason: 'binding_changed' });
  }
  if (!current || isInheritedBinding(current)) return { removed: false, direction: 'tighten', loosened: [] };
  const clientDefault = await resolveEffectivePolicy(tenantId, orgId);
  const inForce = await resolveEffectivePolicy(tenantId, orgId, campaignId);
  const loosened = loosenedClasses(clientDefault.policy, inForce.policy);
  await args.authorize(loosened);
  const removed = await clearCampaignBindingOverride(current, actor);
  const direction = loosened.length > 0 ? 'loosen' : 'tighten';
  if (removed) {
    await appendAudit(tenantId, 'campaign.autonomy.policy-cleared', {
      orgId, campaignId, previous: { policyId: current.policyId, version: current.version }, direction, loosened, actor,
    });
    if (direction === 'loosen') notifyLoosen(tenantId, orgId, campaignId, loosened, actor);
  }
  return { removed, direction, loosened };
}

/**
 * D9: the classes `next` is looser on, against the policy in force for this scope
 * and, for a campaign override, against the client default as well ("a campaign
 * override cannot be looser than the client default unless an org admin makes it").
 */
async function loosenedAgainstBaselines(
  tenantId: string, orgId: string, campaignId: string | undefined,
  next: ReturnType<typeof previewPolicy>,
): Promise<string[]> {
  const baselines: EffectivePolicy[] = [await resolveEffectivePolicy(tenantId, orgId, campaignId)];
  if (campaignId) baselines.push(await resolveEffectivePolicy(tenantId, orgId));
  const out = new Set<string>();
  for (const b of baselines) for (const c of loosenedClasses(next, b.policy)) out.add(c);
  return [...out].sort();
}

/**
 * D9: a loosen notifies the client org's admins. Addressed only: when the
 * recipients cannot be resolved this does NOT broadcast to the whole workspace,
 * because a client's policy is that client's business. Best-effort; the audit
 * entry is the record.
 */
function notifyLoosen(tenantId: string, orgId: string, campaignId: string | undefined, loosened: string[], actor: string): void {
  void (async () => {
    const recipients = await resolveNotificationRecipients({ approverRoleRefs: ['owner', 'admin'] }, { tenantId, orgId });
    if (!recipients?.length) { log.info('autonomy_loosen_notify_skipped', { orgId, reason: 'no_addressable_admins' }); return; }
    const scope = campaignId ? 'a campaign' : 'this client';
    await getNotificationEmitter().emitMany(recipients.filter((r) => r !== actor).map((recipientUserId) => ({
      tenantId,
      recipientUserId,
      type: 'campaign.autonomy.loosened',
      priority: 'normal' as const,
      title: 'Campaign autonomy policy loosened',
      message: `Fewer steps need sign-off for ${scope}: ${loosened.slice(0, 6).join(', ')}${loosened.length > 6 ? '…' : ''}.`,
      actionUrl: '/campaign-studio',
      metadata: { kind: 'campaign.autonomy.loosened', orgId, ...(campaignId ? { campaignId } : {}), loosened },
    })));
  })().catch((err) => log.warn('autonomy_loosen_notify_failed', { orgId, error: err instanceof Error ? err.message : String(err) }));
}

function usesDailyDigest(policy: ResolvedPolicy): boolean {
  const daily = (d: Decision): boolean => (d.outcome === 'notify-after' || d.outcome === 'approve') && d.notify?.digest === 'daily';
  return policy.rules.some((r) => daily(r.default) || (r.escalations ?? []).some((e) => daily(e.then)));
}

/** Per class (and per review stage), the rule that would decide it and where it came from. */
function effectiveRules(policy: ResolvedPolicy): Array<{ actionClass: ActionClass; stage?: ReviewStage; rule: ActionRule; from: 'policy' | 'preset' | 'fallback' }> {
  const out: Array<{ actionClass: ActionClass; stage?: ReviewStage; rule: ActionRule; from: 'policy' | 'preset' | 'fallback' }> = [];
  for (const actionClass of ACTION_CLASSES) {
    const stages: Array<ReviewStage | undefined> = actionClass === 'creative.review' ? [...REVIEW_STAGES] : [undefined];
    for (const stage of stages) {
      const { rule, from } = findRule(policy, actionClass, stage);
      out.push({
        actionClass, ...(stage ? { stage } : {}),
        rule: rule ?? { actionClass, default: { outcome: 'approve', approver: { ...DEFAULT_APPROVER, roleRefs: [...(DEFAULT_APPROVER.roleRefs ?? [])] } } },
        from: rule ? from === 'none' ? 'fallback' : from : 'fallback',
      });
    }
  }
  return out;
}

/** The read model both GET routes return (and the Strategist's `get-autonomy` projects). */
export interface PolicyReadModel {
  source: string;
  dangling: boolean;
  etag: string;
  policy: ResolvedPolicy;
  actionClasses: ActionClass[];
  effective: ReturnType<typeof effectiveRules>;
  presets: Array<{ id: PresetId; name: string }>;
  clientDefault?: { source: string; policyId: string; version: number; name: string; hash: string };
}

export async function describePolicy(tenantId: string, orgId: string, campaignId?: string): Promise<PolicyReadModel> {
  const effective = await resolveEffectivePolicy(tenantId, orgId, campaignId);
  const out: PolicyReadModel = {
    source: effective.source,
    dangling: effective.dangling,
    etag: bindingEtag(await getBinding(tenantId, orgId, campaignId)),
    policy: effective.policy,
    // ADR 0942 P5 review — the SPA renders these and owns only labels: the class
    // vocabulary (D1) and each class's EFFECTIVE rule (own rule, else the base
    // preset's, else the approve fallback) are never re-derived client-side.
    actionClasses: [...ACTION_CLASSES],
    effective: effectiveRules(effective.policy),
    presets: PRESET_IDS.map((id) => ({ id, name: presetPolicy(id).name })),
  };
  if (campaignId) {
    const client = await resolveEffectivePolicy(tenantId, orgId);
    out.clientDefault = { source: client.source, policyId: client.policy.policyId, version: client.policy.version, name: client.policy.name, hash: client.policy.hash };
  }
  return out;
}
