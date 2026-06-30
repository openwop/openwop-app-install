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
  usingManifest: 'Usando o padrão do pacote',
  explainer: 'As ferramentas marcadas são oferecidas a este agente. Desmarcar uma ferramenta do pacote a revoga; marcar outra a concede. Uma ferramenta não instalada só é oferecida quando seu pacote estiver montado.',
  toolChecklistLabel: 'Ferramentas para {{label}}',
  manifestTag: 'padrão do pacote',
  notMountedTag: 'não montada',
  resetToManifest: 'Restaurar padrão do pacote',
  saveOverride: 'Salvar substituição',
  saving: 'Salvando…',
} as const;
