/**
 * `documents` namespace (ADR 0053/0065) — user-facing copy for the Documents &
 * Templates workspace. Generic actions/states live in `common`; this catalog
 * owns the feature-specific strings. Plurals use i18next `_one`/`_other`.
 */
export const messages = {
  // Page header
  eyebrow: 'DOCUMENTOS',
  title: 'Documentos e Modelos',
  lede: 'Documentos de negócios versionados — SOW, PRD, RFP, Epic Brief, pautas de reunião.',
  orgAriaLabel: 'Organização',

  // Access / empty states
  notEnabledTitle: 'O recurso Documentos não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso Documentos e Modelos para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — os documentos pertencem a uma organização.',

  // Create
  newDocumentLabel: 'Novo documento',
  newDocumentPlaceholder: 'ex. Acme SOW',
  kindLabel: 'Tipo',
  newDocumentButton: 'Novo documento',
  newChoosePrompt: 'Como você quer começar?',
  newBlankTitle: 'Documento em branco',
  newBlankHint: 'Comece com um documento vazio.',
  newTemplateTitle: 'A partir de um modelo',
  newTemplateHint: 'Comece a partir de um dos seus modelos salvos.',
  manageTemplates: 'Gerenciar modelos',
  useTemplate: 'Usar',
  noTemplatesTitle: 'Ainda não há modelos',
  noTemplatesBody: 'Adicione um do catálogo inicial em Gerenciar modelos e depois crie documentos a partir dele.',
  fromCanvasLabel: 'A partir do canvas (id)',
  fromCanvasPlaceholder: 'canvas:…',
  fromCanvasAriaLabel: 'ID do canvas para materializar',
  fromCanvasButton: 'A partir do canvas',

  // Documents list
  documentsHeading_one: 'Documentos ({{count}})',
  documentsHeading_other: 'Documentos ({{count}})',
  noDocuments: 'Nenhum documento ainda.',
  noDocumentsTitle: 'Nenhum documento ainda',
  noDocumentsBody: 'Crie seu primeiro documento acima, ou adicione um modelo inicial para começar um rascunho.',

  // Collection view (§4.5 grid/list toggle)
  subLine: 'Nenhum formato definido',
  openDocument: 'Abrir {{title}}',
  open: 'Abrir',
  filterGroup: 'Filtrar documentos',
  filterPlaceholder: 'Filtrar documentos…',
  filterAria: 'Filtrar documentos por título',
  noMatchTitle: 'Nenhum documento correspondente',
  noMatchBody: 'Nenhum documento corresponde à sua busca. Tente outro termo.',
  clearSearch: 'Limpar busca',

  // Editor
  statusAriaLabel: 'Status',
  contentPlaceholder: '# Conteúdo em Markdown',
  contentAriaLabel: 'Conteúdo do documento (Markdown)',
  saveVersion: 'Salvar versão',
  downloadPdf: 'PDF',
  downloadPdfAria: 'Baixar como PDF',
  downloadSlides: 'Slides',
  downloadSlidesAria: 'Baixar como Slides',
  downloadCsv: 'CSV',
  downloadCsvAria: 'Baixar como CSV',
  versionHistory: 'Histórico de versões',
  versionEntry: 'v{{version}} · {{date}}',

  // Starter catalog
  starterTemplates: 'Modelos iniciais — adicione um à sua organização e depois edite',
  use: 'Usar',

  // Templates
  templatesHeading_one: 'Modelos ({{count}})',
  templatesHeading_other: 'Modelos ({{count}})',
  noTemplates: 'Nenhum modelo ainda — adicione um modelo inicial acima.',
  assemble: 'Montar',
  draft: 'Rascunho',
  deleteTemplateAriaLabel: 'Excluir modelo',
  assembleHeading: 'Montar “{{name}}” — preencha seus parâmetros',
  paramRequiredSuffix: ' *',
  paramDescriptionSuffix: ' — {{description}}',
  assembledPromptLabel: 'Prompt montado (alimentado ao agente / nó de workflow autor do documento):',
} as const;
