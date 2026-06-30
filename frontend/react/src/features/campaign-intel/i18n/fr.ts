/**
 * `campaign-intel` namespace (ADR 0160) — fr. Intelligence de campagne.
 */
export const messages = {
  eyebrow: 'Marketing',
  intelTitle: 'Intelligence de campagne',
  intelLede: 'Des recommandations fondées sur la performance de vos campagnes — où déplacer le budget, quelles créations s’essoufflent et où va la période. Demandez des précisions à l’Analyste.',
  intelNotEnabledTitle: 'Intelligence de campagne n’est pas activée',
  intelNotEnabledBody: 'Demandez à un administrateur de l’espace de travail d’activer la fonctionnalité Intelligence de campagne.',

  askAnalyst: 'Demander à l’Analyste',
  noOrgTitle: 'Aucune organisation pour l’instant',
  noOrgBody: 'Créez d’abord une organisation : l’intelligence s’exécute sur ses données de performance.',
  fieldOrg: 'Organisation',
  loading: 'Analyse de la performance…',
  intelEmptyTitle: 'Pas encore assez de données',
  intelEmptyBody: 'Importez la performance des campagnes (page Performance) pour que l’Analyste recommande des ajustements de budget et repère l’essoufflement créatif.',

  budgetTitle: 'Recommandation de budget',
  projectedGain: 'Retour projeté du transfert : {{gain}}.',
  colPlatform: 'Plateforme',
  colCurrent: 'Actuel',
  colSuggested: 'Suggéré',
  colRoas: 'ROAS',

  forecastTitle: 'Prévision',
  fatigueFlag: 'Essoufflement créatif · CTR −{{drop}}',
  healthy: 'Sain',
  projectionLabel: 'Projection {{spend}} · {{conv}} conv. sur {{days}} j',

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
