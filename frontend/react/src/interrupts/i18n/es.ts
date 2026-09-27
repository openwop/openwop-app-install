/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // ADR 0755 D3 — the resume token is projected only to an approvals:respond holder.
  noRespondPermission: 'Puede ver este paso, pero no tiene permiso para responderlo.',
  // RenderInterrupt fallback — neutral copy; never instructs users to edit source (DEMO-14)
  unknownKindBody: 'Este paso no se puede mostrar aquí ({{kind}}). Pida a su administrador que actualice la aplicación.',

  // Approval card
  approvalRequired: 'Aprobación requerida',
  approvalDefaultPrompt: 'Apruebe para continuar.',
  commentLabel: 'Comentario (opcional)',
  commentPlaceholder: 'Visible en el registro de auditoría',
  actionApprove: 'Aprobar',
  actionReject: 'Rechazar',
  rejectConfirmTitle: '¿Rechazar esto y hacer fallar la ejecución?',
  rejectConfirmBody: 'Rechazar termina la ejecución aquí. Lo que ya se gastó —una consulta, una llamada al modelo, tu revisión— no se recupera, y no se puede deshacer el rechazo.',
  actionRequestChanges: 'Solicitar cambios',
  actionDefer: 'Aplazar',
  actionEscalate: 'Escalar',
  resolvedElsewhere: 'Esta revisión se acaba de resolver en otro lugar.',

  // Clarification dialog
  clarificationNeeded: 'Se necesita aclaración',
  clarificationDefaultQuestion: 'Aclare, por favor.',
  answerLabel: 'Su respuesta',
  submitting: 'Enviando…',
  submitAnswer: 'Enviar respuesta',

  // Refinement form
  refinementRequested: 'Refinamiento solicitado',
  refinementHelp: 'Edite el borrador y vuelva a enviarlo.',
  draftLabel: 'Borrador',
  submitRefinement: 'Enviar refinamiento',

  // Cancellation banner
  cancellationRequested: 'Cancelación solicitada',
  cancellationDefaultReason: 'Se ha solicitado una cancelación.',
  confirmCancel: 'Confirmar cancelación',
  declineCancel: 'Rechazar cancelación',
} as const;
