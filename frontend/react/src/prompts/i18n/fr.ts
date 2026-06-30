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
    'Des prompts réutilisables que les nœuds IA de votre workflow peuvent choisir. Modifiez-en un à un seul endroit et chaque nœud qui l\'utilise se met à jour à sa prochaine exécution — sans copier-coller, sans dérive. Les prompts système définissent le rôle et le ton de l\'IA ; les prompts utilisateur façonnent ce que vous lui demandez.',
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
  noMatchBody: 'Essayez d\'effacer la recherche ou le filtre par type.',
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
  descriptionPlaceholder: 'Ce que fait ce prompt et quand l\'utiliser.',
  fieldPromptText: 'Texte du prompt',
  promptTextPlaceholderUser: 'Modèle de style Mustache. Utilisez {{token}} pour les entrées.',
  promptTextPlaceholderSystem: 'L\'instruction système. Définissez le rôle, le ton, la forme de sortie.',
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
  localRenderNotePrefix: 'Ceci est un rendu local de style Mustache. Une fois que l\'hôte annonce',
  localRenderNoteMiddle: ', l\'aperçu passera par',
  localRenderNoteSuffix: 'pour l\'invariant de hachage déterministe.',

  // Prompt picker input
  pickerFailedToLoad: 'Échec du chargement des prompts : {{error}}',
  pickerLoading: 'Chargement des prompts…',
  pickerNone: '— aucun —',
  pickerOptionWithName: '{{name}} ({{ref}})',
  pickerShowBody: 'Afficher le corps du modèle',
  pickerVariables: 'Variables : {{vars}}',

  // Tier-1 lint findings (rendered as chips)
  lintNoOneOf: '`oneOf` — Gemini l\'ignore silencieusement ; préférez `anyOf` ou une union avec discriminateur',
  lintObjectNeedsAdditionalPropertiesFalse:
    'schéma d\'objet sans `additionalProperties: false` — requis pour le mode strict d\'OpenAI',
} as const;
