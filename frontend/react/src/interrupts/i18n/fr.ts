/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // RenderInterrupt fallback
  unknownKindPrefix: 'Type d\'interruption inconnu',
  unknownKindMid: '— étendre',
  unknownKindTail: 'dans',

  // Approval card
  approvalRequired: 'Approbation requise',
  approvalDefaultPrompt: 'Veuillez approuver pour continuer.',
  commentLabel: 'Commentaire (facultatif)',
  commentPlaceholder: 'Visible dans la piste d\'audit',
  actionApprove: 'approuver',
  actionReject: 'rejeter',
  actionRequestChanges: 'demander-des-modifications',
  actionDefer: 'reporter',
  actionEscalate: 'escalader',
  resolvedElsewhere: 'Cette revue vient d\'être résolue ailleurs.',

  // Clarification dialog
  clarificationNeeded: 'Clarification nécessaire',
  clarificationDefaultQuestion: 'Veuillez clarifier.',
  answerLabel: 'Votre réponse',
  submitting: 'Envoi en cours…',
  submitAnswer: 'Envoyer la réponse',

  // Refinement form
  refinementRequested: 'Affinement demandé',
  refinementHelp: 'Modifiez le brouillon et soumettez à nouveau.',
  draftLabel: 'Brouillon',
  submitRefinement: 'Envoyer l\'affinement',

  // Cancellation banner
  cancellationRequested: 'Annulation demandée',
  cancellationDefaultReason: 'Une annulation a été demandée.',
  confirmCancel: 'Confirmer l\'annulation',
  declineCancel: 'Refuser l\'annulation',
} as const;
