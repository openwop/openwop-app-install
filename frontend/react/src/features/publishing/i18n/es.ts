/**
 * `publishing` namespace — user-facing copy for the publishing feature.
 * Feature-self-contained: every publishing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Publicación y SEO',
  lede: 'Publique páginas del CMS en un sitio público con metadatos SEO, mapa del sitio y RSS.',

  // Gating / empty states
  notEnabledTitle: 'La publicación no está habilitada',
  notEnabledBody: 'Pida a un administrador que habilite la función Publicación y SEO para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: un sitio pertenece a una organización.',
  selectPageTitle: 'Seleccione una página',
  selectPageBody: 'Elija una página para editar sus metadatos SEO. Las páginas publicadas obtienen una URL pública.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Page list + site links
  pages: 'Páginas',
  noPages: 'Aún no hay páginas del CMS.',
  publicSite: 'Sitio público',
  copySitemapUrl: 'Copiar URL de sitemap.xml',
  copyFeedUrl: 'Copiar URL de feed.rss',

  // SEO editor header
  copyPublicUrl: 'Copiar URL pública',
  publishToGoLive: 'Publique en el CMS para ponerla en marcha',

  // SEO editor field labels
  metaTitle: 'Meta título',
  metaDescription: 'Meta descripción',
  ogTitle: 'Título Open Graph',
  ogDescription: 'Descripción Open Graph',
  ogImage: 'Imagen Open Graph',
  canonicalUrl: 'URL canónica',
  noindexLabel: 'Excluir del mapa del sitio y del feed (noindex)',

  // SEO editor placeholders
  metaDescriptionPlaceholder: 'Se utiliza el texto de la primera sección de la página',
  ogTitlePlaceholder: 'Se utiliza el meta título',
  ogDescriptionPlaceholder: 'Se utiliza la meta descripción',
  ogImageNone: '— ninguna —',
  canonicalUrlPlaceholder: 'https://… (anulación opcional)',

  // Buttons
  saveSeo: 'Guardar SEO',

  // Toasts — success
  copied: 'Copiado',
  seoSaved: 'SEO guardado',

  // Toasts / errors
  loadPagesFailed: 'No se han podido cargar las páginas.',
  loadSeoFailed: 'No se ha podido cargar el SEO.',
  saveFailed: 'No se ha podido guardar.',
} as const;
