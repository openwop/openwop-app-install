/**
 * `campaign-studio` namespace (ADR 0158) — pt-BR. Cópia para a página de Campanhas.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Campanhas',
  lede: 'Execute uma campanha multicanal a partir de um briefing — o Estrategista de Campanha gera o kernel de mensagem, todos os canais e uma verificação de consistência, e finaliza a campanha aqui.',
  notEnabledTitle: 'Campaign Studio não está ativado',
  notEnabledBody: 'Peça a um administrador do workspace para ativar a feature do Campaign Studio.',

  loading: 'Carregando campanhas…',
  emptyTitle: 'Nenhuma campanha ainda',
  emptyBody: 'Finalize um briefing confirmado em uma campanha, ou execute uma de ponta a ponta com o Estrategista de Campanha.',
  runWithStrategist: 'Executar com o Estrategista',
  finalizeBrief: 'Finalizar um briefing',
  hasKernel: 'Kernel',
  channelsCount_one: '{{count}} canal',
  channelsCount_other: '{{count}} canais',
  deleteTitle: 'Excluir esta campanha?',
  deleteBody: 'A campanha será removida. O briefing de origem não é afetado. Não pode ser desfeito.',

  status_draft: 'Rascunho',
  status_active: 'Ativa',
  status_paused: 'Pausada',
  status_completed: 'Concluída',
  status_archived: 'Arquivada',

  finalizeHint: 'Escolha um briefing confirmado — uma campanha é criada (ou atualizada) a partir dele. Uma campanha por briefing.',
  fieldOrg: 'Organização',
  allOrgs: 'Todas as organizações',
  fieldBrief: 'Briefing',
  noBriefs: 'Nenhum briefing encontrado',
  finalize: 'Finalizar',

  backToCampaigns: 'Campanhas',
  statusLabel: 'Status',
  kernelTitle: 'Kernel de mensagem',
  kernelCta: 'CTA',
  kernelTone: 'Tom',
  noKernel: 'Esta campanha ainda não tem kernel de mensagem.',
  channelsTitle: 'Canais',
  noChannels: 'Nenhum canal ativado.',

  channel_landing_page: 'Landing page',
  channel_ad_variants: 'Variações de anúncio',
  channel_email_sequence: 'Sequência de e-mail',
  channel_creative_briefs: 'Briefings criativos',
  channel_social_posts: 'Posts sociais',
} as const;
