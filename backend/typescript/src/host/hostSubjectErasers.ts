/**
 * Host-store subject-eraser wiring (ADR 0464 Phase 2).
 *
 * The DSAR erasure seam (`host/subjectErasure.ts`) fans an `eraseSubject` out to
 * every registered `SubjectEraser`. Feature packages register theirs as a
 * side-effect of `feature.ts` `registerRoutes` (which runs for every feature
 * regardless of toggle). HOST-owned stores have no feature to hang off, so this
 * ONE boot step registers each host module's eraser — each eraser lives AT its
 * owning module (co-located with the store it erases, the ADR 0464 rule), and
 * every registration is idempotent-by-reference, so calling this more than once
 * (or a module also registering elsewhere) is harmless.
 *
 * Wired from `routes/registerAllRoutes.ts` after `hostExt:persistence`. The
 * approvals cluster (ADR 0464 §2.3, peer-owned) registers its store-level eraser
 * through the same mechanism — fold its `register…()` call in here alongside the
 * rest so there is a single host-eraser boot list.
 */

import { registerKanbanErasure } from './kanbanService.js';
import { registerCanvasErasure } from './canvasSurface.js';
import { registerSchedulingErasure } from './schedulingService.js';
import { registerTwinErasure } from './twinService.js';
import { registerAccessControlErasure } from './accessControlService.js';
import { registerWorkspaceJoinErasure } from './workspaceJoinLedger.js';
import { registerConversationErasure } from './conversationStore.js';
import { registerReadStateErasure } from './conversationReadState.js';
import { registerMessageFeedbackErasure } from './messageFeedbackStore.js';
import { registerReactionsErasure } from './messageReactionsStore.js';
import { registerSubjectKnowledgeErasure } from './subjectKnowledge.js';
import { registerSubjectMemoryErasure } from './subjectMemory.js';
import { registerSelfHostedRunnerErasure } from './selfHostedRunner.js';
import { registerAgentProfileTwinErasure } from './agentProfileService.js';
import { registerCompensationErasure } from './compensationLedger.js';
import { registerApprovalErasure } from './approvalService.js';
import { registerApprovalDelegationsErasure } from './approvalDelegations.js';
import { registerTeamsDeliveryErasure } from './teamsApprovalDelivery.js';
import { registerReviewDecisionErasure } from './reviewDecisionLedger.js';
import { registerProposalPolicyErasure } from './workflowProposalPolicy.js';
import { registerWorkflowRevisionErasure } from './workflowRevisions.js';
import { registerDebugPinErasure } from './workflowDebugPins.js';
import { registerEvalSetErasure } from './workflowEvalSets.js';
import { registerEmailPrefErasure } from './emailApprovalDelivery.js';
import { registerWorkflowBudgetErasure } from './workflowBudgets.js';
import { registerApplyGrantErasure } from './applyGrant.js';
import { registerSubjectLinkErasure } from './auth/subjectLinkService.js';

/** Register every host-owned store's DSAR subject-eraser (idempotent). */
export function registerHostSubjectErasers(): void {
  // ADR 0464 §2.3 — the approvals cluster (folded from module-load side effects
  // into this ONE explicit list; an import-graph change can no longer silently
  // unregister an eraser).
  registerApprovalErasure();
  registerApprovalDelegationsErasure();
  registerTeamsDeliveryErasure();
  registerReviewDecisionErasure();
  registerKanbanErasure();
  registerCanvasErasure();
  registerSchedulingErasure();
  registerTwinErasure();
  registerAccessControlErasure();
  // ADR 0684 §7 — the auto-join ledger is subject-keyed (ADR 0464 §2.1).
  registerWorkspaceJoinErasure();
  // ADR 0554 P1 — compensation obligations REDACT rather than delete: the row is
  // an audit fact (RFC 0151 §E requires overrides be audited), and deleting an
  // unresolved one would make `compensationStatusForRun` report `completed` for
  // a run whose unwind never finished.
  registerCompensationErasure();
  registerConversationErasure();
  registerReadStateErasure();
  registerMessageFeedbackErasure();
  registerReactionsErasure();
  registerSubjectKnowledgeErasure();
  registerSubjectMemoryErasure();
  registerSelfHostedRunnerErasure();
  registerAgentProfileTwinErasure();
  registerProposalPolicyErasure(); // ADR 0464 §2.1 — the ADR 0473 auto-approve policy store
  registerWorkflowRevisionErasure(); // ADR 0474 — revision-history attribution (`createdBy` redacted)
  registerDebugPinErasure(); // ADR 0475 — debug pins DELETED (pinned output may quote the subject)
  registerEvalSetErasure(); // ADR 0477 — eval set/result attribution redacted (tenant work-product)
  registerEmailPrefErasure(); // ADR 0478 — email prefs DELETED (the row IS the subject's address)
  registerWorkflowBudgetErasure(); // ADR 0482 — budget attribution (`updatedBy` redacted)
  registerApplyGrantErasure(); // WF-CONS-2 — was the ONE host eraser registering at module scope, outside this list
  registerSubjectLinkErasure(); // ADR 0464 §2.1 / RFC 0159 — the SCIM⟷SAML subject-link deny store (row IS the opaque externalId; DELETED)
}
