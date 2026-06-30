/**
 * `marketplace` namespace — user-facing copy for the marketplace feature (ADR 0022).
 * Feature-self-contained: every marketplace string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negocio',
  title: 'Mercado',
  lede: 'Explore e instale paquetes de funciones firmados desde el registro.',

  // Gating / empty states
  notEnabledTitle: 'El mercado no está habilitado',
  notEnabledBody: 'Pida a un administrador que active la función de mercado en Administración → Conmutadores de funciones.',
  noPacksFoundTitle: 'No se encontraron paquetes',
  noPacksFoundBodySearch: 'Ningún paquete coincide con su búsqueda. Pruebe un término más amplio.',
  noPacksFoundBodyEmpty: 'Aún no hay paquetes disponibles en el catálogo.',

  // Search / filter bar
  searchPlaceholder: 'Buscar paquetes por nombre, capacidad o categoría',
  searchPacksLabel: 'Buscar paquetes',
  filterGroup: 'Filtrar paquetes',

  // Pack list / cards / rows
  packsLabel: 'Paquetes',
  installed: 'Instalado',
  notInstalled: 'No instalado',
  subNoDescription: 'Sin descripción.',
  requiredBy: 'Requerido por: {{packs}}',
  reviewsAction: 'Reseñas',
  install: 'Instalar',

  // Stars / rating
  starsReadLabel: '{{count}} de 5 estrellas',
  ratingLabel: 'Valoración',
  starLabel_one: '{{count}} estrella',
  starLabel_other: '{{count}} estrellas',

  // Author
  authorAgent: 'Agente',

  // Reviews panel
  reviewsForLabel: 'Reseñas de {{pack}}',
  reviewsForTitle: 'Reseñas — {{pack}}',
  reviewsSummary: '{{average}} ({{total}})',
  noReviewsInline: 'Aún no hay reseñas',
  orgPickerLabel: 'Organización',
  closeReviewsLabel: 'Cerrar reseñas',
  yourRating: 'Su valoración',
  commentOptional: 'Comentario (opcional)',
  commentPlaceholder: '¿Qué le pareció este paquete?',
  submitReview: 'Enviar reseña',
  noReviewsTitle: 'Aún no hay reseñas',
  noReviewsBody: 'Sea el primero en valorar este paquete con el formulario de arriba.',
  deleteReviewLabel: 'Eliminar reseña',

  // Toasts — success
  alreadyInstalled: '{{pack}} ya está instalado.',
  installedToast: '{{pack}} instalado.',
  reviewSaved: 'Reseña guardada.',

  // Toasts / errors
  loadFailed: 'No se pudo cargar el mercado.',
  installFailed: 'Error al instalar.',
  pickRating: 'Elija una valoración del 1 al 5.',
  reviewFailed: 'Error al enviar la reseña.',
  deleteFailed: 'Error al eliminar.',
  loadReviewsFailed: 'No se pudieron cargar las reseñas.',
} as const;
