/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Commentaires',
  lede: 'Commentaires en fil de discussion sur vos pages CMS et vos collections de base de connaissances.',

  // Gating / empty states
  notEnabledTitle: 'Les commentaires ne sont pas activés',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Commentaires pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les commentaires appartiennent aux ressources d\'une organisation.',
  pickResourceTitle: 'Choisissez une ressource',
  pickResourceBody: 'Choisissez une page CMS ou une collection de base de connaissances ci-dessus pour afficher et ajouter des commentaires.',
  noCommentsTitle: 'Aucun commentaire pour le moment',
  noCommentsBody: 'Soyez le premier à laisser une note sur cette ressource.',

  // Resource picker
  resourceTypeLabel: 'Type de ressource',
  resourceLabel: 'Ressource',
  orgPickerLabel: 'Organisation',
  resourceTypeCmsPage: 'Page CMS',
  resourceTypeKbCollection: 'Collection de base de connaissances',
  noResourcesCmsPage: 'Aucune page CMS dans cette organisation',
  noResourcesKbCollection: 'Aucune collection de base de connaissances dans cette organisation',

  // Author label (agent-authored comments)
  authorAgent: 'Agent',

  // Comment status chips
  statusOpen: 'ouvert',
  statusResolved: 'résolu',

  // Composer
  addCommentLabel: 'Ajouter un commentaire',
  newCommentAria: 'Nouveau commentaire',
  newCommentPlaceholder: 'Laissez une note sur cette ressource…',
  commentButton: 'Commenter',

  // Row actions
  reply: 'Répondre',
  resolve: 'Résoudre',
  reopen: 'Rouvrir',
  deleteComment: 'Supprimer le commentaire',
  replyAria: 'Répondre',
  replyPlaceholder: 'Rédigez une réponse…',

  // Confirms / toasts / errors
  deleteConfirm: 'Supprimer ce commentaire ? Ses réponses sont également supprimées (un administrateur d\'organisation est requis si d\'autres personnes ont répondu). Cette action est irréversible.',
  loadFailed: 'Échec du chargement des commentaires.',
  postFailed: 'Échec de la publication.',
  updateFailed: 'Échec de la mise à jour.',
  deleteFailed: 'Échec de la suppression.',
} as const;
