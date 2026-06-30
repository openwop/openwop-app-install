/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Espacio de trabajo',
  title: 'Comentarios',
  lede: 'Comentarios en hilo en sus páginas de CMS y colecciones de la base de conocimiento.',

  // Gating / empty states
  notEnabledTitle: 'Los comentarios no están habilitados',
  notEnabledBody: 'Pida a un administrador que habilite la función de Comentarios para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización — los comentarios pertenecen a los recursos de una organización.',
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

  // Confirms / toasts / errors
  deleteConfirm: '¿Eliminar este comentario? Sus respuestas también se eliminan (se requiere un administrador de la organización si otras personas han respondido). Esto no se puede deshacer.',
  loadFailed: 'No se pudieron cargar los comentarios.',
  postFailed: 'Error al publicar.',
  updateFailed: 'Error al actualizar.',
  deleteFailed: 'Error al eliminar.',
} as const;
