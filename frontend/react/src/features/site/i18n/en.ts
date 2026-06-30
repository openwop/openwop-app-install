/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero section
  heroEyebrow: 'An open standard for AI agents & workflows',
  heroHeading: 'AI coworkers that do real work — and stay yours.',
  heroSubheading: 'Build AI agents and automated workflows that handle real tasks, then run them anywhere — because what you build is portable, not locked to one vendor.',
  heroCtaLabel: 'Launch the app',
  heroCtaLabel2: 'See the open standard',

  // Default "how it works" columns section
  columnsEyebrow: 'How it works',
  columnsHeading: 'Build it. Run it. Stay in control.',
  columnBuildTitle: 'Build',
  columnBuildText: 'Design an agent or a workflow on a visual canvas — or start from a ready-made template.',
  columnRunTitle: 'Run',
  columnRunText: 'Watch it work in real time. Every run is repeatable and reviewable.',
  columnControlTitle: 'Stay in control',
  columnControlText: 'You decide what runs on its own and what needs your sign-off — with your own keys for connected apps.',

  // Default "open standard" rich-text section (markdown emphasis + link)
  introEyebrow: 'The open standard',
  introHeading: 'Build it once. Run it anywhere.',
  introText: 'OpenWOP is an **open standard** — like email or the web — that any provider can support, so the agents and workflows you build aren’t locked to one vendor. Read the full standard at [openwop.dev](https://openwop.dev).',

  // Default closing CTA section
  ctaHeading: 'See it for yourself.',
  ctaLabel: 'Open the app →',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Find a feature',
  catalogSearchPlaceholder: 'Search {{count}} features…',
  catalogSearchStatus: 'Showing {{count}} of {{total}}',
  catalogSearchClear: 'Clear search',
  catalogSearchEmpty: 'No features match “{{query}}”.',

  // FrontPageSettingsPanel — superadmin front-page editor
  eyebrow: 'Content',
  title: 'Front page',
  ledeDenied: 'The public homepage at /.',
  lede: 'The public homepage shown at / to anonymous visitors. Signed-in users always get the app.',
  homePageSaved: 'Home page saved.',
  saveFailed: 'Save failed.',
  saving: 'Saving…',
  savePublish: 'Save + publish',
  deniedNotice: 'Editing the homepage requires a <0>superadmin</0> principal (a tenant in <1>OPENWOP_SUPERADMIN_TENANTS</1>, or the admin bearer key).',
  frontPageToggle: '<0>Show the front page</0> at <1>/</1> (off ⇒ <2>/</2> is the app for everyone)',
  pageTitleLabel: 'Page title (browser tab / SEO)',
  sectionsHeading: 'Sections',
  previewHeading: 'Preview',
  addSectionToPreview: 'Add a section to preview.',
} as const;
