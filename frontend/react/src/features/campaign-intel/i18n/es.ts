/**
 * `campaign-intel` namespace (ADR 0160) — es. Inteligencia de campaña.
 */
export const messages = {
  eyebrow: 'Marketing',
  intelTitle: 'Inteligencia de campaña',
  intelLede: 'Recomendaciones basadas en datos del rendimiento de tus campañas: dónde mover el presupuesto, qué creatividades se desgastan y hacia dónde va el período. Pregunta al Analista para más detalle.',
  intelNotEnabledTitle: 'Inteligencia de campaña no está activada',
  intelNotEnabledBody: 'Pide a un administrador del espacio de trabajo que active la función Inteligencia de campaña.',

  askAnalyst: 'Preguntar al Analista',
  noOrgTitle: 'Aún no hay organización',
  noOrgBody: 'Crea primero una organización: la inteligencia se ejecuta sobre sus datos de rendimiento.',
  fieldOrg: 'Organización',
  loading: 'Analizando rendimiento…',
  intelEmptyTitle: 'Aún no hay datos suficientes',
  intelEmptyBody: 'Importa el rendimiento de campaña (en la página Rendimiento) para que el Analista recomiende cambios de presupuesto y detecte el desgaste creativo.',

  budgetTitle: 'Recomendación de presupuesto',
  projectedGain: 'Retorno proyectado del cambio: {{gain}}.',
  colPlatform: 'Plataforma',
  colCurrent: 'Actual',
  colSuggested: 'Sugerido',
  colRoas: 'ROAS',

  forecastTitle: 'Previsión',
  fatigueFlag: 'Desgaste creativo · CTR −{{drop}}',
  healthy: 'Saludable',
  projectionLabel: 'Proyección {{spend}} · {{conv}} conv. en {{days}}d',

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
