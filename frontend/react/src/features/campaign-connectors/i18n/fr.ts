/**
 * `campaign-connectors` namespace (ADR 0159) — fr. Page Performance des campagnes.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Performance des campagnes',
  lede: 'Importez les CSV exportés de vos plateformes publicitaires dans un schéma de métriques unifié et consultez les KPI par plateforme. La synchronisation OAuth en direct (Google / Meta / LinkedIn Ads) se connecte une fois configurée.',
  notEnabledTitle: 'Performance des campagnes n’est pas activé',
  notEnabledBody: 'Demandez à un administrateur de l’espace de travail d’activer la fonctionnalité Campaign Connectors.',

  importCsv: 'Importer un CSV',
  importedSummary: '{{imported}} nouvelles lignes importées · {{deduped}} mises à jour · {{invalid}} ignorées.',
  noOrgTitle: 'Aucune organisation pour l’instant',
  noOrgBody: 'Créez d’abord une organisation : les données de performance appartiennent à une organisation.',
  fieldOrg: 'Organisation',
  loading: 'Chargement de la performance…',
  emptyTitle: 'Aucune donnée de performance',
  emptyBody: 'Importez un CSV depuis Google, Meta, LinkedIn ou une autre plateforme pour voir vos KPI.',

  kpiSpend: 'Dépense',
  kpiImpressions: 'Impressions',
  kpiClicks: 'Clics',
  kpiConversions: 'Conversions',
  kpiRevenue: 'Revenu',
  kpiRoas: 'ROAS',
  byPlatformTitle: 'Par plateforme',
  colPlatform: 'Plateforme',
  dateRange: '{{count}} enregistrements · {{start}} → {{end}}',

  importHint: 'Collez le CSV exporté de votre plateforme publicitaire. Les colonnes sont détectées automatiquement (campagne, date, coût, impressions, clics, conversions, revenu).',
  defaultPlatform: 'Plateforme par défaut',
  csvLabel: 'Données CSV',
  csvHelp: 'Ligne d’en-tête + une ligne par jour. Une colonne Platform remplace la valeur par défaut.',
  import: 'Importer',

  platform_google: 'Google Ads',
  platform_meta: 'Meta Ads',
  platform_linkedin: 'LinkedIn Ads',
  platform_tiktok: 'TikTok',
  platform_x: 'X (Twitter)',
  platform_pinterest: 'Pinterest',
  platform_snapchat: 'Snapchat',
  platform_reddit: 'Reddit',
  platform_youtube: 'YouTube',
} as const;
