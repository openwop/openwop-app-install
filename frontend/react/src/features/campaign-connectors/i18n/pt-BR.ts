/**
 * `campaign-connectors` namespace (ADR 0159) — pt-BR. Página de Desempenho de Campanha.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Desempenho de Campanha',
  lede: 'Importe os CSVs exportados das suas plataformas de anúncios para um esquema de métricas unificado e veja os KPIs por plataforma. A sincronização OAuth ao vivo (Google / Meta / LinkedIn Ads) conecta quando configurada.',
  notEnabledTitle: 'Desempenho de Campanha não está ativado',
  notEnabledBody: 'Peça a um administrador do workspace para ativar a feature Campaign Connectors.',

  importCsv: 'Importar CSV',
  importedSummary: 'Importadas {{imported}} novas linhas · {{deduped}} atualizadas · {{invalid}} ignoradas.',
  noOrgTitle: 'Nenhuma organização ainda',
  noOrgBody: 'Crie uma organização primeiro — os dados de desempenho pertencem a uma.',
  fieldOrg: 'Organização',
  loading: 'Carregando desempenho…',
  emptyTitle: 'Nenhum dado de desempenho ainda',
  emptyBody: 'Importe um CSV do Google, Meta, LinkedIn ou outra plataforma para ver seus KPIs.',

  kpiSpend: 'Investimento',
  kpiImpressions: 'Impressões',
  kpiClicks: 'Cliques',
  kpiConversions: 'Conversões',
  kpiRevenue: 'Receita',
  kpiRoas: 'ROAS',
  byPlatformTitle: 'Por plataforma',
  colPlatform: 'Plataforma',
  dateRange: '{{count}} registros · {{start}} → {{end}}',

  importHint: 'Cole o CSV exportado da sua plataforma de anúncios. As colunas são detectadas automaticamente (campanha, data, custo, impressões, cliques, conversões, receita).',
  defaultPlatform: 'Plataforma padrão',
  csvLabel: 'Dados CSV',
  csvHelp: 'Linha de cabeçalho + uma linha por dia. Uma coluna Platform substitui o padrão.',
  import: 'Importar',

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
