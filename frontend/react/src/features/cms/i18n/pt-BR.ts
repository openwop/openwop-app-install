/**
 * `cms` namespace — user-facing strings for the CMS + Page Builder feature
 * (ADR 0009 / ADR 0027). Flat camelCase keys; generic actions/states reuse the
 * `common` namespace via `t('common:…')`.
 */
export const messages = {
  // Page header
  headerEyebrow: 'Plataforma',
  headerTitle: 'CMS · Construtor de Páginas',
  headerLede: 'Páginas da organização com editor de seções + fluxo editorial.',

  // Org picker
  organizationLabel: 'Organização',

  // Access / empty states
  disabledTitle: 'O CMS não está ativado',
  disabledBody: 'Peça a um administrador para ativar o recurso CMS para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — as páginas pertencem a uma organização.',
  selectPageTitle: 'Selecione uma página',
  selectPageBody: 'Escolha uma página à esquerda ou crie uma.',

  // Page list
  pagesHeading: 'Páginas',
  noPagesYet: 'Nenhuma página ainda.',
  deletePageTitle: 'Excluir',
  newPageTitlePlaceholder: 'Título da nova página',

  // Editor
  titleLabel: 'Título',
  sectionsHeading: 'Seções',
  saveAction: 'Salvar',
  previewHeading: 'Pré-visualização',
  previewEmpty: 'Adicione uma seção para pré-visualizar.',

  // Toasts
  pageCreated: 'Página criada.',
  pageSaved: 'Salvo.',
  pageStatusChanged: 'Página {{status}}.',
  loadPagesFailed: 'Falha ao carregar as páginas.',
  openFailed: 'Falha ao abrir.',
  createFailed: 'Falha ao criar.',
  saveFailed: 'Falha ao salvar.',
  deleteFailed: 'Falha ao excluir.',
  actionFailed: 'Falha em {{action}}.',

  // Section renderer
  optionalBadge: 'Opcional',
  noImage: '(sem imagem)',
  unknownSection: 'Seção desconhecida.',

  // Sections editor — section controls
  moveUp: 'Mover para cima',
  moveDown: 'Mover para baixo',
  removeSection: 'Remover seção',
  addSectionPlaceholder: '+ Adicionar seção…',
  addSectionAria: 'Adicionar seção',

  // Sections editor — media token field
  mediaTokenLabel: '{{label}} (Token de mídia)',
  mediaTokenCurrent: '(token atual)',
  mediaTokenPlaceholder: 'Cole um token de mídia',

  // Sections editor — head fields
  eyebrowLabel: 'Eyebrow (pequeno rótulo mono)',
  eyebrowPlaceholder: 'A plataforma',
  headingLabel: 'Título',

  // Sections editor — hero
  heroEyebrowLabel: 'Eyebrow',
  heroEyebrowPlaceholder: 'Open protocol · v1.1',
  heroSubheadingLabel: 'Subtítulo (suporta **markdown**)',
  heroPrimaryLabelPlaceholder: 'Rótulo do botão primário',
  heroPrimaryUrlPlaceholder: '/agents or https://…',
  heroSecondaryLabelPlaceholder: 'Rótulo do botão secundário',
  heroSecondaryUrlPlaceholder: 'https://…',
  heroImageLabel: 'Imagem hero',

  // Sections editor — richText
  richTextLabel: 'Texto (markdown: **bold**, *italic*, `code`, [link](url))',

  // Sections editor — image
  imageLabel: 'Imagem',
  altTextLabel: 'Texto alternativo',
  captionLabel: 'Legenda',

  // Sections editor — cta
  ctaSubheadingLabel: 'Subtítulo',
  ctaButtonLabelLabel: 'Rótulo do botão',
  ctaButtonUrlLabel: 'URL do botão',
  ctaButtonUrlPlaceholder: '/agents or https://…',

  // Sections editor — columns
  layoutLabel: 'Layout',
  layoutCards: 'Cards (grade de recursos)',
  layoutSteps: 'Etapas (numeradas)',
  layoutStats: 'Estatísticas (valor + rótulo)',
  columnTitlePlaceholder: 'Título do item {{n}} / valor da estatística',
  columnTextPlaceholder: 'Corpo / rótulo',
  removeItem: 'Remover',
  addItem: 'Adicionar item',

  // Sections editor — locale tabs + overlay (ADR 0064)
  sectionLocalesAria: 'Idiomas da seção',
  localeBaseTag: 'base',
  localeTabBase: '{{locale}} (idioma base)',
  localeTabTranslated: '{{locale}} (traduzido)',
  localeTabNotTranslated: '{{locale}} (não traduzido)',
  overlayNote: 'Substituição para <1>{{locale}}</1> — campos vazios herdam do idioma base.',
  copyFromBase: 'Copiar do idioma base',
  addBaseContentFirst: 'Adicione primeiro o conteúdo base',
  translatingLabel: 'Traduzindo…',
  translateFromBase: 'Traduzir do idioma base',
  clearOverlay: 'Limpar',
  translateEmpty: 'A tradução não retornou nada — edite a tradução manualmente.',
  translateUnavailable: 'Tradução indisponível — edite manualmente.',

  // ── Content language settings (CmsLanguageSettings) ─────────────────────
  langLoading: 'Carregando configurações de idioma…',
  langSaveFailed: 'Falha ao salvar.',
  langNotEnabled: 'A localização de conteúdo não está habilitada para este locatário. Peça a um administrador para ativar a “localização de conteúdo do CMS”.',
  langEnterTag: 'Informe uma tag BCP-47 como “es” ou “pt-BR”.',
  langAlreadyConfigured: '“{{loc}}” já está configurado.',
  langBaseLocale: 'Idioma base',
  langBaseLocaleHint: '— a fonte do idioma padrão; os campos base das seções são escritos nele.',
  langTranslationsLabel: 'Traduções (idiomas criados · o base é excluído)',
  langNoTranslations: 'Nenhuma tradução ainda — adicione um idioma para começar a traduzir as seções.',
  langRemoveLocale: 'Remover {{loc}}',
  langNewLocalePlaceholder: 'ex.: es, pt-BR, fr',
  langNewLocaleAria: 'Novo idioma (BCP-47)',
  langAdd: 'Adicionar',
  langAutoTranslate: 'Traduzir seções automaticamente ao publicar (uma dica; efetiva quando a tradução por IA estiver habilitada)',
} as const;
