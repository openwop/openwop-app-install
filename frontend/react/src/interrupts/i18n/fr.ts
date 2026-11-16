/**
 * `interrupts` namespace — user-facing copy for the HITL interrupt cards
 * (approval, clarification, refinement, cancellation) and the shared renderer.
 */
export const messages = {
  // ADR 0755 D3 — the resume token is projected only to an approvals:respond holder.
  noRespondPermission: 'Vous pouvez voir cette étape, mais vous n’avez pas l’autorisation d’y répondre.',
  // RenderInterrupt fallback — neutral copy; never instructs users to edit source (DEMO-14)
  unknownKindBody: 'Cette demande ne peut pas recevoir de réponse ici. Demandez à la personne qui gère cet espace de travail de mettre à jour l’application.',
  credentialTitle: 'Connecter {{provider}}',
  credentialAnAccount: 'un compte',
  credentialBody: 'Un accès à {{provider}} est nécessaire pour continuer.',
  credentialConnect: 'Connecter',
  timerWaits: 'Cette exécution attend un minuteur et reprend d’elle-même.',
  externalEventWaits: 'Cette exécution attend des exécutions liées ou un événement externe, et continue d’elle-même. Rien à faire ici.',
  timerWaitsUntil: 'Cette exécution attend un minuteur et reprend d’elle-même le {{when}}.',
  walkthroughStepBody: 'Cette exécution est une étape d’une visite guidée ; elle continue lorsque quelqu’un lance la visite.',
  walkthroughStepLink: 'Ouvrir les Visites guidées',

  // Approval card
  approvalRequired: 'Approbation requise',
  approvalDefaultPrompt: 'Veuillez approuver pour continuer.',
  commentLabel: 'Commentaire (facultatif)',
  commentPlaceholder: 'Visible dans la piste d’audit',
  actionApprove: 'Approuver',
  actionReject: 'Rejeter',
  rejectConfirmTitle: 'Rejeter cette demande ?',
  rejectConfirmBody: 'La suite dépend du workflow ; le rejet peut mettre fin à l’exécution. Le travail déjà effectué n’est pas annulé.',
  cuRejectConfirmTitle: 'Rejeter cette action et mettre fin à la session de navigation ?',
  cuRejectConfirmBody: 'L’agent de navigation n’effectuera pas cette action et la session s’arrête ici. Ce qu’il a déjà fait sur le site reste fait.',
  // ADR 1040 D7 F1 — a gate that marks reject as an expected decline.
  declineConfirmTitle: 'Refuser ?',
  declineConfirmBody: 'Cela répond non à cette demande et termine cette étape. Rien n’en est appliqué, et la réponse ne peut plus être modifiée ensuite.',
  declineConfirmLabel: 'Refuser',
  actionRequestChanges: 'Demander des modifications',
  actionRefine: 'Affiner',
  actionDefer: 'Reporter',
  actionEscalate: 'Escalader',
  resolvedElsewhere: 'Cette revue vient d’être résolue ailleurs.',

  // Clarification dialog
  clarificationNeeded: 'Clarification nécessaire',
  clarificationDefaultQuestion: 'Veuillez clarifier.',
  answerLabel: 'Votre réponse',
  submitting: 'Envoi en cours…',
  submitAnswer: 'Envoyer la réponse',
  // ADR 1001 D8 — an agent's multi-question clarification
  clarifyAgentNeedsAnswer: '{{name}} a besoin d’une réponse',
  clarifyNeedsAnswer: 'L’agent a besoin d’une réponse',
  clarifySafety: 'Ne collez jamais ici de mots de passe, de clés ni de données de paiement.',
  clarifyYes: 'Oui',
  clarifyNo: 'Non',
  clarifySkip: 'Passer et continuer sans répondre',
  clarifySkipHelp: 'L’agent terminera avec ce qu’il a et indiquera ce qui manque.',

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
