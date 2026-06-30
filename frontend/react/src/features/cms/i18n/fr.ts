/**
 * `cms` namespace — user-facing strings for the CMS + Page Builder feature
 * (ADR 0009 / ADR 0027). Flat camelCase keys; generic actions/states reuse the
 * `common` namespace via `t('common:…')`.
 */
export const messages = {
  // Page header
  headerEyebrow: 'Plateforme',
  headerTitle: 'CMS · Générateur de pages',
  headerLede: 'Pages d\'organisation avec un éditeur de sections + un workflow éditorial.',

  // Org picker
  organizationLabel: 'Organisation',

  // Access / empty states
  disabledTitle: 'Le CMS n\'est pas activé',
  disabledBody: 'Demandez à un administrateur d\'activer la fonctionnalité CMS pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d\'abord une organisation — les pages appartiennent à une organisation.',
  selectPageTitle: 'Sélectionnez une page',
  selectPageBody: 'Choisissez une page à gauche, ou créez-en une.',

  // Page list
  pagesHeading: 'Pages',
  noPagesYet: 'Aucune page pour le moment.',
  deletePageTitle: 'Supprimer',
  newPageTitlePlaceholder: 'Titre de la nouvelle page',

  // Editor
  titleLabel: 'Titre',
  sectionsHeading: 'Sections',
  saveAction: 'Enregistrer',
  previewHeading: 'Aperçu',
  previewEmpty: 'Ajoutez une section pour afficher un aperçu.',

  // Toasts
  pageCreated: 'Page créée.',
  pageSaved: 'Enregistré.',
  pageStatusChanged: 'Page {{status}}.',
  loadPagesFailed: 'Échec du chargement des pages.',
  openFailed: 'Échec de l\'ouverture.',
  createFailed: 'Échec de la création.',
  saveFailed: 'Échec de l\'enregistrement.',
  deleteFailed: 'Échec de la suppression.',
  actionFailed: 'Échec de {{action}}.',

  // Section renderer
  optionalBadge: 'Facultatif',
  noImage: '(aucune image)',
  unknownSection: 'Section inconnue.',

  // Sections editor — section controls
  moveUp: 'Monter',
  moveDown: 'Descendre',
  removeSection: 'Retirer la section',
  addSectionPlaceholder: '+ Ajouter une section…',
  addSectionAria: 'Ajouter une section',

  // Sections editor — media token field
  mediaTokenLabel: '{{label}} (jeton média)',
  mediaTokenCurrent: '(jeton actuel)',
  mediaTokenPlaceholder: 'Collez un jeton média',

  // Sections editor — head fields
  eyebrowLabel: 'Surtitre (petit libellé en chasse fixe)',
  eyebrowPlaceholder: 'La plateforme',
  headingLabel: 'Titre',

  // Sections editor — hero
  heroEyebrowLabel: 'Surtitre',
  heroEyebrowPlaceholder: 'Protocole ouvert · v1.1',
  heroSubheadingLabel: 'Sous-titre (prend en charge le **markdown**)',
  heroPrimaryLabelPlaceholder: 'Libellé du bouton principal',
  heroPrimaryUrlPlaceholder: '/agents ou https://…',
  heroSecondaryLabelPlaceholder: 'Libellé du bouton secondaire',
  heroSecondaryUrlPlaceholder: 'https://…',
  heroImageLabel: 'Image héros',

  // Sections editor — richText
  richTextLabel: 'Texte (markdown : **gras**, *italique*, `code`, [lien](url))',

  // Sections editor — image
  imageLabel: 'Image',
  altTextLabel: 'Texte alternatif',
  captionLabel: 'Légende',

  // Sections editor — cta
  ctaSubheadingLabel: 'Sous-titre',
  ctaButtonLabelLabel: 'Libellé du bouton',
  ctaButtonUrlLabel: 'URL du bouton',
  ctaButtonUrlPlaceholder: '/agents ou https://…',

  // Sections editor — columns
  layoutLabel: 'Disposition',
  layoutCards: 'Cartes (grille de fonctionnalités)',
  layoutSteps: 'Étapes (numérotées)',
  layoutStats: 'Statistiques (valeur + libellé)',
  columnTitlePlaceholder: 'Titre de l\'élément {{n}} / valeur de stat',
  columnTextPlaceholder: 'Corps / libellé',
  removeItem: 'Retirer',
  addItem: 'Ajouter un élément',

  // Sections editor — locale tabs + overlay (ADR 0064)
  sectionLocalesAria: 'Langues de la section',
  localeBaseTag: 'base',
  localeTabBase: '{{locale}} (langue de base)',
  localeTabTranslated: '{{locale}} (traduit)',
  localeTabNotTranslated: '{{locale}} (non traduit)',
  overlayNote: 'Remplacement pour <1>{{locale}}</1> — les champs vides héritent de la base.',
  copyFromBase: 'Copier depuis la base',
  addBaseContentFirst: 'Ajoutez d\'abord le contenu de base',
  translatingLabel: 'Traduction…',
  translateFromBase: 'Traduire depuis la base',
  clearOverlay: 'Effacer',
  translateEmpty: 'La traduction n\'a rien renvoyé — modifiez la traduction manuellement.',
  translateUnavailable: 'Traduction indisponible — modifiez manuellement.',

  // ── Content language settings (CmsLanguageSettings) ─────────────────────
  langLoading: 'Chargement des paramètres de langue…',
  langSaveFailed: 'Échec de l\'enregistrement.',
  langNotEnabled: 'La localisation du contenu n\'est pas activée pour ce locataire. Demandez à un administrateur d\'activer « Localisation du contenu CMS ».',
  langEnterTag: 'Saisissez une balise BCP-47 comme « es » ou « pt-BR ».',
  langAlreadyConfigured: '« {{loc}} » est déjà configurée.',
  langBaseLocale: 'Langue de base',
  langBaseLocaleHint: '— la source de langue par défaut ; les champs de base des sections y sont rédigés.',
  langTranslationsLabel: 'Traductions (langues rédigées · la base est exclue)',
  langNoTranslations: 'Aucune traduction pour le moment — ajoutez une langue pour commencer à traduire les sections.',
  langRemoveLocale: 'Retirer {{loc}}',
  langNewLocalePlaceholder: 'p. ex. es, pt-BR, fr',
  langNewLocaleAria: 'Nouvelle langue (BCP-47)',
  langAdd: 'Ajouter',
  langAutoTranslate: 'Traduire automatiquement les sections à la publication (un indice ; effectif une fois la traduction par IA activée)',
} as const;
