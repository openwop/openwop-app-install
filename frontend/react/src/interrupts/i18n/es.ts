/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // RenderInterrupt fallback
  unknownKindPrefix: 'Tipo de interrupción desconocido',
  unknownKindMid: '— amplíe',
  unknownKindTail: 'en',

  // Approval card
  approvalRequired: 'Aprobación requerida',
  approvalDefaultPrompt: 'Apruebe para continuar.',
  commentLabel: 'Comentario (opcional)',
  commentPlaceholder: 'Visible en el registro de auditoría',
  actionApprove: 'aprobar',
  actionReject: 'rechazar',
  actionRequestChanges: 'solicitar-cambios',
  actionDefer: 'aplazar',
  actionEscalate: 'escalar',
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
