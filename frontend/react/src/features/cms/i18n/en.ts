/**
 * `cms` namespace — user-facing strings for the CMS + Page Builder feature
 * (ADR 0009 / ADR 0027). Flat camelCase keys; generic actions/states reuse the
 * `common` namespace via `t('common:…')`.
 */
export const messages = {
  // Page header
  headerEyebrow: 'Platform',
  headerTitle: 'CMS · Page Builder',
  headerLede: 'Org pages with a section editor + editorial workflow.',

  // Org picker
  organizationLabel: 'Organization',

  // Access / empty states
  disabledTitle: 'CMS is not enabled',
  disabledBody: 'Ask an administrator to enable the CMS feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — pages belong to an org.',
  selectPageTitle: 'Select a page',
  selectPageBody: 'Pick a page on the left, or create one.',

  // Page list
  pagesHeading: 'Pages',
  noPagesYet: 'No pages yet.',
  deletePageTitle: 'Delete',
  newPageTitlePlaceholder: 'New page title',

  // Editor
  titleLabel: 'Title',
  sectionsHeading: 'Sections',
  saveAction: 'Save',
  previewHeading: 'Preview',
  previewEmpty: 'Add a section to preview.',

  // Toasts
  pageCreated: 'Page created.',
  pageSaved: 'Saved.',
  pageStatusChanged: 'Page {{status}}.',
  loadPagesFailed: 'Failed to load pages.',
  openFailed: 'Open failed.',
  createFailed: 'Create failed.',
  saveFailed: 'Save failed.',
  deleteFailed: 'Delete failed.',
  actionFailed: '{{action}} failed.',

  // Section renderer
  optionalBadge: 'Optional',
  noImage: '(no image)',
  unknownSection: 'Unknown section.',

  // Sections editor — section controls
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeSection: 'Remove section',
  addSectionPlaceholder: '+ Add section…',
  addSectionAria: 'Add section',

  // Sections editor — media token field
  mediaTokenLabel: '{{label}} (Media token)',
  mediaTokenCurrent: '(current token)',
  mediaTokenPlaceholder: 'Paste a media token',

  // Sections editor — head fields
  eyebrowLabel: 'Eyebrow (small mono label)',
  eyebrowPlaceholder: 'The platform',
  headingLabel: 'Heading',

  // Sections editor — hero
  heroEyebrowLabel: 'Eyebrow',
  heroEyebrowPlaceholder: 'Open protocol · v1.1',
  heroSubheadingLabel: 'Subheading (supports **markdown**)',
  heroPrimaryLabelPlaceholder: 'Primary button label',
  heroPrimaryUrlPlaceholder: '/agents or https://…',
  heroSecondaryLabelPlaceholder: 'Secondary button label',
  heroSecondaryUrlPlaceholder: 'https://…',
  heroImageLabel: 'Hero image',

  // Sections editor — richText
  richTextLabel: 'Text (markdown: **bold**, *italic*, `code`, [link](url))',

  // Sections editor — image
  imageLabel: 'Image',
  altTextLabel: 'Alt text',
  captionLabel: 'Caption',

  // Sections editor — cta
  ctaSubheadingLabel: 'Subheading',
  ctaButtonLabelLabel: 'Button label',
  ctaButtonUrlLabel: 'Button URL',
  ctaButtonUrlPlaceholder: '/agents or https://…',

  // Sections editor — columns
  layoutLabel: 'Layout',
  layoutCards: 'Cards (feature grid)',
  layoutSteps: 'Steps (numbered)',
  layoutStats: 'Stats (value + label)',
  columnTitlePlaceholder: 'Item {{n}} title / stat value',
  columnTextPlaceholder: 'Body / label',
  removeItem: 'Remove',
  addItem: 'Add item',

  // Sections editor — locale tabs + overlay (ADR 0064)
  sectionLocalesAria: 'Section locales',
  localeBaseTag: 'base',
  localeTabBase: '{{locale}} (base locale)',
  localeTabTranslated: '{{locale}} (translated)',
  localeTabNotTranslated: '{{locale}} (not translated)',
  overlayNote: 'Override for <1>{{locale}}</1> — empty fields inherit the base.',
  copyFromBase: 'Copy from base',
  addBaseContentFirst: 'Add base content first',
  translatingLabel: 'Translating…',
  translateFromBase: 'Translate from base',
  clearOverlay: 'Clear',
  translateEmpty: 'Translation returned nothing — edit the translation manually.',
  translateUnavailable: 'Translation unavailable — edit manually.',

  // ── Content language settings (CmsLanguageSettings) ─────────────────────
  langLoading: 'Loading language settings…',
  langSaveFailed: 'Save failed.',
  langNotEnabled: 'Content localization is not enabled for this tenant. Ask an administrator to turn on “CMS content localization”.',
  langEnterTag: 'Enter a BCP-47 tag like “es” or “pt-BR”.',
  langAlreadyConfigured: '“{{loc}}” is already configured.',
  langBaseLocale: 'Base locale',
  langBaseLocaleHint: '— the default-locale source; section base fields are written in it.',
  langTranslationsLabel: 'Translations (authored locales · base is excluded)',
  langNoTranslations: 'No translations yet — add a locale to start translating sections.',
  langRemoveLocale: 'Remove {{loc}}',
  langNewLocalePlaceholder: 'e.g. es, pt-BR, fr',
  langNewLocaleAria: 'New locale (BCP-47)',
  langAdd: 'Add',
  langAutoTranslate: 'Auto-translate sections on publish (a hint; effective once AI translation is enabled)',
} as const;
