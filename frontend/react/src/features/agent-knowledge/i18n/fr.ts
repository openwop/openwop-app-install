/**
 * `agent-knowledge` namespace — user-facing copy for the Agent Knowledge & Memory
 * feature (ADR 0038 / ADR 0041). Feature-self-contained: every agent-knowledge
 * string lives here. Generic actions/states are reused from the `common`
 * namespace via `t('common:…')` and are NOT duplicated. Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // Panel loading / chrome
  loadingKnowledge: 'Chargement des connaissances…',
  intro: 'Donnez à {{persona}} ses propres connaissances : des <1>documents</1> qu\'il peut citer, et des <3>notes et faits</3> privés qu\'il rappelle à chaque tour. Configuration locale à l\'hôte — pas le manifeste de protocole de l\'agent.',

  // Run notices (success)
  collectionCreated: 'Collection créée et liée.',
  documentIngested: 'Document ingéré.',
  importedFromDrive: 'Importé depuis Google Drive.',
  collectionUnbound: 'Collection dissociée.',
  documentRemoved: 'Document supprimé.',
  curatedNotesEnabled: 'Notes organisées activées.',
  curatedNotesDisabled: 'Notes organisées désactivées.',

  // Documents section
  documentsTitle: 'Documents',
  documentsHint: 'Collections de connaissances liées — découpées, intégrées et citées lors du rappel.',
  documentsCreateOrgFirst: 'Créez d\'abord une organisation pour héberger les documents de cet agent.',
  organizationLabel: 'Organisation',
  newCollectionNameLabel: 'Nom de la nouvelle collection',
  newCollectionNamePlaceholder: 'Manuel de compte',
  createCollection: 'Créer la collection',
  noDocumentsBound: 'Aucun document lié pour le moment. Créez une collection, puis ajoutez un document ci-dessous.',

  // Collection card
  docCount_one: '{{count}} document',
  docCount_other: '{{count}} documents',
  unbind: 'Dissocier',
  unbindConfirm: 'Dissocier "{{name}}" de cet agent ? La collection elle-même est conservée.',
  externalUnverified: 'Externe · non vérifié',
  externalUnverifiedTitle: 'Importé depuis une source externe (par ex. Google Drive ou un déclencheur). Traité comme non fiable — cloisonné lorsque l\'agent le lit, jamais suivi comme instructions (ADR 0038 §C).',
  chunkCount_one: '· {{count}} segment',
  chunkCount_other: '· {{count}} segments',
  removeDocumentLabel: 'Supprimer {{title}}',
  removeDocumentTitle: 'Supprimer le document',
  removeDocumentConfirm: 'Supprimer "{{title}}" ?',
  documentTitleLabel: 'Titre du document',
  documentTitlePlaceholder: 'Notes de compte du T3',
  documentTextLabel: 'Texte du document',
  documentTextHelp: 'Le texte collé est découpé et intégré pour une récupération avec citation.',
  documentTextPlaceholder: 'Collez le contenu du document…',
  untitledDocument: 'Sans titre',
  addDocument: 'Ajouter un document',
  importFromDriveLabel: 'Importer depuis Google Drive',
  importFromDrivePlaceholder: 'https://docs.google.com/document/d/…',
  importFromDrive: 'Importer depuis Drive',
  importFromDriveHint: 'Collez un lien Drive/Docs — importé avec citation. Nécessite un compte Google connecté.',

  // Notes section
  notesTitle: 'Notes et faits',
  notesHint: 'Privé à cet agent ; rappelé automatiquement à chaque tour (non cité).',
  allowCuratedNotes: 'Autoriser les notes organisées pour cet agent',
  enabled: 'activé',
  disabled: 'désactivé',
  notesStored_one: '{{count}} mémoire stockée — parcourez-les, ajoutez-en et supprimez-en dans l\'onglet <1>Mémoire</1>.',
  notesStored_other: '{{count}} mémoires stockées — parcourez-les, ajoutez-en et supprimez-en dans l\'onglet <1>Mémoire</1>.',
  notesEnablePrompt: 'Activez les notes organisées, puis ajoutez des faits privés que cet agent rappellera dans l\'onglet <1>Mémoire</1>.',

  // Retrieve preview
  retrieveTitle: 'Essayer une récupération',
  retrieveHint: 'Prévisualisez ce que {{persona}} rappellerait pour une requête.',
  queryLabel: 'Requête',
  queryPlaceholder: 'Que savons-nous à propos du compte ?',
  retrieve: 'Récupérer',
  retrieveNoteChip: 'note',
  retrieveExternalChip: 'externe',
  retrieveExternalTitle: 'Contenu externe non fiable — cloisonné lorsque l\'agent le lit (ADR 0038 §C).',
  retrieveNoMatches: 'Aucun résultat — ajoutez des documents ou des notes ci-dessus.',

  // Memory tab (ADR 0041)
  memoryFailedToLoadSettings: 'Échec du chargement des paramètres de mémoire.',
  memoryFailedToEnable: 'Échec de l\'activation des mémoires organisées.',
  memoryIntro: 'La mémoire à long terme de {{persona}} — faits et préférences qu\'il rappelle lorsque c\'est pertinent. Durable ; privé à cet agent.',
  memoryCuratedOff: 'Les mémoires organisées sont désactivées pour cet agent. <1>Activez-les</1> pour ajouter des faits qu\'il rappellera.',
  memoryAddPlaceholder: 'Le directeur financier préfère les mises à jour de statut le vendredi.',
  memoryEmptyBody: 'Ajoutez des faits que {{persona}} devrait retenir ; ils sont rappelés lorsque c\'est pertinent.',
} as const;
