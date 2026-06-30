/**
 * `publishing` namespace — user-facing copy for the publishing feature.
 * Feature-self-contained: every publishing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Publicação e SEO',
  lede: 'Publique páginas do CMS em um site público com metadados de SEO, sitemap e RSS.',

  // Gating / empty states
  notEnabledTitle: 'A publicação não está ativada',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de Publicação e SEO para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — um site pertence a uma organização.',
  selectPageTitle: 'Selecione uma página',
  selectPageBody: 'Escolha uma página para editar seus metadados de SEO. Páginas publicadas recebem uma URL pública.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Page list + site links
  pages: 'Páginas',
  noPages: 'Nenhuma página do CMS ainda.',
  publicSite: 'Site público',
  copySitemapUrl: 'Copiar URL do sitemap.xml',
  copyFeedUrl: 'Copiar URL do feed.rss',

  // SEO editor header
  copyPublicUrl: 'Copiar URL pública',
  publishToGoLive: 'Publique no CMS para entrar no ar',

  // SEO editor field labels
  metaTitle: 'Meta título',
  metaDescription: 'Meta descrição',
  ogTitle: 'Título do Open Graph',
  ogDescription: 'Descrição do Open Graph',
  ogImage: 'Imagem do Open Graph',
  canonicalUrl: 'URL canônica',
  noindexLabel: 'Excluir do sitemap + feed (noindex)',

  // SEO editor placeholders
  metaDescriptionPlaceholder: 'Usa como alternativa o texto da primeira seção da página',
  ogTitlePlaceholder: 'Usa como alternativa o meta título',
  ogDescriptionPlaceholder: 'Usa como alternativa a meta descrição',
  ogImageNone: '— nenhuma —',
  canonicalUrlPlaceholder: 'https://… (substituição opcional)',

  // Buttons
  saveSeo: 'Salvar SEO',

  // Toasts — success
  copied: 'Copiado',
  seoSaved: 'SEO salvo',

  // Toasts / errors
  loadPagesFailed: 'Falha ao carregar as páginas.',
  loadSeoFailed: 'Falha ao carregar o SEO.',
  saveFailed: 'Falha ao salvar.',
} as const;
