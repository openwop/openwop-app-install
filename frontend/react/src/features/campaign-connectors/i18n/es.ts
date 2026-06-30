/**
 * `campaign-connectors` namespace (ADR 0159) — es. Página de Rendimiento de campaña.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Rendimiento de campaña',
  lede: 'Importa los CSV exportados de tus plataformas de anuncios a un esquema de métricas unificado y consulta los KPI por plataforma. La sincronización OAuth en vivo (Google / Meta / LinkedIn Ads) se conecta una vez configurada.',
  notEnabledTitle: 'Rendimiento de campaña no está activado',
  notEnabledBody: 'Pide a un administrador del espacio de trabajo que active la función Campaign Connectors.',

  importCsv: 'Importar CSV',
  importedSummary: 'Importadas {{imported}} filas nuevas · {{deduped}} actualizadas · {{invalid}} omitidas.',
  noOrgTitle: 'Aún no hay organización',
  noOrgBody: 'Crea primero una organización: los datos de rendimiento pertenecen a una.',
  fieldOrg: 'Organización',
  loading: 'Cargando rendimiento…',
  emptyTitle: 'Aún no hay datos de rendimiento',
  emptyBody: 'Importa un CSV de Google, Meta, LinkedIn u otra plataforma para ver tus KPI.',

  kpiSpend: 'Inversión',
  kpiImpressions: 'Impresiones',
  kpiClicks: 'Clics',
  kpiConversions: 'Conversiones',
  kpiRevenue: 'Ingresos',
  kpiRoas: 'ROAS',
  byPlatformTitle: 'Por plataforma',
  colPlatform: 'Plataforma',
  dateRange: '{{count}} registros · {{start}} → {{end}}',

  importHint: 'Pega el CSV exportado de tu plataforma de anuncios. Las columnas se detectan automáticamente (campaña, fecha, coste, impresiones, clics, conversiones, ingresos).',
  defaultPlatform: 'Plataforma predeterminada',
  csvLabel: 'Datos CSV',
  csvHelp: 'Fila de encabezado + una fila por día. Una columna Platform anula el valor predeterminado.',
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
