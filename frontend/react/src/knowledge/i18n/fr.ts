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
  actionError: 'Échec de l\'action.',
  sourceCreated: 'Source de connaissances créée.',
  documentAdded: 'Document ajouté.',
  documentRemoved: 'Document supprimé.',
  sourceUnbound: 'Source dissociée.',
  // SubjectKnowledgePanel — list / states
  loadingTitle: 'Chargement des connaissances…',
  emptyTitle: 'Aucune source de connaissances pour l\'instant',
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
  noMatches: 'Aucune correspondance pour l\'instant.',
  syncedBadge: 'Synchronisé',
  syncedTitle: 'Synchronisé automatiquement depuis {{source}} — le contenu est en lecture seule ici',
  syncedNotice: 'Cette collection est synchronisée avec vos éléments {{source}}. Gérez-les sur cette page ; les documents ici sont en lecture seule.',
  syncedSource_strategy: 'Stratégie',
  'syncedSource_priority-matrix': 'Matrice de priorités',
} as const;
