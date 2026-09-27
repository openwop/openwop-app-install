/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // ADR 0755 D3 — the resume token is projected only to an approvals:respond holder.
  noRespondPermission: 'You can see this step, but you don\'t have permission to respond to it.',
  // RenderInterrupt fallback — neutral copy; never instructs users to edit source (DEMO-14)
  unknownKindBody: 'This step can\'t be shown here ({{kind}}). Ask your administrator to update the app.',

  // Approval card
  approvalRequired: 'Approval required',
  approvalDefaultPrompt: 'Please approve to continue.',
  commentLabel: 'Comment (optional)',
  commentPlaceholder: 'Visible in the audit trail',
  actionApprove: 'Approve',
  actionReject: 'Reject',
  rejectConfirmTitle: 'Reject this and fail the run?',
  rejectConfirmBody: 'Rejecting ends the run here. Anything it already spent — a query, a model call, your review — is not recovered, and it cannot be un-rejected.',
  actionRequestChanges: 'Request changes',
  actionDefer: 'Defer',
  actionEscalate: 'Escalate',
  resolvedElsewhere: 'This review was just resolved elsewhere.',

  // Clarification dialog
  clarificationNeeded: 'Clarification needed',
  clarificationDefaultQuestion: 'Please clarify.',
  answerLabel: 'Your answer',
  submitting: 'Submitting…',
  submitAnswer: 'Submit answer',

  // Refinement form
  refinementRequested: 'Refinement requested',
  refinementHelp: 'Edit the draft and resubmit.',
  draftLabel: 'Draft',
  submitRefinement: 'Submit refinement',

  // Cancellation banner
  cancellationRequested: 'Cancellation requested',
  cancellationDefaultReason: 'A cancellation has been requested.',
  confirmCancel: 'Confirm cancel',
  declineCancel: 'Decline cancel',
} as const;
