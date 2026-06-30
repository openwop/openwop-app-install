/**
 * `documents` namespace (ADR 0053/0065) — user-facing copy for the Documents &
 * Templates workspace. Generic actions/states live in `common`; this catalog
 * owns the feature-specific strings. Plurals use i18next `_one`/`_other`.
 */
export const messages = {
  // Page header
  eyebrow: 'DOCUMENTOS',
  title: 'Documentos y plantillas',
  lede: 'Documentos de negocio versionados — SOW, PRD, RFP, resumen de épica, órdenes del día.',
  orgAriaLabel: 'Organización',

  // Access / empty states
  notEnabledTitle: 'Documentos no está habilitado',
  notEnabledBody: 'Pida a un administrador que habilite la función Documentos y plantillas para este inquilino.',
  noOrgsTitle: 'No hay organizaciones',
  noOrgsBody: 'Cree primero una organización — los documentos pertenecen a una organización.',

  // Create
  newDocumentLabel: 'Nuevo documento',
  newDocumentPlaceholder: 'p. ej. SOW de Acme',
  kindLabel: 'Tipo',
  newDocumentButton: 'Nuevo documento',
  newChoosePrompt: '¿Cómo quieres empezar?',
  newBlankTitle: 'Documento en blanco',
  newBlankHint: 'Empieza con un documento vacío.',
  newTemplateTitle: 'Desde una plantilla',
  newTemplateHint: 'Empieza desde una de tus plantillas guardadas.',
  manageTemplates: 'Gestionar plantillas',
  useTemplate: 'Usar',
  noTemplatesTitle: 'Aún no hay plantillas',
  noTemplatesBody: 'Añade una desde el catálogo de inicio en Gestionar plantillas y luego crea documentos a partir de ella.',
  fromCanvasLabel: 'Desde lienzo (id)',
  fromCanvasPlaceholder: 'canvas:…',
  fromCanvasAriaLabel: 'Id de lienzo a materializar',
  fromCanvasButton: 'Desde lienzo',

  // Documents list
  documentsHeading_one: 'Documentos ({{count}})',
  documentsHeading_other: 'Documentos ({{count}})',
  noDocuments: 'Aún no hay documentos.',
  noDocumentsTitle: 'Aún no hay documentos',
  noDocumentsBody: 'Cree su primer documento arriba, o añada una plantilla inicial para empezar un borrador.',

  // Collection view (§4.5 grid/list toggle)
  subLine: 'Sin formato definido',
  openDocument: 'Abrir {{title}}',
  open: 'Abrir',
  filterGroup: 'Filtrar documentos',
  filterPlaceholder: 'Filtrar documentos…',
  filterAria: 'Filtrar documentos por título',
  noMatchTitle: 'No hay documentos coincidentes',
  noMatchBody: 'Ningún documento coincide con su búsqueda. Pruebe con otro término.',
  clearSearch: 'Borrar búsqueda',

  // Editor
  statusAriaLabel: 'Estado',
  contentPlaceholder: '# Contenido en Markdown',
  contentAriaLabel: 'Contenido del documento (Markdown)',
  saveVersion: 'Guardar versión',
  downloadPdf: 'PDF',
  downloadPdfAria: 'Descargar como PDF',
  downloadSlides: 'Diapositivas',
  downloadSlidesAria: 'Descargar como diapositivas',
  downloadCsv: 'CSV',
  downloadCsvAria: 'Descargar como CSV',
  versionHistory: 'Historial de versiones',
  versionEntry: 'v{{version}} · {{date}}',

  // Starter catalog
  starterTemplates: 'Plantillas iniciales — añada una a su organización y luego edítela',
  use: 'Usar',

  // Templates
  templatesHeading_one: 'Plantillas ({{count}})',
  templatesHeading_other: 'Plantillas ({{count}})',
  noTemplates: 'Aún no hay plantillas — añada una inicial arriba.',
  assemble: 'Ensamblar',
  draft: 'Borrador',
  deleteTemplateAriaLabel: 'Eliminar plantilla',
  assembleHeading: 'Ensamblar “{{name}}” — rellene sus parámetros',
  paramRequiredSuffix: ' *',
  paramDescriptionSuffix: ' — {{description}}',
  assembledPromptLabel: 'Prompt ensamblado (enviado al agente / nodo de flujo autor de documentos):',
} as const;
