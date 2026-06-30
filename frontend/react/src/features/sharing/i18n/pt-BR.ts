/**
 * `sharing` namespace — user-facing copy for the sharing feature (ADR 0013).
 * Feature-self-contained: every sharing string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Compartilhamento',
  lede: 'Gere links públicos impossíveis de adivinhar para uma página ou coleção de conhecimento.',

  // Gating / empty states
  notEnabledTitle: 'O compartilhamento não está ativado',
  notEnabledBody: 'Peça a um administrador para ativar o recurso de Compartilhamento para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — links de compartilhamento pertencem a uma organização.',

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
  noActiveLinks: 'Nenhum link de compartilhamento ativo.',
  expiresAt: 'expira em {{date}}',
  copyLinkLabel: 'Copiar link público',
  revokeLinkLabel: 'Revogar',

  // Toasts
  linkCopied: 'Link copiado',
  linkCreated: 'Link de compartilhamento criado',
  loadFailed: 'Falha ao carregar os links.',
  createFailed: 'Falha ao criar.',
  revokeFailed: 'Falha ao revogar.',
  revokeShareConfirm: 'Revogar este link de compartilhamento? Qualquer pessoa com a URL perde o acesso.',
  typeDocument: 'Documento',
  typeConversation: 'Conversa',
  typePrompt: 'Prompt',

  // Visualizador público somente leitura (ADR 0122 Phase 6)
  publicReadOnly: 'Visualização compartilhada somente leitura',
  publicLoading: 'Carregando a visualização compartilhada',
  publicUntitled: 'Conversa compartilhada',
  publicEmpty: 'Nada para mostrar aqui.',
  publicGoneTitle: 'Este link não está mais disponível',
  publicGoneBody: 'O link de compartilhamento pode ter expirado ou sido revogado pelo proprietário.',
} as const;
