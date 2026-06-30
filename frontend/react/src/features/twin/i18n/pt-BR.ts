/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Quem pode acessar minha memória"
  grantsIntro: 'Agentes que você permitiu acessar seu corpus como seu <0>gêmeo digital</0>. A revogação tem efeito imediato — inclusive em qualquer execução já em andamento.',
  failedToLoadGrants: 'Falha ao carregar as permissões.',
  recallRevokedEverywhere: 'Acesso revogado — efetivo imediatamente, em todos os lugares.',
  revokeFailed: 'Falha ao revogar.',
  loading: 'Carregando…',
  noAgentTitle: 'Nenhum agente pode acessar sua memória',
  noAgentBody: 'Quando você torna um agente seu gêmeo e permite o acesso (no perfil do agente), ele aparece aqui.',
  noScopes: 'sem escopos',
  revoke: 'Revogar',

  // AgentTwinPanel — afordância "Gêmeo de …"
  digitalTwin: 'Gêmeo digital',
  panelIntro: 'Vincule {{persona}} a uma pessoa para que possa agir como seu gêmeo digital. O agente pode acessar a memória ou o conhecimento dessa pessoa <0>somente após ela conceder a permissão</0> — um vínculo por si só não concede nada.',
  failedToLoadTwinLink: 'Falha ao carregar o vínculo do gêmeo.',
  actionFailed: 'Falha na ação.',
  notTwinYet: '{{persona}} ainda não é gêmeo de ninguém.',
  nowYourTwin: '{{persona}} agora é seu gêmeo.',
  makeTwinOfMe: 'Tornar {{persona}} um gêmeo meu',
  twinOfYou: 'Gêmeo de <0>você</0>',
  twinOfPerson: 'Gêmeo de',
  twinLinkRemoved: 'Vínculo de gêmeo removido.',
  unlink: 'Desvincular',
  allowRecallHeading: 'Permitir que {{persona}} acesse sua…',
  scopeMemory: 'memória',
  scopeKnowledge: 'conhecimento',
  recallConsentSaved: 'Consentimento de acesso salvo.',
  updateConsent: 'Atualizar consentimento',
  allowRecall: 'Permitir acesso',
  recallRevoked: 'Acesso revogado.',
  revokeRecall: 'Revogar acesso',
  recallActive: 'Ativo — {{persona}} pode acessar seu {{scopes}}. A revogação é imediata, em todos os lugares.',
  recallActiveNothing: 'nada',
  noRecallGranted: 'Nenhum acesso concedido ainda — {{persona}} não pode ler sua memória ou conhecimento.',
  onlyLinkedCanAllow: 'Apenas {{name}} pode permitir que {{persona}} acesse a memória ou o conhecimento dele(a).',
} as const;
