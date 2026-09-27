/**
 * `knowledge` namespace — user-facing strings for the knowledge-curation area
 * (`src/knowledge/`): the subject-agnostic SubjectKnowledgePanel (ADR 0046
 * follow-on) that creates/binds KB collections, ingests documents, and searches
 * the corpus. FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // SubjectKnowledgePanel — errors / notices
  loadError: 'Échec du chargement des connaissances.',
  orgsFailed: "Vos espaces de travail n’ont pas pu être chargés : ce n’est pas une liste vide, elle est inconnue.",
  orgsFailedInline: 'Choisissez un espace de travail une fois la liste chargée.',
  orgsNoneYet: 'Aucun espace de travail pour l’instant — créez-en un pour ajouter une source de connaissances.',
  actionError: 'Échec de l’action.',
  sourceCreated: 'Source de connaissances créée.',
  documentAdded: 'Document ajouté.',
  documentRemoved: 'Document supprimé.',
  sourceUnbound: 'Source dissociée.',
  // SubjectKnowledgePanel — list / states
  loadingTitle: 'Chargement des connaissances…',
  emptyTitle: 'Aucune source de connaissances pour l’instant',
  // CreateSource — form
  workspaceLabel: 'Espace de travail',
  newSourceLabel: 'Nom de la nouvelle source',
  newSourcePlaceholder: 'Mon guide',
  createSource: 'Créer une source',
  // CollectionCard — header / docs
  docCount_one: '{{count}} document',
  docCount_other: '{{count}} documents',
  unbind: 'Dissocier',
  externalUnverified: 'Externe · non vérifié',
  externalUnverifiedTitle: 'Importé depuis une source externe — traité comme non fiable (ADR 0038 §C).',
  removeDocument: 'Supprimer le document',
  // CollectionCard — ingest form
  documentTitleLabel: 'Titre du document',
  documentTitlePlaceholder: 'Priorités du T3',
  documentTextLabel: 'Texte du document',
  documentTextPlaceholder: 'Collez le contenu à citer.',
  addDocument: 'Ajouter un document',
  // RetrieveSection — search
  searchError: 'Échec de la recherche.',
  searching: 'Recherche…',
  search: 'Rechercher',
  note: 'note',
  external: 'externe',
  noMatches: 'Aucune correspondance pour l’instant.',
  syncedBadge: 'Synchronisé',
  syncedTitle: 'Synchronisé automatiquement depuis {{source}} — le contenu est en lecture seule ici',
  syncedNotice: 'Cette collection est synchronisée avec vos éléments {{source}}. Gérez-les sur cette page ; les documents ici sont en lecture seule.',
  syncedSource_strategy: 'Stratégie',
  'syncedSource_priority-matrix': 'Matrice de priorités',
  deleteDocConfirm: 'Supprimer ce document ?',
  unbindConfirm: 'Détacher cette source ?',
  // KB-UX-3 / ADR 0583 — une source en ÉCHEC est nommée, jamais confondue avec « aucune correspondance ».
  retrievePartial: 'Une partie de ces connaissances n’a pas pu être fouillée : cette réponse est incomplète.',
  retrievePartialSources: 'Non fouillé : {{sources}}',
  retrieveSource_kb: 'documents',
  retrieveSource_memory: 'notes',
  errorAnnounce: 'Le panneau de connaissances a signalé un problème — le détail est affiché à l’écran.',
} as const;
