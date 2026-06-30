/**
 * `campaign-intel` namespace (ADR 0160) — pt-BR. Inteligência de Campanha.
 */
export const messages = {
  eyebrow: 'Marketing',
  intelTitle: 'Inteligência de Campanha',
  intelLede: 'Recomendações baseadas em dados do desempenho das suas campanhas — para onde mover o orçamento, quais criativos estão desgastando e para onde o período caminha. Pergunte ao Analista para detalhes.',
  intelNotEnabledTitle: 'Inteligência de Campanha não está ativada',
  intelNotEnabledBody: 'Peça a um administrador do workspace para ativar a feature Inteligência de Campanha.',

  askAnalyst: 'Perguntar ao Analista',
  noOrgTitle: 'Nenhuma organização ainda',
  noOrgBody: 'Crie uma organização primeiro — a inteligência roda sobre os dados de desempenho dela.',
  fieldOrg: 'Organização',
  loading: 'Analisando desempenho…',
  intelEmptyTitle: 'Dados insuficientes ainda',
  intelEmptyBody: 'Importe o desempenho das campanhas (na página Desempenho) para o Analista recomendar mudanças de orçamento e detectar desgaste criativo.',

  budgetTitle: 'Recomendação de orçamento',
  projectedGain: 'Retorno projetado da mudança: {{gain}}.',
  colPlatform: 'Plataforma',
  colCurrent: 'Atual',
  colSuggested: 'Sugerido',
  colRoas: 'ROAS',

  forecastTitle: 'Previsão',
  fatigueFlag: 'Desgaste criativo · CTR −{{drop}}',
  healthy: 'Saudável',
  projectionLabel: 'Projeção {{spend}} · {{conv}} conv. em {{days}}d',

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
