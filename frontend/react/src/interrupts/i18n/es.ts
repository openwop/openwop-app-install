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
  rejectConfirmTitle: '¿Rechazar esta solicitud?',
  rejectConfirmBody: 'Lo que ocurra después depende del flujo de trabajo; el rechazo puede finalizar la ejecución. El trabajo ya realizado no se deshace.',
  cuRejectConfirmTitle: '¿Rechazar esta acción y terminar la sesión de navegador?',
  cuRejectConfirmBody: 'El agente de navegador no realizará esta acción y la sesión termina aquí. Lo que ya hizo en el sitio no se deshace.',
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
  // ADR 1001 D8 — an agent's multi-question clarification
  clarifyAgentNeedsAnswer: '{{name}} necesita una respuesta',
  clarifyNeedsAnswer: 'El agente necesita una respuesta',
  clarifySafety: 'Nunca pegue aquí contraseñas, claves ni datos de pago.',
  clarifyYes: 'Sí',
  clarifyNo: 'No',
  clarifySkip: 'Omitir y continuar sin responder',
  clarifySkipHelp: 'El agente terminará con lo que tiene e indicará lo que falta.',

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
