/**
 * `publishing` namespace — user-facing copy for the publishing feature.
 * Feature-self-contained: every publishing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plateforme',
  orgsEmptyClause: 'Les pages du site et leur SEO appartiennent à une organisation',
  orgsFailedClause: 'La liste des pages n’a jamais été demandée',
  title: 'Publication et SEO',
  lede: 'Publiez des pages CMS sur un site public avec des métadonnées SEO, un sitemap et un flux RSS.',
  status_draft: 'brouillon',
  status_in_review: 'en relecture',
  status_published: 'publiée',
  status_archived: 'archivée',
  filterPlaceholder: 'Filtrer les pages…',
  filterAria: 'Filtrer les pages par titre ou slug',
  noMatchBody: 'Aucune page ne correspond à votre recherche.',
  clearSearch: 'Effacer la recherche',

  // Gating / empty states
  notEnabledTitle: 'La publication n’est pas activée',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Publication et SEO pour ce locataire.',
  selectPageTitle: 'Sélectionnez une page',
  selectPageBody: 'Choisissez une page pour modifier ses métadonnées SEO. Les pages publiées obtiennent une URL publique.',

  // aria-labels

  // Page list + site links
  pages: 'Pages',
  noPages: 'Aucune page CMS pour l’instant.',
  publicSite: 'Site public',
  copySitemapUrl: 'Copier l’URL du sitemap.xml',
  copyFeedUrl: 'Copier l’URL du feed.rss',

  // SEO editor header
  copyPublicUrl: 'Copier l’URL publique',
  publishToGoLive: 'Publiez dans le CMS pour mettre en ligne',

  // SEO editor field labels
  metaTitle: 'Titre meta',
  metaDescription: 'Description meta',
  ogTitle: 'Titre Open Graph',
  ogDescription: 'Description Open Graph',
  ogImage: 'Image Open Graph',
  canonicalUrl: 'URL canonique',
  noindexLabel: 'Exclure du sitemap et du flux (noindex)',

  // SEO editor placeholders
  metaDescriptionPlaceholder: 'Reprend le texte de la première section de la page',
  ogTitlePlaceholder: 'Reprend le titre meta',
  ogDescriptionPlaceholder: 'Reprend la description meta',
  ogImageNone: '— aucune —',
  canonicalUrlPlaceholder: 'https://… (remplacement facultatif)',

  // Buttons
  saveSeo: 'Enregistrer le SEO',

  // Toasts — success
  copied: 'Copié',
  seoSaved: 'SEO enregistré',

  // Toasts / errors
  loadPagesFailed: 'Échec du chargement des pages.',
  loadSeoFailed: 'Échec du chargement du SEO.',
  saveFailed: 'Échec de l’enregistrement.',
} as const;
