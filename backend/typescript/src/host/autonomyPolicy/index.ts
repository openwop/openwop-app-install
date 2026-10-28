/**
 * ADR 0942 — the campaign autonomy policy (host). See types.ts for the model,
 * resolve.ts for the pure D3 resolver, store.ts for the D2 stores.
 */
export * from './types.js';
export { DEFAULT_APPROVER, FALLBACK_PRESET, NEW_CLIENT_PRESET, policyHash, presetPolicy, presetPolicyId, presetRules } from './presets.js';
export { validateApprover, validateDecision, validateRule, validateRules, validatePresetId } from './validate.js';
export { evaluatePolicy, findRule, maxSeverity, resolveCampaignAction, type ResolveFloors, type ResolveInput, type Resolution, type ResolutionLayer } from './resolve.js';
export { decisionDominates, isAtLeastAsStrict, loosenedClasses, ruleAtLeastAsStrict } from './compare.js';
export {
  bindClientPresetIfAbsent, deleteBindingsForOrg, deleteCampaignBinding, getBinding, getPolicyVersion, policyForBinding, policyIdFor,
  previewPolicy, resolveEffectivePolicy, savePolicy,
  type EffectivePolicy, type PolicyInput, type PolicySource,
} from './store.js';
export {
  AUTONOMY_TOGGLE, AUTONOMY_TOGGLE_LABEL, applyPolicyChange, autonomyToggleOn, bindingEtag, clearCampaignOverride, describePolicy, parsePolicyBody,
  type PolicyChangeResult,
  type PolicyReadModel,
} from './service.js';
export {
  AUTONOMY_STAMP_KEY, FORK_POSTURE_KEY, buildAutonomyStamp, clientBoundOrg, isCampaignBound, parseAutonomyStamp, runAutonomyOf,
  type FrozenAutonomy, type RunAutonomy,
} from './frozen.js';
export { PENDING_APPROVAL_LANE_CLASSES, compileApproverSpec, factsDigest, laneOf, type ApprovalLane, type CompiledApprovers } from './compile.js';
export { decideGate, parseGateArgs, type AutonomyGateBlock, type GateVerdict } from './gate.js';
export { isAutonomyGateData, isAutonomyRequester } from './selfApproval.js';
export { NODE_ACTION_CLASSES, actionClassOf, type ActionClassEntry } from './actionClasses.js';
export {
  CHOKEPOINT_CLASSES, contentHashOf, enforceCampaignAction, noticeAfterEffect, setAutonomyCampaignStatusResolver, setAutonomyClientResolver, setAutonomyToggleResolver,
  type AutonomyCampaignStatusResolver, type AutonomyClientResolver, type EnforceVerdict,
} from './enforce.js';
export { factsCovered, findCoveringGrant } from './grants.js';
export { APPROVAL_WAIT_KEY_PREFIX, recordApprovalWaiter, reconcileApprovalWaits, resumeRunsAwaitingApproval, setApprovalResumeDeps } from './waiters.js';
export { registerAutonomyPolicyRowEligibility, registerAutonomySpendEligibility } from './spendEligibility.js';
export { AUTONOMY_DIGEST_TYPE, AUTONOMY_NOTICE_TYPE, DIGEST_CHAIN_ID, deliverAutonomyDigest, digestJobId, emitAutonomyNotice, ensureDigestJob } from './notify.js';
export { ALWAYS_APPLIES, projectPolicyForModel, type ModelPolicyView } from './explain.js';
export { castVeto, closeVetoWindow, getVeto, listOpenVetoes, markVetoNotified, openVetoWindow, vetoIdFor, type VetoRecord, type VetoStatus } from './veto.js';
