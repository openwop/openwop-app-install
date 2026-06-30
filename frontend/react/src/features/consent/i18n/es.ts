/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Consentimiento',
  lede: 'Política de consentimiento por región + herramientas para interesados (RGPD).',

  // Gating / empty states
  notEnabledTitle: 'El consentimiento no está habilitado',
  notEnabledBody: 'Pida a un administrador que habilite la función Consentimiento para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: la política de consentimiento pertenece a una organización.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Policy form
  regulatedRegionsLabel: 'Regiones reguladas (separadas por comas)',
  regulatedRegionsPlaceholder: 'EU, CA',
  defaultModeLabel: 'Modo predeterminado',
  defaultModeOptInLabel: 'consentimiento explícito (fallo cerrado)',
  defaultModeOptOutLabel: 'exclusión voluntaria',
  savePolicy: 'Guardar política',

  // Data subject (GDPR)
  dataSubjectTitle: 'Interesado (RGPD)',
  subjectKeyLabel: 'Clave del interesado',
  subjectKeyPlaceholder: 'cookie de visitante / id de usuario',
  lookup: 'Buscar',
  erase: 'Borrar',
  eraseConfirm: '¿Borrar todos los datos del interesado "{{subjectKey}}"? Eliminación de datos del interesado conforme al RGPD: no se puede deshacer.',
  lookupNoRecord: 'No hay registro de consentimiento para ese interesado: los datos posteriores (si los hay) se borran igualmente.',

  // Category chips
  categoryAnalytics: 'analítica',
  categoryMarketing: 'márquetin',
  categoryNecessaryOnly: 'solo necesarias',

  // Consent records
  recordsTitle: 'Registros de consentimiento',
  noRecords: 'Aún no hay registros de consentimiento.',

  // Toasts — success
  policySaved: 'Política guardada',
  subjectErased: 'Datos del interesado borrados',

  // Toasts / errors
  loadPolicyFailed: 'No se ha podido cargar la política.',
  saveFailed: 'No se ha podido guardar.',
  lookupFailed: 'La búsqueda ha fallado.',
  eraseFailed: 'El borrado ha fallado.',
} as const;
