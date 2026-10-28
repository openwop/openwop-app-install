/**
 * `prompts` namespace — user-facing strings for the prompt-library area
 * (`src/prompts/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // Kind labels (filter + chips)
  kindAll: 'Tous',
  kindAllKinds: 'Tous les types',
  kindSystem: 'Système',
  kindUser: 'Utilisateur',
  kindFewShot: 'Few-shot',
  kindSchemaHint: 'Indice de schéma',

  // Page header
  pageEyebrow: 'Construire',
  pageTitle: 'Bibliothèque de prompts',
  pageLede:
    'Des prompts réutilisables pour le chat et pour les nœuds IA de vos workflows. Les prompts que vous créez dans Mes prompts sont conservés dans ce navigateur ; partagez-en un avec votre équipe pour l’ajouter à la Bibliothèque d’équipe, où chaque membre de l’organisation peut l’insérer dans un chat avec /p-.',
  newPrompt: '+ Nouveau prompt',

  // Tier-1 subset banner (segments — markup stays in the component)
  tierOneStrong: 'Sous-ensemble Tier-1',
  tierOnePosture: '({{posture}}) :',
  tierOneFlagged_one: 'prompt indice de schéma signalé par rapport à',
  tierOneFlagged_other: 'prompts indice de schéma signalés par rapport à',
  tierOneLinkText: 'structured-output-subset.md',
  tierOneFindingHint: 'Des puces en ligne sur chaque élément concerné pointent vers la constatation spécifique.',

  // Key-figure band
  figureAllPrompts: 'Tous les prompts',
  filterByKindAria: 'Filtrer les prompts par type',

  // Filter bar
  filterGroupAria: 'Filtrer les prompts',
  searchPlaceholder: 'templateId, nom, description, tag…',
  searchAria: 'Rechercher des prompts',
  filterByKindSelectAria: 'Filtrer par type',
  countSummary_one: '{{filtered}} prompt sur {{total}}',
  countSummary_other: '{{filtered}} prompts sur {{total}}',

  // Loading / empty states
  loadingPromptsAria: 'Chargement des prompts',
  noMatchTitle: 'Aucun prompt correspondant',
  noMatchBody: 'Essayez d’effacer la recherche ou le filtre par type.',
  clearFilters: 'Effacer les filtres',
  emptyTitle: 'Aucun prompt pour le moment',
  emptyBody: 'Rédigez un prompt réutilisable que les nœuds IA de votre workflow peuvent choisir.',

  // View toggle / collection-view canon
  subNoDescription: 'Aucune description',
  openPrompt: 'Ouvrir {{name}}',
  usePromptAction: 'Utiliser',

  // Card actions
  editLabel: 'Modifier {{name}}',
  deleteLabel: 'Supprimer {{name}}',
  tierOneFindingTitle: 'Constatation du sous-ensemble Tier-1 — voir structured-output-subset.md',

  // Delete modal
  deleteModalLabel: 'Supprimer {{name}}',
  deleteModalTitle: 'Supprimer le prompt',
  deleteModalBodyPrefix: 'Supprimer',
  deleteModalBodySuffix:
    ' ? Cette action est irréversible — tout nœud de workflow qui le référence encore reviendra à sa valeur par défaut en ligne.',
  deletePromptButton: 'Supprimer le prompt',

  // Editor modal
  editModalTitle: 'Modifier le prompt',
  newModalTitle: 'Nouveau prompt',
  fieldName: 'Nom',
  namePlaceholder: 'ex. Éditeur de ton de voix',
  fieldKind: 'Type',
  fieldDescription: 'Description',
  descriptionPlaceholder: 'Ce que fait ce prompt et quand l’utiliser.',
  fieldPromptText: 'Texte du prompt',
  promptTextPlaceholderUser: 'Modèle de style Mustache. Utilisez {{token}} pour les entrées.',
  promptTextPlaceholderSystem: 'L’instruction système. Définissez le rôle, le ton, la forme de sortie.',
  fieldTags: 'Tags',
  tagsHint: '(séparés par des virgules)',
  tagsPlaceholder: 'éditorial, rédaction',
  templateIdLabel: 'ID de modèle',
  templateIdHelp: 'Les ID sont immuables une fois créés afin que les références existantes ne soient pas rompues.',
  saveChanges: 'Enregistrer les modifications',
  createPrompt: 'Créer le prompt',
  errorNameRequired: 'Le nom est requis.',
  errorTextRequired: 'Le texte du prompt est requis.',

  // Detail modal
  detailRef: 'Réf',
  detailKind: 'Type',
  detailDescription: 'Description',
  detailVariables: 'Variables',
  variableMeta: '({{type}})',
  variableMetaFromSource: '({{type}} depuis {{source}})',
  variableDefault: 'par défaut : {{value}}',
  previewLabel: 'Aperçu (rendu local)',
  missingRequired: 'Champs requis manquants : {{vars}}',
  localRenderNotePrefix: 'Ceci est un rendu local de style Mustache. Une fois que l’hôte annonce',
  localRenderNoteMiddle: ', l’aperçu passera par',
  localRenderNoteSuffix: 'pour l’invariant de hachage déterministe.',

  // Prompt picker input
  pickerFailedToLoad: 'Échec du chargement des prompts : {{error}}',
  pickerNone: '— aucun —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Afficher le corps du modèle',
  pickerVariables: 'Variables : {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini l’ignore silencieusement ; préférez `anyOf` ou une union avec discriminateur',
  lintObjectNeedsAdditionalPropertiesFalse:
    'schéma d’objet sans `additionalProperties: false` — requis pour le mode strict d’OpenAI',
  loadFailedTitle: "Impossible de charger la bibliothèque de prompts",
  loadFailedBody: "C’est une lecture en échec, pas une bibliothèque vide : vos prompts sont toujours là.",
  retry: "Réessayer",
  // ADR 0993 D8 — the Team library tab
  tabsLabel: 'Collections de prompts',
  tabMine: 'Mes prompts',
  tabTeam: 'Bibliothèque d’équipe',
  shareWithTeamLabel: 'Partager {{name}} avec votre équipe',
  teamToolbarAria: 'Bibliothèque d’équipe',
  teamOrgPickerAria: 'Organisation',
  teamHint: 'Tapez /p- dans un chat pour en insérer un. Vous le relisez avant l’envoi.',
  teamPublishNew: '+ Publier un prompt',
  teamPublishTitle: 'Publier dans la Bibliothèque d’équipe',
  teamEditTitle: 'Modifier le prompt d’équipe',
  teamPublishButton: 'Publier',
  teamLoadFailedTitle: 'Impossible de charger la Bibliothèque d’équipe',
  teamLoadFailedBody: 'C’est une lecture en échec, pas une bibliothèque vide. Les prompts de votre équipe sont toujours là.',
  teamLoadingAria: 'Chargement de la Bibliothèque d’équipe',
  teamEmptyTitle: 'Aucun prompt d’équipe pour l’instant',
  teamEmptyBody: 'Publiez un prompt, ou partagez-en un depuis Mes prompts, pour que toute l’organisation puisse l’utiliser.',
  teamYours: 'À vous',
  teamUnavailable: 'Modèle manquant',
  teamUseInChat: 'Utiliser dans le chat',
  teamUseFailed: 'Impossible d’ouvrir ce prompt dans le chat. Réessayez.',
  teamDeleteTitle: 'Supprimer {{name}} ?',
  teamDeleteBody: 'Il disparaît de la Bibliothèque d’équipe et de /p- dans le chat. Son lien public, s’il en a un, cesse de fonctionner.',
  teamDeleted: '{{name}} supprimé',
  teamDeleteFailed: 'Impossible de supprimer ce prompt. Réessayez.',
  teamSaved: '{{name}} enregistré',
  teamPublished: '{{name}} publié',
  teamConflict: 'Quelqu’un a modifié ce prompt depuis que vous l’avez ouvert. Vos modifications sont toujours dans le formulaire ; rechargez la dernière version pour continuer.',
  teamSaveFailed: 'Impossible d’enregistrer ce prompt. Réessayez.',
  teamBindsTemplate: 'Ce prompt utilise le modèle {{ref}}. Pour changer son texte, modifiez le modèle dans Mes prompts.',
  teamOrgsEmptyClause: 'La Bibliothèque d’équipe appartient à une organisation',
  teamOrgsFailedClause: 'La Bibliothèque d’équipe n’a jamais été demandée',
  fieldVisibility: 'Qui peut l’utiliser',
  visibilityHelp: 'Vous seul : privé. Équipe : toute l’organisation.',
  visibilityPrivate: 'Vous seul',
  visibilityOrg: 'Équipe',
  visibilityShared: 'Équipe, avec un lien public',
  teamForbidden: 'Vous pouvez utiliser les prompts d’équipe, mais pas les modifier. Demandez un accès en modification à un administrateur de l’organisation.',
  teamGone: 'Ce prompt n’existe plus. La bibliothèque a été rechargée.',
  teamConflictReload: 'Recharger la dernière version',
  teamSaving: 'Enregistrement…',
  teamUnavailableHelp: 'Son texte est manquant, il ne peut donc pas être utilisé. Modifiez-le pour restaurer le texte, ou supprimez-le.',
  teamVisibilityOwnerOnly: 'Seule la personne qui a publié ce prompt peut changer qui peut l’utiliser.',
  commandInsertDescription: 'Insérer : {{name}}',
  commandInsertFailed: 'Impossible d’insérer le prompt d’équipe {{command}}. Il a peut-être été supprimé ou modifié. Votre commande est revenue dans la zone de saisie.',
} as const;
