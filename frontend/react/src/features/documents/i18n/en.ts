/**
 * `documents` namespace (ADR 0053/0065) — user-facing copy for the Documents &
 * Templates workspace. Generic actions/states live in `common`; this catalog
 * owns the feature-specific strings. Plurals use i18next `_one`/`_other`.
 */
export const messages = {
  // Page header
  eyebrow: 'DOCUMENTS',
  title: 'Documents & Templates',
  lede: 'Versioned business documents — SOW, PRD, RFP, Epic Brief, board agendas.',
  orgAriaLabel: 'Organization',

  // Access / empty states
  notEnabledTitle: 'Documents is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Documents & Templates feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — documents belong to an org.',

  // Create
  newDocumentLabel: 'New document',
  newDocumentPlaceholder: 'e.g. Acme SOW',
  kindLabel: 'Kind',
  newDocumentButton: 'New document',
  newChoosePrompt: 'How do you want to start?',
  newBlankTitle: 'Blank document',
  newBlankHint: 'Start with an empty document.',
  newTemplateTitle: 'From a template',
  newTemplateHint: 'Start from one of your saved templates.',
  manageTemplates: 'Manage templates',
  useTemplate: 'Use',
  noTemplatesTitle: 'No templates yet',
  noTemplatesBody: 'Add one from the starter catalog under Manage templates, then start documents from it.',
  fromCanvasLabel: 'From canvas (id)',
  fromCanvasPlaceholder: 'canvas:…',
  fromCanvasAriaLabel: 'Canvas id to materialize',
  fromCanvasButton: 'From canvas',

  // Documents list
  documentsHeading_one: 'Documents ({{count}})',
  documentsHeading_other: 'Documents ({{count}})',
  noDocuments: 'No documents yet.',
  noDocumentsTitle: 'No documents yet',
  noDocumentsBody: 'Create your first document above, or add a starter template to draft from.',

  // Collection view (§4.5 grid/list toggle)
  subLine: 'No format set',
  openDocument: 'Open {{title}}',
  open: 'Open',
  filterGroup: 'Filter documents',
  filterPlaceholder: 'Filter documents…',
  filterAria: 'Filter documents by title',
  noMatchTitle: 'No matching documents',
  noMatchBody: 'No document matches your search. Try a different term.',
  clearSearch: 'Clear search',

  // Editor
  statusAriaLabel: 'Status',
  contentPlaceholder: '# Markdown content',
  contentAriaLabel: 'Document content (Markdown)',
  saveVersion: 'Save version',
  downloadPdf: 'PDF',
  downloadPdfAria: 'Download as PDF',
  downloadSlides: 'Slides',
  downloadSlidesAria: 'Download as Slides',
  downloadCsv: 'CSV',
  downloadCsvAria: 'Download as CSV',
  versionHistory: 'Version history',
  versionEntry: 'v{{version}} · {{date}}',

  // Starter catalog
  starterTemplates: 'Starter templates — add one to your org, then edit',
  use: 'Use',

  // Templates
  templatesHeading_one: 'Templates ({{count}})',
  templatesHeading_other: 'Templates ({{count}})',
  noTemplates: 'No templates yet — add a starter above.',
  assemble: 'Assemble',
  draft: 'Draft',
  deleteTemplateAriaLabel: 'Delete template',
  assembleHeading: 'Assemble “{{name}}” — fill its parameters',
  paramRequiredSuffix: ' *',
  paramDescriptionSuffix: ' — {{description}}',
  assembledPromptLabel: 'Assembled prompt (fed to the document-author agent / workflow node):',
} as const;
