/**
 * `common` namespace — cross-cutting generic strings (actions, states) reused
 * across many surfaces. Feature-specific copy lives in that feature's own
 * catalog (`src/features/<id>/i18n/es.ts`) or its top-level area catalog.
 * Plural keys use i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
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
  create: 'Crear',
  remove: 'Quitar',
  retry: 'Reintentar',
  refresh: 'Actualizar',
  search: 'Buscar',
  searching: 'Buscando…',
  // Generic states
  loading: 'Cargando…',
  saving: 'Guardando…',
  none: 'Ninguno',
} as const;
