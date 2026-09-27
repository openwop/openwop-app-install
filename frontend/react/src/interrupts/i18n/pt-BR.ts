/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // ADR 0755 D3 — the resume token is projected only to an approvals:respond holder.
  noRespondPermission: 'Você pode ver esta etapa, mas não tem permissão para respondê-la.',
  // RenderInterrupt fallback — neutral copy; never instructs users to edit source (DEMO-14)
  unknownKindBody: 'Esta etapa não pode ser exibida aqui ({{kind}}). Peça ao administrador para atualizar o aplicativo.',

  // Approval card
  approvalRequired: 'Aprovação necessária',
  approvalDefaultPrompt: 'Aprove para continuar.',
  commentLabel: 'Comentário (opcional)',
  commentPlaceholder: 'Visível na trilha de auditoria',
  actionApprove: 'Aprovar',
  actionReject: 'Rejeitar',
  rejectConfirmTitle: 'Rejeitar e falhar a execução?',
  rejectConfirmBody: 'Rejeitar encerra a execução aqui. O que ela já gastou — uma consulta, uma chamada ao modelo, a sua revisão — não é recuperado, e a rejeição não pode ser desfeita.',
  actionRequestChanges: 'Solicitar alterações',
  actionDefer: 'Adiar',
  actionEscalate: 'Escalonar',
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
