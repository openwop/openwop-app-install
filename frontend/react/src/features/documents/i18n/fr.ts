/**
 * `documents` namespace (ADR 0053/0065) — user-facing copy for the Documents &
 * Templates workspace. Generic actions/states live in `common`; this catalog
 * owns the feature-specific strings. Plurals use i18next `_one`/`_other`.
 */
export const messages = {
  // Page header
  eyebrow: 'DOCUMENTS',
  title: 'Documents et modèles',
  lede: 'Documents métier versionnés — SOW, PRD, RFP, Epic Brief, ordres du jour de réunion.',
  orgAriaLabel: 'Organisation',

  // Access / empty states
  notEnabledTitle: 'Documents n\'est pas activé',
  notEnabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité Documents et modèles pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les documents appartiennent à une organisation.',

  // Create
  newDocumentLabel: 'Nouveau document',
  newDocumentPlaceholder: 'ex. Acme SOW',
  kindLabel: 'Type',
  newDocumentButton: 'Nouveau document',
  newChoosePrompt: 'Comment voulez-vous commencer ?',
  newBlankTitle: 'Document vierge',
  newBlankHint: 'Commencer avec un document vide.',
  newTemplateTitle: 'À partir d\'un modèle',
  newTemplateHint: 'Commencer à partir d\'un de vos modèles enregistrés.',
  manageTemplates: 'Gérer les modèles',
  useTemplate: 'Utiliser',
  noTemplatesTitle: 'Aucun modèle pour l\'instant',
  noTemplatesBody: 'Ajoutez-en un depuis le catalogue de départ dans Gérer les modèles, puis créez des documents à partir de celui-ci.',
  fromCanvasLabel: 'Depuis le canevas (id)',
  fromCanvasPlaceholder: 'canvas:…',
  fromCanvasAriaLabel: 'Id du canevas à matérialiser',
  fromCanvasButton: 'Depuis le canevas',

  // Documents list
  documentsHeading_one: 'Documents ({{count}})',
  documentsHeading_other: 'Documents ({{count}})',
  noDocuments: 'Aucun document pour le moment.',
  noDocumentsTitle: 'Aucun document pour le moment',
  noDocumentsBody: 'Créez votre premier document ci-dessus, ou ajoutez un modèle de démarrage pour rédiger un brouillon.',

  // Collection view (§4.5 grid/list toggle)
  subLine: 'Aucun format défini',
  openDocument: 'Ouvrir {{title}}',
  open: 'Ouvrir',
  filterGroup: 'Filtrer les documents',
  filterPlaceholder: 'Filtrer les documents…',
  filterAria: 'Filtrer les documents par titre',
  noMatchTitle: 'Aucun document correspondant',
  noMatchBody: 'Aucun document ne correspond à votre recherche. Essayez un autre terme.',
  clearSearch: 'Effacer la recherche',

  // Editor
  statusAriaLabel: 'Statut',
  contentPlaceholder: '# Contenu Markdown',
  contentAriaLabel: 'Contenu du document (Markdown)',
  saveVersion: 'Enregistrer la version',
  downloadPdf: 'PDF',
  downloadPdfAria: 'Télécharger au format PDF',
  downloadSlides: 'Diapositives',
  downloadSlidesAria: 'Télécharger au format Diapositives',
  downloadCsv: 'CSV',
  downloadCsvAria: 'Télécharger au format CSV',
  versionHistory: 'Historique des versions',
  versionEntry: 'v{{version}} · {{date}}',

  // Starter catalog
  starterTemplates: 'Modèles de démarrage — ajoutez-en un à votre organisation, puis modifiez',
  use: 'Utiliser',

  // Templates
  templatesHeading_one: 'Modèles ({{count}})',
  templatesHeading_other: 'Modèles ({{count}})',
  noTemplates: 'Aucun modèle pour le moment — ajoutez un modèle de démarrage ci-dessus.',
  assemble: 'Assembler',
  draft: 'Brouillon',
  deleteTemplateAriaLabel: 'Supprimer le modèle',
  assembleHeading: 'Assembler « {{name}} » — renseignez ses paramètres',
  paramRequiredSuffix: ' *',
  paramDescriptionSuffix: ' — {{description}}',
  assembledPromptLabel: 'Invite assemblée (transmise à l\'agent / nœud de workflow auteur du document) :',
} as const;
