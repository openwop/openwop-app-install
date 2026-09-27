/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // ADR 0755 D3 — the resume token is projected only to an approvals:respond holder.
  noRespondPermission: 'Vous pouvez voir cette étape, mais vous n’avez pas l’autorisation d’y répondre.',
  // RenderInterrupt fallback — neutral copy; never instructs users to edit source (DEMO-14)
  unknownKindBody: 'Cette étape ne peut pas être affichée ici ({{kind}}). Demandez à votre administrateur de mettre à jour l’application.',

  // Approval card
  approvalRequired: 'Approbation requise',
  approvalDefaultPrompt: 'Veuillez approuver pour continuer.',
  commentLabel: 'Commentaire (facultatif)',
  commentPlaceholder: 'Visible dans la piste d’audit',
  actionApprove: 'Approuver',
  actionReject: 'Rejeter',
  rejectConfirmTitle: 'Rejeter et faire échouer l’exécution ?',
  rejectConfirmBody: 'Rejeter met fin à l’exécution ici. Ce qu’elle a déjà consommé — une requête, un appel au modèle, votre relecture — n’est pas récupéré, et le rejet est irréversible.',
  actionRequestChanges: 'Demander des modifications',
  actionDefer: 'Reporter',
  actionEscalate: 'Escalader',
  resolvedElsewhere: 'Cette revue vient d’être résolue ailleurs.',

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
  submitRefinement: 'Envoyer l’affinement',

  // Cancellation banner
  cancellationRequested: 'Annulation demandée',
  cancellationDefaultReason: 'Une annulation a été demandée.',
  confirmCancel: 'Confirmer l’annulation',
  declineCancel: 'Refuser l’annulation',
} as const;
