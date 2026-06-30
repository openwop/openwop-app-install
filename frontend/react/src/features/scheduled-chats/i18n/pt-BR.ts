/** `scheduled-chats` namespace (ADR 0125). */
export const messages = {
  eyebrow: 'Plataforma',
  title: 'Chats agendados',
  lede: 'Faça um agente executar um chat de forma agendada (um resumo diário, um relatório de segunda) e publicar o resultado em uma conversa.',
  org: 'Espaço',
  colAgent: 'Agente',
  colSchedule: 'Agenda',
  colStatus: 'Status',
  delete: 'Excluir',
  active: 'Ativo',
  inert: 'Inerte',
  empty: 'Nenhum chat agendado ainda.',
  emptyHint: 'Crie um chat agendado para executar um agente via cron.',
  loadError: 'Não foi possível carregar os chats agendados.',
  disabled: 'Os chats agendados estão desativados neste espaço.',
  colNextRun: 'Próxima execução',
} as const;
