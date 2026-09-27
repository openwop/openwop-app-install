/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Quem pode acessar minha memória"
  grantsIntro: 'Agentes que você permitiu acessar seu corpus como seu <0>gêmeo digital</0>. Revogar interrompe na hora todo acesso seguinte — inclusive no meio de um turno em andamento. Não é possível retirar o que já foi acessado: o conteúdo acessado antes nesse mesmo turno permanece nele, e não é possível apagar o que um agente já escreveu em uma conversa anterior. O recall responde só a você: quando outra pessoa — um colega, ou uma automação sem atribuição — se dirige ao seu gêmeo, ela não obtém nada da sua memória. Em uma chamada de voz ao vivo, o conteúdo composto no início da chamada permanece nessa chamada até ela terminar.',
  failedToLoadGrants: 'Falha ao carregar as permissões.',
  recallRevokedEverywhere: 'Acesso revogado. Nenhum acesso a partir de agora.',
  revokeFailed: 'Falha ao revogar.',
  loading: 'Carregando…',
  noAgentTitle: 'Nenhum agente pode acessar sua memória',
  noAgentBody: 'Abra a <0>aba Integrações</0> de um agente para torná-lo seu gêmeo e permitir o acesso. Depois disso ele aparece aqui.',
  noScopes: 'sem escopos',
  identityUnknown: 'Não foi possível confirmar qual perfil é o seu, então não dá para saber se este gêmeo está vinculado a você. As configurações de recordação ficam ocultas até isso ser sabido — isto não confirma que nenhuma recordação foi concedida.',
  twinOfUnknown: 'Gêmeo de (dono não confirmado)',
  agentNamesUnavailable: 'Não foi possível carregar os nomes dos agentes, então as permissões abaixo mostram ids brutos. Revogar continua funcionando.',
  revoke: 'Revogar',
  revokeNothingToRevoke: 'Nada a revogar — esse acesso já havia terminado.',
  scopeUnknown: 'um tipo de acesso não reconhecido',
  // TWIN-UX-4 — visibilidade de uso nos cartões de consentimento
  failedToLoadRecalls: 'Falha ao carregar a atividade de recall.',
  recallsUnavailable: 'A atividade de recall não pôde ser carregada — é uma leitura com falha, não a confirmação de que nada foi lembrado.',
  lastRecalled_one: 'Último recall: {{date}} · {{count}} vez',
  lastRecalled_other: 'Último recall: {{date}} · {{count}} vezes',
  neverRecalled: 'Nenhum recall ainda.',
  deniedRecallAttempts_one: '{{count}} tentativa de outra pessoa foi negada',
  deniedRecallAttempts_other: '{{count}} tentativas de outras pessoas foram negadas',

  // AgentTwinPanel — afordância "Gêmeo de …"
  digitalTwin: 'Gêmeo digital',
  panelIntro: 'Vincule {{persona}} a uma pessoa para que possa agir como seu gêmeo digital. O agente pode acessar a memória ou o conhecimento dessa pessoa <0>somente após ela conceder a permissão</0> — um vínculo por si só não concede nada.',
  failedToLoadTwinLink: 'Falha ao carregar o vínculo do gêmeo.',
  twinLoadFailedBody: 'Não foi possível ler o vínculo de gêmeo de {{persona}}. É uma leitura com falha, não uma resposta: não significa que {{persona}} esteja sem vínculo, por isso a ação de vincular fica retida até que funcione.',
  twinRetry: 'Tentar novamente',
  actionFailed: 'Falha na ação.',
  notTwinYet: '{{persona}} ainda não é gêmeo de ninguém.',
  nowYourTwin: '{{persona}} agora é seu gêmeo.',
  makeTwinOfMe: 'Tornar {{persona}} um gêmeo meu',
  twinOfYou: 'Gêmeo de <0>você</0>',
  twinOfPerson: 'Gêmeo de',
  twinLinkRemoved: 'Vínculo de gêmeo removido.',
  unlink: 'Desvincular',
  unlinkConfirmTitle: 'Desvincular {{persona}} desta pessoa?',
  unlinkConfirmBody: 'Isso remove o vínculo de gêmeo E revoga o consentimento de {{name}} para que {{persona}} acesse a memória ou o conhecimento dela. Ela não é notificada. Poderá conceder de novo depois que você vincular outra vez.',
  unlinkConfirmBodySelf: 'Isso remove o vínculo de gêmeo E revoga o seu consentimento para que {{persona}} acesse a sua memória ou o seu conhecimento. Você poderá conceder de novo depois de vincular outra vez.',
  unlinkNothingRemoved: 'Não havia vínculo de gêmeo para remover.',
  allowRecallHeading: 'Permitir que {{persona}} acesse sua…',
  scopeMemory: 'memória',
  scopeKnowledge: 'conhecimento',
  recallConsentSaved: 'Consentimento de acesso salvo.',
  updateConsent: 'Atualizar consentimento',
  allowRecall: 'Permitir acesso',
  recallRevoked: 'Acesso revogado.',
  revokeRecall: 'Revogar acesso',
  recallActive: 'Ativo — {{persona}} pode acessar seu {{scopes}}. Revogar interrompe na hora todo acesso seguinte; o conteúdo já acessado — mesmo antes no mesmo turno — permanece, e não apaga o que {{persona}} já escreveu. Ele só faz recall quando é você mesmo quem fala com ele — qualquer outra pessoa não obtém nada.',
  recallActiveNothing: 'nada',
  recallActiveEmpty: 'Ativo, mas sem escopos selecionados — {{persona}} não pode ler nada. Escolha memória ou conhecimento acima.',
  noRecallGranted: 'Nenhum acesso concedido ainda — {{persona}} não pode ler sua memória ou conhecimento.',
  onlyLinkedCanAllow: 'Apenas {{name}} pode permitir que {{persona}} acesse a memória ou o conhecimento dele(a).',
  grantsLoadFailedTitle: "Não foi possível carregar o acesso dos agentes",
  grantsLoadFailedBody: "Esta é uma leitura que falhou, não uma lista vazia: não significa que nenhum agente tem acesso a você.",
  grantsRetry: "Tentar novamente",

  // ProfilePage — a aba de gêmeo quando a LEITURA do interruptor de recurso falhou
  toggleReadFailedTitle: 'Não foi possível verificar se o acesso de gêmeo está habilitado aqui',
  toggleReadFailedBody: 'A verificação do recurso falhou, então não podemos mostrar seu painel de consentimento — é uma leitura que falhou, não uma confirmação de que o acesso esteja desligado ou de que nenhum agente tenha acesso a você.',
} as const;
