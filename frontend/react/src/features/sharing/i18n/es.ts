/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Compartir',
  lede: 'Genere enlaces públicos imposibles de adivinar a una página o colección de conocimiento.',

  // Gating / empty states
  notEnabledTitle: 'Compartir no está activado',
  notEnabledBody: 'Solicite a un administrador que active la función Compartir para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: los enlaces de uso compartido pertenecen a una organización.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Resource-type display labels
  typeCmsPage: 'Página de CMS',
  typeKbCollection: 'Colección de KB',

  // Mint form
  mintTitle: 'Crear un enlace de uso compartido',
  fieldResourceType: 'Tipo de recurso',
  fieldResource: 'Recurso',
  resourcePlaceholder: '— seleccionar —',
  fieldLabel: 'Etiqueta (opcional)',
  labelPlaceholder: 'p. ej. Borrador para revisión',
  fieldExpiry: 'Caduca en días (opcional)',
  expiryPlaceholder: 'nunca',
  createLink: 'Crear enlace',

  // Active links
  activeTitle: 'Enlaces activos',
  noActiveLinks: 'No hay enlaces de uso compartido activos.',
  expiresAt: 'caduca {{date}}',
  copyLinkLabel: 'Copiar enlace público',
  revokeLinkLabel: 'Revocar',

  // Toasts
  linkCopied: 'Enlace copiado',
  linkCreated: 'Enlace de uso compartido creado',
  loadFailed: 'No se han podido cargar los enlaces.',
  createFailed: 'No se ha podido crear.',
  revokeFailed: 'No se ha podido revocar.',
  revokeShareConfirm: '¿Revocar este enlace para compartir? Cualquiera con la URL pierde el acceso.',
  typeDocument: 'Documento',
  typeConversation: 'Conversación',
  typePrompt: 'Prompt',

  // Visor público de solo lectura (ADR 0122 Phase 6)
  publicReadOnly: 'Vista compartida de solo lectura',
  publicLoading: 'Cargando la vista compartida',
  publicUntitled: 'Conversación compartida',
  publicEmpty: 'No hay nada que mostrar aquí.',
  publicGoneTitle: 'Este enlace ya no está disponible',
  publicGoneBody: 'El enlace para compartir puede haber caducado o haber sido revocado por su propietario.',
} as const;
