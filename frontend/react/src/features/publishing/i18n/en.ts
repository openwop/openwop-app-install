/**
 * `publishing` namespace — user-facing copy for the publishing feature.
 * Feature-self-contained: every publishing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  orgsEmptyClause: 'Site pages and their SEO belong to an organization',
  orgsFailedClause: 'The page list was never requested',
  title: 'Publishing & SEO',
  lede: 'Publish CMS pages to a public site with SEO metadata, sitemap, and RSS.',
  status_draft: 'draft',
  status_in_review: 'in review',
  status_published: 'published',
  status_archived: 'archived',
  filterPlaceholder: 'Filter pages…',
  filterAria: 'Filter pages by title or slug',
  noMatchBody: 'No page matches your search.',
  clearSearch: 'Clear search',

  // Gating / empty states
  notEnabledTitle: 'Publishing is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Publishing & SEO feature for this tenant.',
  selectPageTitle: 'Select a page',
  selectPageBody: 'Pick a page to edit its SEO metadata. Published pages get a public URL.',

  // aria-labels

  // Page list + site links
  pages: 'Pages',
  noPages: 'No CMS pages yet.',
  publicSite: 'Public site',
  copySitemapUrl: 'Copy sitemap.xml URL',
  copyFeedUrl: 'Copy feed.rss URL',

  // SEO editor header
  copyPublicUrl: 'Copy public URL',
  publishToGoLive: 'Publish in the CMS to go live',

  // SEO editor field labels
  metaTitle: 'Meta title',
  metaDescription: 'Meta description',
  ogTitle: 'Open Graph title',
  ogDescription: 'Open Graph description',
  ogImage: 'Open Graph image',
  canonicalUrl: 'Canonical URL',
  noindexLabel: 'Exclude from sitemap + feed (noindex)',

  // SEO editor placeholders
  metaDescriptionPlaceholder: 'Falls back to the page’s first section text',
  ogTitlePlaceholder: 'Falls back to meta title',
  ogDescriptionPlaceholder: 'Falls back to meta description',
  ogImageNone: '— none —',
  canonicalUrlPlaceholder: 'https://… (optional override)',

  // Buttons
  saveSeo: 'Save SEO',

  // Toasts — success
  copied: 'Copied',
  seoSaved: 'SEO saved',

  // Toasts / errors
  loadPagesFailed: 'Failed to load pages.',
  loadSeoFailed: 'Failed to load SEO.',
  saveFailed: 'Save failed.',
} as const;
