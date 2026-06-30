/**
 * `memory` namespace — user-facing strings for the memory area (`src/memory/`):
 * the subject MemoryBrowser (ADR 0041) and the `/memory` MemoryInspectorPage
 * (RFC 0004). FLAT camelCase keys, one per line (ADR 0065). Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // MemoryBrowser — errors
  loadError: 'Échec du chargement des mémoires.',
  addError: 'Échec de l\'ajout de la mémoire.',
  removeError: 'Échec de la suppression de la mémoire.',
  // MemoryBrowser — add form
  addLabel: 'Ajouter une mémoire',
  addPlaceholderDefault: 'Un fait, une préférence ou un détail à retenir.',
  storedCount_one: '{{n}} mémoire enregistrée',
  storedCount_other: '{{n}} mémoires enregistrées',
  addMemory: 'Ajouter une mémoire',
  // MemoryBrowser — list / states
  loadingTitle: 'Chargement des mémoires…',
  emptyTitle: 'Aucune mémoire pour l\'instant',
  emptyBodyDefault: 'Ajoutez ici des faits et des préférences ; ils sont rappelés lorsque c\'est pertinent.',
  externalUnverified: 'Externe · non vérifiée',
  externalUnverifiedTitle: 'Importée depuis une source externe — traitée comme non fiable (ADR 0038 §C).',
  removeMemory: 'Supprimer la mémoire',
  // MemoryInspectorPage — header
  eyebrow: 'Mémoire',
  inspectorTitle: 'Inspecteur de mémoire',
  inspectorLedePrefix:
    "Parcourez le registre de mémoire du locataire. Les entrées sont écrites en interne par l'hôte — l'exécuteur écrit un résumé de l'exécution à la fin. Les lectures et les suppressions sont limitées à vos identifiants côté serveur ; l'inspecteur ne peut pas voir la mémoire d'un autre locataire.",
  inspectorLedeShowing: 'Affichage',
  // MemoryInspectorPage — redaction
  redactedBadge: 'expurgée',
  redactedTitle: 'Contient du contenu secret expurgé par l\'hôte (SR-1)',
  // MemoryInspectorPage — search / filter
  searchLabel: 'Rechercher',
  searchHint: '(contenu ou étiquettes)',
  searchPlaceholder: 'filtrer les entrées…',
  tagFilterLabel: 'Filtre par étiquette',
  tagFilterHint: '(côté serveur)',
  tagFilterPlaceholder: 'ex. run-summary',
  // MemoryInspectorPage — columns
  columnContent: 'Contenu',
  columnTags: 'Étiquettes',
  columnCreated: 'Créée le',
  ttlSuffix: 'TTL',
  expiresTitle: 'Expire le {{date}}',
  // MemoryInspectorPage — delete
  deleteEntryTitle: 'Supprimer cette entrée de mémoire',
  deleteEntryAria: 'Supprimer l\'entrée de mémoire {{id}}',
  confirmDelete: 'Supprimer l\'entrée de mémoire « {{id}} » ? Cette action est irréversible.',
  confirmBulkDelete_one: 'Supprimer {{n}} entrée de mémoire ? Cette action est irréversible.',
  confirmBulkDelete_other: 'Supprimer {{n}} entrées de mémoire ? Cette action est irréversible.',
  deleteSuccess: 'Entrée de mémoire supprimée.',
  deleteError: 'Impossible de supprimer l\'entrée de mémoire.',
  bulkDeleteSuccess_one: '{{n}} entrée de mémoire supprimée.',
  bulkDeleteSuccess_other: '{{n}} entrées de mémoire supprimées.',
  bulkDeleteError_one: '{{n}} entrée n\'a pas pu être supprimée.',
  bulkDeleteError_other: '{{n}} entrées n\'ont pas pu être supprimées.',
  deleteSelected: 'Supprimer la sélection',
  // MemoryInspectorPage — count line
  entryCount_one: '{{n}} entrée',
  entryCount_other: '{{n}} entrées',
  entryCountOf: '{{shown}} sur {{total}}',
  // MemoryInspectorPage — table / empty
  tableCaption: 'Entrées de mémoire',
  emptyNoMatchTitle: 'Aucune entrée de mémoire correspondante',
  emptyNoEntriesTitle: 'Aucune entrée de mémoire pour l\'instant',
  emptyNoMatchBody: 'Aucune entrée ne correspond à la recherche ou au filtre par étiquette actuels. Effacez les filtres pour voir l\'intégralité du registre.',
  emptyNoEntriesBody: 'Les entrées sont écrites en interne par l\'hôte — l\'exécuteur écrit un résumé de l\'exécution à la fin. Lancez un workflow pour alimenter le registre.',
  // memoryClient — errors
  getEntryError: 'getMemoryEntry a renvoyé {{status}}',
  deleteEntryRequestError: 'deleteMemoryEntry a renvoyé {{status}}',
} as const;
