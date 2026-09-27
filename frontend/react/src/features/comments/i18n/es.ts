/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Los comentarios pertenecen a los recursos de una organización',
  orgsFailedClause: 'La lista de recursos nunca llegó a solicitarse',
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Comentarios',
  lede: 'Comentarios en hilo en sus páginas de CMS y colecciones de la base de conocimiento.',

  // Gating / empty states
  notEnabledTitle: 'Los comentarios no están habilitados',
  notEnabledBody: 'Pida a un administrador que habilite la función de Comentarios para este inquilino.',
  resourcesFailed: 'No se pudieron cargar los recursos de esta organización: la lista puede estar incompleta, no vacía.',
  resourcesFailedOption: 'Error de carga: reintente',
  resourceFromLink: 'Desde su enlace',
  pickResourceTitle: 'Elija un recurso',
  pickResourceBody: 'Elija una página de CMS o una colección de la base de conocimiento arriba para ver y añadir comentarios.',
  noCommentsTitle: 'Aún no hay comentarios',
  noCommentsBody: 'Sea el primero en dejar una nota en este recurso.',

  // Resource picker
  resourceTypeLabel: 'Tipo de recurso',
  resourceLabel: 'Recurso',
  orgPickerLabel: 'Organización',
  resourceTypeCmsPage: 'Página de CMS',
  resourceTypeKbCollection: 'Colección de base de conocimiento',
  noResourcesCmsPage: 'No hay páginas de CMS en esta organización',
  noResourcesKbCollection: 'No hay colecciones de base de conocimiento en esta organización',
  resourceTypeChatMessage: 'Mensaje de chat',
  resourceTypeCanvasDocument: 'Documento enriquecido',
  noResourcesChatMessage: 'No hay mensajes de chat en esta organización',
  noResourcesCanvasDocument: 'Aún no hay documentos.',
  resourceTypePriorityIdea: 'Idea priorizada',
  resourceTypeCreativeBrief: 'Brief creativo',
  noResourcesPriorityIdea: 'No hay ideas priorizadas en esta organización',
  noResourcesCreativeBrief: 'No hay briefs creativos en esta organización',

  // CMNT-1 — el enlace profundo de la notificación
  linkedThreadLabel: 'Hilo de tu enlace',
  backToPicker: 'Ver otros recursos',
  linkedResourceMissing: 'Este recurso no está disponible para ti. Puede que se haya eliminado o que no tengas acceso a él.',
  resourceGoneTitle: 'Este recurso no está disponible',
  unsupportedTypeTitle: 'Tipo de recurso no admitido',
  unsupportedTypeBody: 'Este enlace nombra un tipo de recurso sobre el que este espacio de trabajo no admite comentarios ({{type}}). No se sustituyó nada: es probable que el enlace esté obsoleto o mal escrito.',
  browseAllComments: 'Ver comentarios',
  // ADR 0021 extension — comentario en línea en el chat
  inlineToggle: 'Comentar',
  inlineToggleAria: 'Mostrar comentarios de este mensaje',

  // Author label (agent-authored comments)
  authorAgent: 'Agente',

  // Comment status chips
  statusOpen: 'abierto',
  statusResolved: 'resuelto',

  // Composer
  addCommentLabel: 'Añadir un comentario',
  newCommentAria: 'Nuevo comentario',
  newCommentPlaceholder: 'Deje una nota en este recurso…',
  commentButton: 'Comentar',

  // Row actions
  reply: 'Responder',
  resolve: 'Resolver',
  reopen: 'Reabrir',
  deleteComment: 'Eliminar comentario',
  replyAria: 'Responder',
  replyPlaceholder: 'Escriba una respuesta…',

  // CMNT-UX-2 / CMNT-UX-3 — honestidad ante fallos de lectura + confirmación de escritura
  threadFailedBody: 'No pudimos leer este hilo, así que no podemos decir qué contiene: no está necesariamente vacío. Reintenta o recarga la página.',
  composerBlockedByFailure: 'Los comentarios están en pausa hasta que se cargue el hilo; de lo contrario podrías repetir algo ya dicho.',
  composerBlockedByReadOnly: 'Tienes acceso de solo lectura a este espacio de trabajo, así que puedes leer este hilo pero no añadir nada. Pide a un administrador de la organización acceso de edición (workspace:write) para comentar.',
  commentPosted: 'Comentario publicado.',
  replyPosted: 'Respuesta publicada.',
  markedResolved: 'Marcado como resuelto.',
  markedReopened: 'Reabierto.',
  commentDeleted: 'Comentario eliminado.',

  // CMNT-UX-5 / -8 / -9 — identidad, límite del cuerpo y rechazos de borrado con nombre
  directoryNamesFallback: 'No pudimos cargar el directorio de miembros de esta organización, así que los autores se muestran por id en lugar de por nombre.',
  bodyCounter: '{{used}} / {{max}} caracteres',
  deleteForbidden: 'No puedes eliminar este comentario: solo su autor o un administrador de la organización puede hacerlo. Puedes marcarlo como resuelto.',
  deleteHasForeignReplies: 'Otras personas han respondido a este comentario, así que solo un administrador de la organización puede eliminarlo. Márcalo como resuelto para cerrar el hilo.',

  // Confirms / toasts / errors
  deleteConfirm: '¿Eliminar este comentario? Sus respuestas también se eliminan (se requiere un administrador de la organización si otras personas han respondido). Esto no se puede deshacer.',
  loadFailed: 'No se pudieron cargar los comentarios.',
  postFailed: 'Error al publicar.',
  updateFailed: 'Error al actualizar.',
  deleteFailed: 'Error al eliminar.',
  writeGone: 'Esto ya no está disponible, así que no se guardó nada. Puede que se haya eliminado o que ya no tengas acceso.',
  writeForbidden: 'No puedes hacer ese cambio: solo su autor o un administrador de la organización puede.',
  writeForbiddenScope: 'Tienes acceso de solo lectura a este espacio de trabajo, así que ese cambio no se guardó. Pide acceso de edición a un administrador de la organización.',
  writeInvalid: 'No se pudo guardar: revisa el texto e inténtalo de nuevo.',
} as const;
