/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // RenderInterrupt fallback
  unknownKindPrefix: 'Unknown interrupt kind',
  unknownKindMid: '— extend',
  unknownKindTail: 'in',

  // Approval card
  approvalRequired: 'Approval required',
  approvalDefaultPrompt: 'Please approve to continue.',
  commentLabel: 'Comment (optional)',
  commentPlaceholder: 'Visible in the audit trail',
  actionApprove: 'approve',
  actionReject: 'reject',
  actionRequestChanges: 'request-changes',
  actionDefer: 'defer',
  actionEscalate: 'escalate',
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
