/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'Os links de compartilhamento pertencem a uma organização',
  orgsFailedClause: 'Os links de compartilhamento nunca chegaram a ser solicitados',
  resourcesFailed: 'Não foi possível carregar os recursos — tente novamente',
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Compartilhamento',
  lede: 'Gere links públicos impossíveis de adivinhar para uma página ou coleção de conhecimento.',

  // Gating / empty states
  notEnabledTitle: 'O compartilhamento não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de Compartilhamento para este tenant.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Resource-type display labels
  typeCmsPage: 'Página do CMS',
  typeKbCollection: 'Coleção de KB',

  // Mint form
  mintTitle: 'Criar um link de compartilhamento',
  fieldResourceType: 'Tipo de recurso',
  fieldResource: 'Recurso',
  resourcePlaceholder: '— selecione —',
  fieldLabel: 'Rótulo (opcional)',
  labelPlaceholder: 'ex.: Rascunho para revisão',
  fieldExpiry: 'Expira em dias (opcional)',
  expiryPlaceholder: 'nunca',
  createLink: 'Criar link',

  // Active links
  activeTitle: 'Links ativos',
  filterPlaceholder: 'Filtrar links…',
  filterAria: 'Filtrar links compartilhados por rótulo',
  noMatchBody: 'Nenhum link corresponde à sua busca.',
  clearSearch: 'Limpar busca',
  noActiveLinks: 'Nenhum link de compartilhamento ativo.',
  expiresAt: 'expira em {{date}}',
  copyLinkLabel: 'Copiar link público',
  linkCreatedCopied: 'Link criado — URL copiada para a área de transferência.',
  linkMintedOnce: 'Copie este link agora — mostrado apenas uma vez:',
  dismissMinted: 'Dispensar',
  fingerprintTitle: 'A URL nunca é armazenada',
  fingerprintLabel: 'Impressão {{fingerprint}}…',
  revokeLinkLabel: 'Revogar',

  // Toasts
  linkCopied: 'Link copiado',
  linkCreated: 'Link de compartilhamento criado',
  loadFailed: 'Falha ao carregar os links.',
  createFailed: 'Falha ao criar.',
  revokeFailed: 'Falha ao revogar.',
  typeCreativeBrief: 'Brief criativo',
  typeBookingManage: 'Agendamento (criado pelo app)',
  typeSignRequest: 'Convite de assinatura (criado pelo app)',
  expiryInvalid: 'Digite um número inteiro de dias (1–3650), ou deixe vazio para não expirar.',
  linksFailedTitle: 'Não foi possível carregar os links deste espaço',
  linksFailedBody: 'Algo deu errado do nosso lado — seus links provavelmente ainda existem. Tente novamente.',
  retryLabel: 'Tentar novamente',
  revokeDone: 'Link revogado — ele para de funcionar imediatamente.',
  seenCount_one: 'Visto {{count}} vez',
  seenCount_other: 'Visto {{count}} vezes',
  lastSeenOn: 'Visto pela última vez {{date}}',
  viewCapLabel: 'limite de visualizações {{n}}',
  createdOn: 'criado em {{date}}',
  systemLinksToggle: 'Links criados pelo app ({{n}}) — agendamentos, assinaturas e pedidos',
  noMineLinks: 'Ainda não há links criados por pessoas — os links abaixo foram criados pelo app.',
  showMoreLinks: 'Mostrar mais {{n}}',
  quoteSubtotal: 'Subtotal',
  revokeShareConfirm: 'Revogar este link de compartilhamento? Qualquer pessoa com a URL perde o acesso.',
  typeDocument: 'Documento',
  typeConversation: 'Conversa',
  typePrompt: 'Prompt',
  typeCommerceQuote: 'Orçamento',
  typeCommerceOrder: 'Pedido',
  typeAppBuilderCanvas: 'Design de aplicativo',

  typeSlidesCanvas: "Apresenta\u00e7\u00e3o",

  // Visualizador público somente leitura (ADR 0122 Phase 6)
  publicReadOnly: 'Visualização compartilhada somente leitura',
  publicSnapshotAt: 'Instantâneo de {{when}}',
  publicExpiresAt: 'o link expira em {{when}}',
  publicLoading: 'Carregando a visualização compartilhada',
  publicUntitled: 'Conversa compartilhada',
  publicEmpty: 'Nada para mostrar aqui.',
  publicGoneTitle: 'Este link não está mais disponível',
  publicGoneBody: 'O link pode ter sido revogado pelo proprietário, pode ter atingido seu limite de visualizações, ou o conteúdo para o qual ele aponta não está mais sendo compartilhado.',
  publicLiveView: 'Visualização ao vivo — o proprietário ainda pode alterar este conteúdo',
  publicExpiredTitle: 'Este link expirou',
  publicExpiredBody: 'O proprietário definiu uma expiração para este link e ela já passou. Peça um link novo.',
  publicLoadFailedTitle: 'Não foi possível carregar esta visualização compartilhada',
  publicLoadFailedBody: 'Algo deu errado do nosso lado — o link provavelmente ainda funciona. Tente novamente.',
  publicRetry: 'Tentar novamente',
  publicDraftedByAgent: 'Redigido por um agente de IA',
  publicGeneratedByWorkflow: 'Gerado por um fluxo de trabalho automatizado',
  publicPoweredBy: 'Compartilhado de',
  quoteChip: 'Orçamento',
  quoteTitle: 'Seu orçamento',
  quoteValidUntil: 'Válido até',
  quoteTotal: 'Total',
  quoteAccept: 'Aceitar este orçamento',
  quoteAccepting: 'Aceitando…',
  quoteAccepted: 'Orçamento aceito — o pedido {{order}} foi registrado. O vendedor entrará em contato sobre o pagamento.',
  quoteAcceptFailed: 'Não foi possível aceitar o orçamento — pode ter expirado ou mudado.',
  quoteNotOpen: 'Este orçamento não está aberto para aceitação no momento.',
  frameViewsToggle: "Visualiza\u00e7\u00f5es por slide",
  frameViewsLoading: "Carregando\u2026",
  frameViewsEmpty: "Ainda sem visualiza\u00e7\u00f5es.",
  frameViewsUnavailable: 'Não foi possível carregar as visualizações.',
  frameViewsSlide: "Slide {{n}}",

  // SHARE-UX-1/2/3 — link STATUS (a row carried none), the honest
  // expired/orphaned copy, and the copy-outcome-dependent mint claims.
  statusLive: 'Ativo',
  statusExpiring: 'Expira em breve',
  statusExpired: 'Expirado',
  statusRevoked: 'Revogado',
  statusOrphaned: 'Conteúdo excluído',
  // SHARE-1 HONESTY — the gate made document/commerce/creative-brief links
  // darkenable, and the row used to render “Live” for them anyway.
  statusCapReached: 'Limite de visualizações atingido',
  capReachedBody: 'Este link atingiu seu limite de {{n}} visualização(ões) e agora mostra “indisponível” para quem o abrir. Limites de visualizações não podem ser aumentados — crie um novo link se ainda precisar compartilhar isto.',
  statusFeatureOff: 'Recurso desativado',
  featureOffBody: 'Um administrador desativou o recurso {{feature}} neste espaço de trabalho, então este link agora mostra “indisponível” para quem o abrir. Reative o recurso para restaurá-lo, ou revogue o link.',
  expiredAt: 'expirou em {{date}}',
  resourceMissingBody: 'O conteúdo para o qual este link apontava não existe mais — quem abrir verá um aviso de que o conteúdo foi excluído. Revogue o link para organizar a lista.',
  deadLinksToggle: 'Links expirados e revogados ({{n}})',
  linkCreatedNotCopied: 'Link criado — mas NÃO foi possível copiá-lo. Copie-o da caixa acima agora; ele nunca será exibido de novo.',
  linkMintedCopyFailed: 'Copie este link manualmente — a área de transferência foi bloqueada e ele é mostrado apenas uma vez:',
  publicResourceGoneTitle: 'Este conteúdo compartilhado foi excluído',
  publicResourceGoneBody: 'O link continua funcionando, mas a página, o documento ou o design para o qual ele apontava não existe mais. Peça um link atualizado a quem compartilhou.',
} as const;
