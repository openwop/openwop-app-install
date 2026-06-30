/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Comentários',
  lede: 'Comentários em thread nas suas páginas de CMS e coleções de KB.',

  // Gating / empty states
  notEnabledTitle: 'Comentários não está habilitado',
  notEnabledBody: 'Peça a um administrador para habilitar o recurso Comentários para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — os comentários pertencem aos recursos de uma organização.',
  pickResourceTitle: 'Escolha um recurso',
  pickResourceBody: 'Escolha uma página de CMS ou coleção de KB acima para ver e adicionar comentários.',
  noCommentsTitle: 'Nenhum comentário ainda',
  noCommentsBody: 'Seja o primeiro a deixar uma nota neste recurso.',

  // Resource picker
  resourceTypeLabel: 'Tipo de recurso',
  resourceLabel: 'Recurso',
  orgPickerLabel: 'Organização',
  resourceTypeCmsPage: 'Página de CMS',
  resourceTypeKbCollection: 'Coleção de KB',
  noResourcesCmsPage: 'Nenhuma página de CMS nesta organização',
  noResourcesKbCollection: 'Nenhuma coleção de KB nesta organização',

  // Author label (agent-authored comments)
  authorAgent: 'Agente',

  // Comment status chips
  statusOpen: 'aberto',
  statusResolved: 'resolvido',

  // Composer
  addCommentLabel: 'Adicionar um comentário',
  newCommentAria: 'Novo comentário',
  newCommentPlaceholder: 'Deixe uma nota neste recurso…',
  commentButton: 'Comentar',

  // Row actions
  reply: 'Responder',
  resolve: 'Resolver',
  reopen: 'Reabrir',
  deleteComment: 'Excluir comentário',
  replyAria: 'Responder',
  replyPlaceholder: 'Escreva uma resposta…',

  // Confirms / toasts / errors
  deleteConfirm: 'Excluir este comentário? As respostas dele também são removidas (é necessário um admin da organização se outras pessoas tiverem respondido). Isso não pode ser desfeito.',
  loadFailed: 'Falha ao carregar os comentários.',
  postFailed: 'Falha ao publicar.',
  updateFailed: 'Falha ao atualizar.',
  deleteFailed: 'Falha ao excluir.',
} as const;
