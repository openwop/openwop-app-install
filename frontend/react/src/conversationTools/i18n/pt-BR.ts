/**
 * `conversationTools` namespace (ADR 0132) — escopo de ferramentas por conversa.
 * Portuguese (Brazil) (pt-BR).
 */
export const messages = {
  openTitle: 'Escopo de ferramentas para esta conversa',
  heading: 'Escopo de ferramentas da conversa',
  blurb: 'Controle quais ferramentas do agente ele pode usar nesta conversa e quais exigem sua aprovação primeiro. Apenas restringe — nunca concede ferramentas além das permissões do agente.',
  pendingHeading: 'Aprovações pendentes',
  noPending: 'Nenhuma ferramenta aguardando aprovação.',
  approve: 'Aprovar',
  deny: 'Negar',
  approveAria: 'Aprovar {{tool}}',
  denyAria: 'Negar {{tool}}',
  scopeHeading: 'Acesso a ferramentas',
  modeLegend: 'Modo de escopo de ferramentas',
  modeDefault: 'Padrão do agente (todas as ferramentas dele)',
  modeRestricted: 'Restrito (apenas as ferramentas abaixo)',
  list_enabled: 'Habilitadas',
  list_disabled: 'Desabilitadas',
  list_requireApproval: 'Exigem aprovação',
  addPlaceholder: 'id da ferramenta (ex.: crm.contact.update)',
  removeAria: 'Remover {{tool}}',
  close: 'Fechar',
  save: 'Salvar escopo',
  saving: 'Salvando…',
  saved: 'Escopo de ferramentas salvo',
  loadFailed: 'Falha ao carregar o escopo de ferramentas.',
  decisionFailed: 'Falha ao registrar sua decisão.',
  saveFailed: 'Falha ao salvar o escopo de ferramentas.',
};
