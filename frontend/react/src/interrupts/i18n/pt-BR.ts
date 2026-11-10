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
  rejectConfirmTitle: 'Rejeitar esta solicitação?',
  rejectConfirmBody: 'O que acontece a seguir depende do fluxo de trabalho; a rejeição pode encerrar a execução. O trabalho já realizado não é desfeito.',
  cuRejectConfirmTitle: 'Rejeitar esta ação e encerrar a sessão de navegador?',
  cuRejectConfirmBody: 'O agente de navegador não realizará esta ação e a sessão termina aqui. O que ele já fez no site não é desfeito.',
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
  // ADR 1001 D8 — an agent's multi-question clarification
  clarifyAgentNeedsAnswer: '{{name}} precisa de uma resposta',
  clarifyNeedsAnswer: 'O agente precisa de uma resposta',
  clarifySafety: 'Nunca cole aqui senhas, chaves ou dados de pagamento.',
  clarifyYes: 'Sim',
  clarifyNo: 'Não',
  clarifySkip: 'Pular e continuar sem responder',
  clarifySkipHelp: 'O agente vai terminar com o que tem e dizer o que está faltando.',

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
