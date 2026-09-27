/**
 * `agentAllowlists` namespace — editor de listas de ferramentas de agentes (ADR 0104).
 * Brazilian Portuguese (pt-BR).
 */
export const messages = {
  eyebrow: 'Plataforma',
  title: 'Listas de ferramentas de agentes',
  lede: 'Conceda ou revogue as ferramentas oferecidas a um agente — sem editar um pacote. As substituições se aplicam por espaço de trabalho e entram em vigor na próxima execução.',
  loading: 'Carregando agentes…',
  loadFailed: 'Falha ao carregar os agentes.',
  saveFailed: 'Falha ao salvar a substituição.',
  resetFailed: 'Falha ao restaurar o valor do pacote.',
  noAgentsTitle: 'Nenhum agente encontrado',
  noAgentsBody: 'Não há agentes executáveis instalados para este espaço de trabalho.',
  agentListLabel: 'Agentes',
  overriddenChip: 'substituição',
  pickAgentTitle: 'Escolha um agente',
  pickAgentBody: 'Escolha um agente à esquerda para ver e editar as ferramentas oferecidas a ele.',
  agentIdChip: 'id: {{id}}',
  usingOverride: 'Substituição ({{n}} ferramentas)',
  usingManifest: 'Padrão do pacote + ferramentas da plataforma',
  explainer: 'As ferramentas marcadas são oferecidas a este agente. Seis ferramentas da plataforma ficam ativas por padrão para todos os agentes (marcadas como «ativa por padrão»); desmarcar uma a revoga para este agente, marcar outra a concede. Uma ferramenta não instalada só é oferecida quando seu pacote estiver montado.',
  toolChecklistLabel: 'Ferramentas para {{label}}',
  defaultOnTag: 'ativa por padrão',
  manifestTag: 'padrão do pacote',
  notMountedTag: 'não montada',
  resetToManifest: 'Restaurar padrão do pacote',
  saveOverride: 'Salvar substituição',
  pinWarning: 'Salvar fixa este agente nas ferramentas marcadas aqui. Ele não receberá mais automaticamente novas ferramentas ativas por padrão até você Restaurar o padrão do pacote.',
  saving: 'Salvando…',
  loadFailedTitle: "Não foi possível carregar as listas de ferramentas permitidas",
  loadFailedBody: "Esta é uma leitura que falhou, não uma lista vazia: a lista de cada agente está inalterada.",
  retry: "Tentar novamente",
} as const;
