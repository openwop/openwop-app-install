/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // RenderInterrupt fallback
  unknownKindPrefix: 'Tipo de interrupção desconhecido',
  unknownKindMid: '— estenda',
  unknownKindTail: 'em',

  // Approval card
  approvalRequired: 'Aprovação necessária',
  approvalDefaultPrompt: 'Aprove para continuar.',
  commentLabel: 'Comentário (opcional)',
  commentPlaceholder: 'Visível na trilha de auditoria',
  actionApprove: 'aprovar',
  actionReject: 'rejeitar',
  actionRequestChanges: 'solicitar-alterações',
  actionDefer: 'adiar',
  actionEscalate: 'escalonar',
  resolvedElsewhere: 'Esta revisão acabou de ser resolvida em outro lugar.',

  // Clarification dialog
  clarificationNeeded: 'Esclarecimento necessário',
  clarificationDefaultQuestion: 'Esclareça, por favor.',
  answerLabel: 'Sua resposta',
  submitting: 'Enviando…',
  submitAnswer: 'Enviar resposta',

  // Refinement form
  refinementRequested: 'Refinamento solicitado',
  refinementHelp: 'Edite o rascunho e reenvie.',
  draftLabel: 'Rascunho',
  submitRefinement: 'Enviar refinamento',

  // Cancellation banner
  cancellationRequested: 'Cancelamento solicitado',
  cancellationDefaultReason: 'Um cancelamento foi solicitado.',
  confirmCancel: 'Confirmar cancelamento',
  declineCancel: 'Recusar cancelamento',
} as const;
