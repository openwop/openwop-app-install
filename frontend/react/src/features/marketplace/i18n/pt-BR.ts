/**
 * `marketplace` namespace — user-facing copy for the marketplace feature (ADR 0022).
 * Feature-self-contained: every marketplace string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Negócios',
  title: 'Marketplace',
  lede: 'Navegue e instale pacotes de recursos assinados do registro.',

  // Gating / empty states
  notEnabledTitle: 'O Marketplace não está habilitado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso Marketplace em Admin → Ativação de recursos.',
  noPacksFoundTitle: 'Nenhum pacote encontrado',
  noPacksFoundBodySearch: 'Nenhum pacote corresponde à sua busca. Tente um termo mais amplo.',
  noPacksFoundBodyEmpty: 'Ainda não há pacotes disponíveis no catálogo.',

  // Search / filter bar
  searchPlaceholder: 'Busque pacotes por nome, capacidade ou categoria',
  searchPacksLabel: 'Buscar pacotes',
  filterGroup: 'Filtrar pacotes',

  // Pack list / cards / rows
  packsLabel: 'Pacotes',
  installed: 'Instalado',
  notInstalled: 'Não instalado',
  subNoDescription: 'Nenhuma descrição fornecida.',
  requiredBy: 'Exigido por: {{packs}}',
  reviewsAction: 'Avaliações',
  install: 'Instalar',

  // Stars / rating
  starsReadLabel: '{{count}} de 5 estrelas',
  ratingLabel: 'Avaliação',
  starLabel_one: '{{count}} estrela',
  starLabel_other: '{{count}} estrelas',

  // Author
  authorAgent: 'Agente',

  // Reviews panel
  reviewsForLabel: 'Avaliações de {{pack}}',
  reviewsForTitle: 'Avaliações — {{pack}}',
  reviewsSummary: '{{average}} ({{total}})',
  noReviewsInline: 'Ainda sem avaliações',
  orgPickerLabel: 'Organização',
  closeReviewsLabel: 'Fechar avaliações',
  yourRating: 'Sua avaliação',
  commentOptional: 'Comentário (opcional)',
  commentPlaceholder: 'O que você achou deste pacote?',
  submitReview: 'Enviar avaliação',
  noReviewsTitle: 'Ainda sem avaliações',
  noReviewsBody: 'Seja o primeiro a avaliar este pacote com o formulário acima.',
  deleteReviewLabel: 'Excluir avaliação',

  // Toasts — success
  alreadyInstalled: '{{pack}} já está instalado.',
  installedToast: '{{pack}} instalado.',
  reviewSaved: 'Avaliação salva.',

  // Toasts / errors
  loadFailed: 'Falha ao carregar o marketplace.',
  installFailed: 'Falha na instalação.',
  pickRating: 'Escolha uma avaliação de 1 a 5.',
  reviewFailed: 'Falha na avaliação.',
  deleteFailed: 'Falha ao excluir.',
  loadReviewsFailed: 'Falha ao carregar as avaliações.',
} as const;
