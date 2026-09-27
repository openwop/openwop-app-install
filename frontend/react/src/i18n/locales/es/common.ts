/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/es.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  inlineFailed: 'No se pudo cargar esta sección.',
  inlineEmpty: 'Aún no hay nada.',
  // App-shell chrome
  skipToContent: 'Saltar al contenido',
  privacy: 'Privacidad',
  language: 'Idioma',
  // Generic actions
  save: 'Guardar',
  cancel: 'Cancelar',
  close: 'Cerrar',
  delete: 'Eliminar',
  edit: 'Editar',
  back: 'Atrás',
  next: 'Siguiente',
  confirm: 'Confirmar',
  typeToConfirmLabel: 'Escriba {{value}} para confirmar',
  create: 'Crear',
  remove: 'Quitar',
  retry: 'Reintentar',
  // Template gallery (DESIGN.md §4.5 rule 14 — ui/TemplateGallery.tsx)
  templatesFilterGroup: 'Filtrar plantillas',
  templatesSearchPlaceholder: 'Buscar plantillas…',
  templatesSearchAria: 'Buscar plantillas por nombre',
  templatesCategoryAria: 'Filtrar plantillas por categoría',
  templatesAllCategories: 'Todas las categorías',
  templatesResultCount_one: '{{count}} plantilla coincide',
  templatesResultCount_other: '{{count}} plantillas coinciden',
  templatesNoMatchTitle: 'Ninguna plantilla coincide',
  templatesNoMatchBody: 'Pruebe otra búsqueda o borre los filtros para ver todo lo instalado.',
  templatesEmptyTitle: 'No hay plantillas instaladas',
  templatesEmptyBody: 'Las plantillas llegan con los paquetes. Instale uno o empiece en blanco.',
  templatesClearFilters: 'Borrar filtros',
  templatesUse: 'Usar plantilla',
  templatesUseNamed: 'Usar plantilla: {{name}}',

  deepLinkMissing: 'El elemento al que enlazaste ya no está disponible.',
  deepLinkMissingClear: 'Descartar',
  refresh: 'Actualizar',
  search: 'Buscar',
  searching: 'Buscando…',
  // Generic states
  loading: 'Cargando…',
  saving: 'Guardando…',
  none: 'Ninguno',
  // Shared people-picker (UserPicker) — the empty/no-selection options.
  userPickerNone: 'Sin asignar',
  runInputs: {
    title: 'Ejecutar {{name}}',
    blurb: 'Proporcione las entradas para esta ejecución. Los valores por defecto vienen rellenados; cámbielos solo para esta ejecución.',
    run: 'Ejecutar',
    starting: 'Iniciando…',
    requiredPlaceholder: 'Obligatorio',
    optionalPlaceholder: 'Opcional',
    missingHint: 'Complete las {{n}} entradas obligatorias para ejecutar.',
    credentialDefault: 'Clave predeterminada del espacio de trabajo',
    credentialHelp: 'Qué clave de API guardada usan los pasos de IA de esta ejecución. Las claves están en Configuración → Claves.',
  },
  // KTUX-10 — ONE localized transport-failure vocabulary. `classifyHttpError`
  // returns hardcoded ENGLISH copy; consuming it verbatim would ship English
  // into every locale while `check-i18n` passed green (it verifies KEY parity,
  // not language). Features map its `kind` discriminator to these keys.
  loadFailed: 'No se pudo cargar esto.',
  loadFailedTitle: 'No se pudo cargar esto',
  loadFailedBody: 'No se pudo leer la lista, por lo que no podemos indicar qué hay aquí. Reintenta o recarga la página.',
  'error_rate-limited': 'Demasiadas solicitudes ahora mismo: espera un momento y reinténtalo.',
  // ADR 0482 (ux-1) — el 429 por presupuesto agotado es una pausa deliberada, no un fallo.
  'error_budget-exhausted': 'Presupuesto diario alcanzado: las ejecuciones de este flujo de trabajo están en pausa hasta mañana (UTC). Sube o quita el presupuesto en el constructor para continuar.',
  errorBudgetExhausted: 'Presupuesto diario alcanzado: las ejecuciones de este flujo de trabajo están en pausa hasta mañana (UTC). Sube o quita el presupuesto en el constructor para continuar.',
  errorBudgetTitle: 'Presupuesto diario alcanzado',
  errorBudgetDetail: 'Las ejecuciones de este flujo de trabajo están en pausa hasta mañana (UTC). Sube o quita el presupuesto en el constructor para continuar.',
  error_offline: 'No se puede conectar con el servidor. Comprueba tu conexión y reinténtalo.',
  error_auth: 'Puede que tu sesión haya caducado. Inicia sesión de nuevo.',
  error_forbidden: "No tienes permiso para hacer eso aquí. Pide acceso a un administrador de este espacio de trabajo.",
  'error_not-found': 'Esto ya no está disponible.',
  error_server: 'Algo falló por nuestra parte. Reinténtalo en breve.',
  error_unknown: 'Algo salió mal. Reinténtalo.',
  'error_account-disabled': 'Un administrador desactivó esta cuenta. Contacta con el administrador de tu espacio de trabajo.',
  'error_account-erased': 'Esta cuenta ya no existe.',
  'error_session-revoked': 'Se cerró tu sesión en todos los dispositivos. Inicia sesión de nuevo para continuar.',
  cannotBeUndone: 'Esto no se puede deshacer.',
} as const;
