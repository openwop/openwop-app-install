/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Los enlaces de uso compartido pertenecen a una organización',
  orgsFailedClause: 'Los enlaces de uso compartido nunca llegaron a solicitarse',
  resourcesFailed: 'No se han podido cargar los recursos: reinténtalo',
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Compartir',
  lede: 'Genere enlaces públicos imposibles de adivinar a una página o colección de conocimiento.',

  // Gating / empty states
  notEnabledTitle: 'Compartir no está activado',
  notEnabledBody: 'Solicite a un administrador que active la función Compartir para este inquilino.',

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
  filterPlaceholder: 'Filtrar enlaces…',
  filterAria: 'Filtrar enlaces compartidos por etiqueta',
  noMatchBody: 'Ningún enlace coincide con su búsqueda.',
  clearSearch: 'Borrar búsqueda',
  noActiveLinks: 'No hay enlaces de uso compartido activos.',
  expiresAt: 'caduca {{date}}',
  copyLinkLabel: 'Copiar enlace público',
  linkCreatedCopied: 'Enlace creado — URL copiada al portapapeles.',
  linkMintedOnce: 'Copia este enlace ahora — se muestra solo una vez:',
  dismissMinted: 'Descartar',
  fingerprintTitle: 'La URL nunca se almacena',
  fingerprintLabel: 'Huella {{fingerprint}}…',
  revokeLinkLabel: 'Revocar',

  // Toasts
  linkCopied: 'Enlace copiado',
  linkCreated: 'Enlace de uso compartido creado',
  loadFailed: 'No se han podido cargar los enlaces.',
  createFailed: 'No se ha podido crear.',
  revokeFailed: 'No se ha podido revocar.',
  typeCreativeBrief: 'Brief creativo',
  typeBookingManage: 'Reserva (creado por la app)',
  typeSignRequest: 'Invitación de firma (creado por la app)',
  expiryInvalid: 'Introduce un número entero de días (1–3650), o déjalo vacío para que no caduque.',
  linksFailedTitle: 'No se pudieron cargar los enlaces de este espacio',
  linksFailedBody: 'Algo falló de nuestro lado — lo más probable es que tus enlaces sigan existiendo. Inténtalo de nuevo.',
  retryLabel: 'Reintentar',
  revokeDone: 'Enlace revocado — deja de funcionar de inmediato.',
  seenCount_one: 'Visto {{count}} vez',
  seenCount_other: 'Visto {{count}} veces',
  lastSeenOn: 'Visto por última vez {{date}}',
  viewCapLabel: 'límite de vistas {{n}}',
  createdOn: 'creado {{date}}',
  systemLinksToggle: 'Enlaces creados por la app ({{n}}) — reservas, firmas y pedidos',
  noMineLinks: 'Aún no hay enlaces creados por personas — los enlaces de abajo los creó la app.',
  showMoreLinks: 'Mostrar {{n}} más',
  quoteSubtotal: 'Subtotal',
  revokeShareConfirm: '¿Revocar este enlace para compartir? Cualquiera con la URL pierde el acceso.',
  typeDocument: 'Documento',
  typeConversation: 'Conversación',
  typePrompt: 'Prompt',
  typeCommerceQuote: 'Cotización',
  typeCommerceOrder: 'Pedido',
  typeAppBuilderCanvas: 'Diseño de aplicación',

  typeSlidesCanvas: "Presentaci\u00f3n",

  // Visor público de solo lectura (ADR 0122 Phase 6)
  publicReadOnly: 'Vista compartida de solo lectura',
  publicSnapshotAt: 'Instantánea del {{when}}',
  publicExpiresAt: 'el enlace caduca el {{when}}',
  publicLoading: 'Cargando la vista compartida',
  publicUntitled: 'Conversación compartida',
  publicEmpty: 'No hay nada que mostrar aquí.',
  publicGoneTitle: 'Este enlace ya no está disponible',
  publicGoneBody: 'Es posible que el propietario haya revocado el enlace, que haya alcanzado su límite de vistas o que el contenido al que apunta ya no se comparta.',
  publicLiveView: 'Vista en vivo — el propietario aún puede cambiar este contenido',
  publicExpiredTitle: 'Este enlace ha caducado',
  publicExpiredBody: 'El propietario fijó una caducidad para este enlace y ya pasó. Pídele un enlace nuevo.',
  publicLoadFailedTitle: 'No se pudo cargar esta vista compartida',
  publicLoadFailedBody: 'Algo falló de nuestro lado — lo más probable es que el enlace siga funcionando. Inténtalo de nuevo.',
  publicRetry: 'Reintentar',
  publicDraftedByAgent: 'Redactado por un agente de IA',
  publicGeneratedByWorkflow: 'Generado por un flujo de trabajo automatizado',
  publicPoweredBy: 'Compartido desde',
  quoteChip: 'Cotización',
  quoteTitle: 'Tu cotización',
  quoteValidUntil: 'Válida hasta',
  quoteTotal: 'Total',
  quoteAccept: 'Aceptar esta cotización',
  quoteAccepting: 'Aceptando…',
  quoteAccepted: 'Cotización aceptada: el pedido {{order}} quedó registrado. El vendedor te contactará sobre el pago.',
  quoteAcceptFailed: 'No se pudo aceptar la cotización: puede haber expirado o cambiado.',
  quoteNotOpen: 'Esta cotización no está abierta para aceptación en este momento.',
  frameViewsToggle: "Vistas por diapositiva",
  frameViewsLoading: "Cargando\u2026",
  frameViewsEmpty: "A\u00fan no hay vistas.",
  frameViewsUnavailable: 'No se pudieron cargar las visualizaciones.',
  frameViewsSlide: "Diapositiva {{n}}",

  // SHARE-UX-1/2/3 — link STATUS (a row carried none), the honest
  // expired/orphaned copy, and the copy-outcome-dependent mint claims.
  statusLive: 'Activo',
  statusExpiring: 'Caduca pronto',
  statusExpired: 'Caducado',
  statusRevoked: 'Revocado',
  statusOrphaned: 'Contenido eliminado',
  // SHARE-1 HONESTY — the gate made document/commerce/creative-brief links
  // darkenable, and the row used to render “Live” for them anyway.
  statusCapReached: 'Límite de vistas alcanzado',
  capReachedBody: 'Este enlace alcanzó su límite de {{n}} vista(s), por lo que ahora muestra “no disponible” a quien lo abra. Los límites de vistas no se pueden aumentar: crea un enlace nuevo si aún necesitas compartir esto.',
  statusFeatureOff: 'Función desactivada',
  featureOffBody: 'Un administrador desactivó la función {{feature}} en este espacio de trabajo, así que este enlace ahora muestra «no disponible» a quien lo abra. Vuelve a activar la función para restaurarlo, o revoca el enlace.',
  expiredAt: 'caducó el {{date}}',
  resourceMissingBody: 'El contenido al que apuntaba este enlace ya no existe: quien lo abra verá que el contenido fue eliminado. Revócalo para ordenar la lista.',
  deadLinksToggle: 'Enlaces caducados y revocados ({{n}})',
  linkCreatedNotCopied: 'Enlace creado, pero NO se pudo copiar. Cópialo del cuadro de arriba ahora; no se vuelve a mostrar.',
  linkMintedCopyFailed: 'Copia este enlace manualmente: el portapapeles fue bloqueado y solo se muestra una vez:',
  publicResourceGoneTitle: 'Este contenido compartido fue eliminado',
  publicResourceGoneBody: 'El enlace sigue funcionando, pero la página, el documento o el diseño al que apuntaba ya no existe. Pide un enlace actualizado a quien lo compartió.',
} as const;
