/**
 * A scheduler skip reason → its `agents` catalog key, shared by every schedule list
 * (the Profile / Agent / Project panels and, since ADR 0985 D7, the Scheduled chats
 * page). Moved out of `SubjectSchedulesPanel` so a page can label a skip without
 * importing that panel's chunk.
 */
/** GEN-PRJ-1 — reason code → catalog key (REUSES the assistant lane's copy).
 *  A `Record` so a new reason code on the wire is a compile-time prompt here;
 *  the runtime arm below covers the wire (an unknown code must neither
 *  fabricate a diagnosis nor go silent — the WF-COS-4 round-2 lesson). */
const SKIP_REASON_KEY: Record<'budget' | 'workflow-unresolved' | 'dispatch-error' | 'feature-disabled' | 'plan-lapsed' | 'actor-inactive' | 'agent-paused' | 'policy-denied' | 'awaiting-approval' | 'goal-closed' | 'client-inactive' | 'target-refused' | 'cadence-too-frequent', string> = {
  budget: 'agents:recurringSkipBudget',
  'workflow-unresolved': 'agents:recurringSkipUnresolved',
  'dispatch-error': 'agents:recurringSkipDispatch',
  'feature-disabled': 'agents:recurringSkipFeatureDisabled',
  'plan-lapsed': 'agents:recurringSkipPlanLapsed',
  'actor-inactive': 'agents:recurringSkipActorInactive',
  'agent-paused': 'agents:recurringSkipAgentPaused',
  'policy-denied': 'agents:recurringSkipPolicyDenied',
  'awaiting-approval': 'agents:recurringSkipAwaitingApproval',
  'goal-closed': 'agents:recurringSkipGoalClosed',
  'client-inactive': 'agents:recurringSkipClientInactive',
  'target-refused': 'agents:recurringSkipTargetRefused',
  'cadence-too-frequent': 'agents:recurringSkipTooFrequent',
};
export function skipReasonKey(reason: string | undefined): string {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SKIP_REASON_KEY, reason)) {
    return SKIP_REASON_KEY[reason as keyof typeof SKIP_REASON_KEY];
  }
  // Adversarial-review F6 — absent ≠ unrecognized: an unmapped wire value means
  // a reason WAS recorded; saying "no reason was recorded" would assert absence
  // where the truth is "recorded but not understood".
  return reason === undefined ? 'agents:recurringSkipUnknown' : 'agents:recurringSkipUnrecognized';
}
