/**
 * `comments` namespace — user-facing copy for the Comments feature (ADR 0021).
 * Feature-self-contained: every comments string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Os comentários pertencem aos recursos de uma organização',
  orgsFailedClause: 'A lista de recursos nunca chegou a ser solicitada',
  // Page chrome
  eyebrow: 'Workspace',
  title: 'Comentários',
  lede: 'Comentários em thread nas suas páginas de CMS e coleções de KB.',

  // Gating / empty states
  notEnabledTitle: 'Comentários não está habilitado',
  notEnabledBody: 'Peça a um administrador para habilitar o recurso Comentários para este tenant.',
  resourcesFailed: 'Não foi possível carregar os recursos desta organização — a lista pode estar incompleta, não vazia.',
  resourcesFailedOption: 'Falha ao carregar — tentar de novo',
  resourceFromLink: 'Do seu link',
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
  resourceTypeChatMessage: 'Mensagem de chat',
  resourceTypeCanvasDocument: 'Documento formatado',
  noResourcesChatMessage: 'Nenhuma mensagem de chat nesta organização',
  noResourcesCanvasDocument: 'Ainda não há documentos.',
  resourceTypePriorityIdea: 'Ideia priorizada',
  resourceTypeCreativeBrief: 'Briefing criativo',
  noResourcesPriorityIdea: 'Nenhuma ideia priorizada nesta organização',
  noResourcesCreativeBrief: 'Nenhum briefing criativo nesta organização',

  // CMNT-1 — o link direto da notificação
  linkedThreadLabel: 'Thread do seu link',
  backToPicker: 'Ver outros recursos',
  linkedResourceMissing: 'Este recurso não está disponível para você. Ele pode ter sido excluído ou você pode não ter acesso a ele.',
  resourceGoneTitle: 'Este recurso não está disponível',
  unsupportedTypeTitle: 'Tipo de recurso não suportado',
  unsupportedTypeBody: 'Este link cita um tipo de recurso em que este workspace não aceita comentários ({{type}}). Nada foi substituído: o link provavelmente está desatualizado ou digitado errado.',
  browseAllComments: 'Ver comentários',
  // ADR 0021 extension — comentário embutido no chat
  inlineToggle: 'Comentar',
  inlineToggleAria: 'Mostrar comentários desta mensagem',

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

  // CMNT-UX-2 / CMNT-UX-3 — honestidade na falha de leitura + retorno da escrita
  threadFailedBody: 'Não conseguimos ler esta thread, então não podemos dizer o que há nela — ela não está necessariamente vazia. Tente novamente ou recarregue a página.',
  composerBlockedByFailure: 'Os comentários estão pausados até a thread carregar; caso contrário, você pode repetir algo que já foi dito.',
  composerBlockedByReadOnly: 'Você tem acesso somente leitura a este workspace, então pode ler esta thread mas não adicionar nada. Peça a um administrador da organização acesso de edição (workspace:write) para comentar.',
  commentPosted: 'Comentário publicado.',
  replyPosted: 'Resposta publicada.',
  markedResolved: 'Marcado como resolvido.',
  markedReopened: 'Reaberto.',
  commentDeleted: 'Comentário excluído.',

  // CMNT-UX-5 / -8 / -9 — identidade, limite do corpo e recusas de exclusão nomeadas
  directoryNamesFallback: 'Não conseguimos carregar o diretório de membros desta organização, então os autores abaixo aparecem por id em vez de por nome.',
  bodyCounter: '{{used}} / {{max}} caracteres',
  deleteForbidden: 'Você não pode excluir este comentário — apenas o autor ou um administrador da organização pode. Você pode marcá-lo como resolvido.',
  deleteHasForeignReplies: 'Outras pessoas responderam a este comentário, então apenas um administrador da organização pode excluí-lo. Marque como resolvido para encerrar a thread.',

  // Confirms / toasts / errors
  deleteConfirm: 'Excluir este comentário? As respostas dele também são removidas (é necessário um admin da organização se outras pessoas tiverem respondido). Isso não pode ser desfeito.',
  loadFailed: 'Falha ao carregar os comentários.',
  postFailed: 'Falha ao publicar.',
  updateFailed: 'Falha ao atualizar.',
  deleteFailed: 'Falha ao excluir.',
  writeGone: 'Isto não está mais disponível, então nada foi salvo. Pode ter sido excluído ou você pode não ter mais acesso.',
  writeForbidden: 'Você não pode fazer essa alteração — apenas o autor ou um administrador da organização pode.',
  writeForbiddenScope: 'Você tem acesso somente leitura a este workspace, então essa alteração não foi salva. Peça acesso de edição a um administrador da organização.',
  writeInvalid: 'Não foi possível salvar — verifique o texto e tente novamente.',
} as const;
