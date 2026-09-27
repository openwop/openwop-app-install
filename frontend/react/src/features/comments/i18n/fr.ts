/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Les commentaires appartiennent aux ressources d’une organisation',
  orgsFailedClause: 'La liste des ressources n’a jamais été demandée',
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Commentaires',
  lede: 'Commentaires en fil de discussion sur vos pages CMS et vos collections de base de connaissances.',

  // Gating / empty states
  notEnabledTitle: 'Les commentaires ne sont pas activés',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Commentaires pour ce locataire.',
  resourcesFailed: "Impossible de charger les ressources de cette organisation — la liste peut être incomplète, pas vide.",
  resourcesFailedOption: 'Échec du chargement — réessayer',
  resourceFromLink: 'Depuis votre lien',
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
  resourceTypeChatMessage: 'Message de conversation',
  resourceTypeCanvasDocument: 'Document enrichi',
  noResourcesChatMessage: 'Aucun message de conversation dans cette organisation',
  noResourcesCanvasDocument: 'Aucun document pour le moment.',
  resourceTypePriorityIdea: 'Idée priorisée',
  resourceTypeCreativeBrief: 'Brief créatif',
  noResourcesPriorityIdea: 'Aucune idée priorisée dans cette organisation',
  noResourcesCreativeBrief: 'Aucun brief créatif dans cette organisation',

  // CMNT-1 — le lien profond de la notification
  linkedThreadLabel: 'Fil issu de votre lien',
  backToPicker: 'Parcourir d’autres ressources',
  linkedResourceMissing: 'Cette ressource n’est pas disponible pour vous. Elle a peut-être été supprimée, ou vous n’y avez peut-être pas accès.',
  resourceGoneTitle: 'Cette ressource n’est pas disponible',
  unsupportedTypeTitle: 'Type de ressource non pris en charge',
  unsupportedTypeBody: 'Ce lien nomme un type de ressource que cet espace de travail ne commente pas ({{type}}). Rien n’a été substitué : le lien est probablement obsolète ou mal saisi.',
  browseAllComments: 'Parcourir les commentaires',
  // ADR 0021 extension — commentaire intégré au chat
  inlineToggle: 'Commenter',
  inlineToggleAria: 'Afficher les commentaires de ce message',

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

  // CMNT-UX-2 / CMNT-UX-3 — honnêteté en cas d’échec de lecture + retour sur écriture
  threadFailedBody: 'Nous n’avons pas pu lire ce fil, nous ne pouvons donc pas dire ce qu’il contient — il n’est pas forcément vide. Réessayez ou rechargez la page.',
  composerBlockedByFailure: 'Les commentaires sont suspendus tant que le fil n’est pas chargé, sinon vous pourriez répéter ce qui a déjà été dit.',
  composerBlockedByReadOnly: 'Vous disposez d’un accès en lecture seule à cet espace de travail : vous pouvez lire ce fil mais pas y contribuer. Demandez à un administrateur de l’organisation un accès en modification (workspace:write) pour commenter.',
  commentPosted: 'Commentaire publié.',
  replyPosted: 'Réponse publiée.',
  markedResolved: 'Marqué comme résolu.',
  markedReopened: 'Rouvert.',
  commentDeleted: 'Commentaire supprimé.',

  // CMNT-UX-5 / -8 / -9 — identité, limite du corps et refus de suppression explicites
  directoryNamesFallback: 'Nous n’avons pas pu charger l’annuaire des membres de cette organisation ; les auteurs ci-dessous sont donc affichés par id et non par nom.',
  bodyCounter: '{{used}} / {{max}} caractères',
  deleteForbidden: 'Vous ne pouvez pas supprimer ce commentaire : seuls son auteur ou un administrateur de l’organisation le peuvent. Vous pouvez le marquer comme résolu.',
  deleteHasForeignReplies: 'D’autres personnes ont répondu à ce commentaire ; seul un administrateur de l’organisation peut le supprimer. Marquez-le comme résolu pour clore le fil.',

  // Confirms / toasts / errors
  deleteConfirm: 'Supprimer ce commentaire ? Ses réponses sont également supprimées (un administrateur d’organisation est requis si d’autres personnes ont répondu). Cette action est irréversible.',
  loadFailed: 'Échec du chargement des commentaires.',
  postFailed: 'Échec de la publication.',
  updateFailed: 'Échec de la mise à jour.',
  deleteFailed: 'Échec de la suppression.',
  writeGone: 'Ce contenu n’est plus disponible, rien n’a donc été enregistré. Il a peut-être été supprimé, ou vous n’y avez peut-être plus accès.',
  writeForbidden: 'Vous ne pouvez pas effectuer cette modification : seuls son auteur ou un administrateur de l’organisation le peuvent.',
  writeForbiddenScope: 'Vous disposez d’un accès en lecture seule à cet espace de travail : cette modification n’a pas été enregistrée. Demandez un accès en modification à un administrateur de l’organisation.',
  writeInvalid: 'Impossible d’enregistrer : vérifiez le texte et réessayez.',
} as const;
