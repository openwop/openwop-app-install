/**
 * `conversationTools` namespace (ADR 0132) — portée des outils par conversation.
 * French (fr).
 */
export const messages = {
  openTitle: 'Portée des outils pour cette conversation',
  heading: 'Portée des outils de la conversation',
  blurb: 'Contrôlez quels outils de l’agent il peut utiliser dans cette conversation et lesquels nécessitent votre approbation. Restriction uniquement — n’accorde jamais d’outils au-delà des permissions de l’agent.',
  pendingHeading: 'Approbations en attente',
  noPending: 'Aucun outil n’attend d’approbation.',
  approve: 'Approuver',
  deny: 'Refuser',
  approveAria: 'Approuver {{tool}}',
  denyAria: 'Refuser {{tool}}',
  scopeHeading: 'Accès aux outils',
  modeLegend: 'Mode de portée des outils',
  modeDefault: 'Par défaut de l’agent (tous ses outils)',
  modeRestricted: 'Restreint (uniquement les outils ci-dessous)',
  list_enabled: 'Activés',
  list_disabled: 'Désactivés',
  list_requireApproval: 'Nécessitent une approbation',
  addPlaceholder: 'id d’outil (p. ex. crm.contact.update)',
  removeAria: 'Retirer {{tool}}',
  close: 'Fermer',
  save: 'Enregistrer la portée',
  saving: 'Enregistrement…',
  saved: 'Portée des outils enregistrée',
  loadFailed: 'Échec du chargement de la portée des outils.',
  decisionFailed: 'Échec de l’enregistrement de votre décision.',
  saveFailed: 'Échec de l’enregistrement de la portée des outils.',
};
