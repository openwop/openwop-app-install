/**
 * `kb` namespace — Knowledge Base / RAG feature copy (ADR 0011).
 * Feature-specific strings; generic actions/states reuse `common:`.
 */
export const messages = {
  // Page header
  eyebrow: 'Plateforme',
  title: 'Base de connaissances',
  lede: 'Donnez à votre IA une bibliothèque de vos propres documents : elle trouve les passages les plus pertinents et les cite dans ses réponses.',
  // Feature gate / empty states
  disabledTitle: 'La base de connaissances n\'est pas activée',
  disabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Base de connaissances pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les collections appartiennent à une organisation.',
  selectCollectionTitle: 'Sélectionnez une collection',
  selectCollectionBody: 'Choisissez une collection à gauche, ou créez-en une — puis ajoutez des documents et lancez une recherche.',
  // Org picker
  organizationLabel: 'Organisation',
  // Collections panel
  collectionsHeading: 'Collections',
  noCollections: 'Aucune collection pour le moment.',
  documentsTooltip: 'documents',
  deleteCollection: 'Supprimer la collection',
  newCollectionPlaceholder: 'Nouvelle collection',
  createCollection: 'Créer une collection',
  // Search panel
  searchHeading: 'Rechercher « {{name}} »',
  searchPlaceholder: 'Posez une question…',
  retrievalModeLabel: 'Recherche',
  retrievalModeDense: 'Standard (sémantique)',
  retrievalModeHybrid: 'Hybride (mots-clés + sémantique)',
  retrievalModeRerank: 'Meilleure correspondance (hybride + reclassement)',
  retrievalModeFailed: 'Impossible de mettre à jour le mode de recherche.',
  noMatches: 'Aucune correspondance — ajoutez des documents, ou essayez une autre question.',
  cosineScoreTooltip: 'score cosinus',
  // Ingest panel
  addDocumentHeading: 'Ajouter un document',
  titlePlaceholder: 'Titre (facultatif)',
  ingestPlaceholder: 'Collez du texte à découper + intégrer dans cette collection…',
  untitled: 'Sans titre',
  ingest: 'Ingérer',
  // Documents panel
  documentsHeading: 'Documents',
  noDocuments: 'Aucun document pour le moment.',
  noDocumentsTitle: 'Aucun document',
  chunksTooltip: 'segments',
  chunkCount_one: '{{count}} segment',
  chunkCount_other: '{{count}} segments',
  deleteDocument: 'Supprimer le document',
  // Provenance du document (puce + sous-ligne de la vue)
  sourceText: 'Texte collé',
  sourceMedia: 'Import média',
  // Filtre de la liste de documents + vue grille/liste (canon §4.5)
  docFilterGroup: 'Filtrer les documents',
  docFilterPlaceholder: 'Filtrer les documents…',
  docFilterAria: 'Filtrer les documents par titre',
  docNoMatchTitle: 'Aucun document correspondant',
  docNoMatchBody: 'Aucun document ne correspond à votre recherche. Essayez un autre terme.',
  clearDocSearch: 'Effacer la recherche',
  // Toast errors
  loadCollectionsFailed: 'Échec du chargement des collections.',
  loadOrgsFailed: 'Échec du chargement des organisations.',
  loadDocumentsFailed: 'Échec du chargement des documents.',
  createFailed: 'Échec de la création.',
  deleteFailed: 'Échec de la suppression.',
  ingestFailed: 'Échec de l\'ingestion.',
  uploadFileLabel: 'Téléverser un fichier',
  uploadFileHint: 'PDF, DOCX ou texte — extrait et ajouté à cette collection.',
  documentAdded: 'Document ajouté.',
  fileTooLarge: 'Ce fichier est trop volumineux (max {{max}} Mo).',
  uploading: 'Téléversement…',
  searchFailed: 'Échec de la recherche.',
  managedBadge: 'Synchronisé',
  managedTitle: 'Synchronisé automatiquement depuis {{source}} — lecture seule ici',
  managedNotice: 'Cette collection est synchronisée avec vos éléments {{source}}. Gérez-les sur cette page ; les documents ici sont en lecture seule.',
  managedSource_strategy: 'Stratégie',
  'managedSource_priority-matrix': 'Matrice de priorités',
} as const;
