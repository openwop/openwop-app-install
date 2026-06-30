/**
 * `campaign-studio` namespace (ADR 0158) — es. Texto para la página de Campañas.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Campañas',
  lede: 'Ejecuta una campaña multicanal a partir de un brief: el Estratega de campañas genera el núcleo de mensaje, todos los canales y una verificación de consistencia, y finaliza la campaña aquí.',
  notEnabledTitle: 'Campaign Studio no está activado',
  notEnabledBody: 'Pide a un administrador del espacio de trabajo que active la función Campaign Studio.',

  loading: 'Cargando campañas…',
  emptyTitle: 'Aún no hay campañas',
  emptyBody: 'Finaliza un brief confirmado en una campaña, o ejecuta una de principio a fin con el Estratega de campañas.',
  runWithStrategist: 'Ejecutar con el Estratega',
  finalizeBrief: 'Finalizar un brief',
  hasKernel: 'Núcleo',
  channelsCount_one: '{{count}} canal',
  channelsCount_other: '{{count}} canales',
  deleteTitle: '¿Eliminar esta campaña?',
  deleteBody: 'La campaña se elimina. El brief de origen no se toca. Esto no se puede deshacer.',

  status_draft: 'Borrador',
  status_active: 'Activa',
  status_paused: 'En pausa',
  status_completed: 'Completada',
  status_archived: 'Archivada',

  finalizeHint: 'Elige un brief confirmado: se crea (o actualiza) una campaña a partir de él. Una campaña por brief.',
  fieldOrg: 'Organización',
  allOrgs: 'Todas las organizaciones',
  fieldBrief: 'Brief',
  noBriefs: 'No se encontraron briefs',
  finalize: 'Finalizar',

  backToCampaigns: 'Campañas',
  statusLabel: 'Estado',
  kernelTitle: 'Núcleo de mensaje',
  kernelCta: 'CTA',
  kernelTone: 'Tono',
  noKernel: 'Esta campaña aún no tiene núcleo de mensaje.',
  channelsTitle: 'Canales',
  noChannels: 'Ningún canal activado.',

  channel_landing_page: 'Página de aterrizaje',
  channel_ad_variants: 'Variantes de anuncio',
  channel_email_sequence: 'Secuencia de correo',
  channel_creative_briefs: 'Briefs creativos',
  channel_social_posts: 'Publicaciones sociales',
} as const;
