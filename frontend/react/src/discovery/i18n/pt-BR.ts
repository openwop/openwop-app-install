/**
 * `discovery` namespace — user-facing copy for the Host capabilities page
 * (CapabilitiesPanel): coverage, host surfaces, envelope discipline, model
 * capabilities, input modalities, conformance & profiles.
 */
export const messages = {
  eyebrow: 'Discovery',
  title: 'Capacidades do host',
  lede: 'O que este host consegue e não consegue executar — para você saber quais workflows vão funcionar aqui e por que alguns estão bloqueados.',
  explainTitle: 'Como ler esta página',
  explainBody: 'Comece pelo topo: “Cobertura de packs” mostra quantos blocos instalados este host consegue executar e quais estão bloqueados e por quê. Todo o resto — superfícies do host, envelopes, capacidades do modelo — é o anúncio de protocolo detalhado do host, útil para diagnosticar conformidade.',

  // Pack coverage
  packCoverage: 'Cobertura de packs',
  packCoverageHelpPrefix: 'O número único que responde "este host consegue executar meu workflow?" — nós executáveis sobre o catálogo instalado completo. Alterne ',
  packCoverageHelpBlocked: 'Bloqueado',
  packCoverageHelpSuffix: ' para restringir a tabela apenas às superfícies que estão bloqueando a execução.',
  coverageAriaLabel: 'Cobertura de packs',
  figureRunnable: 'Executáveis',
  figureTotalNodes: 'Total de nós',
  figureBlocked: 'Bloqueados',
  blockedTableCaption: 'Nós bloqueados por superfície',
  colBlockedBySurface: 'Bloqueado por superfície',
  colNodes: 'Nós',
  allRunnableClearPrefix: 'Todos os {{count}} nós executáveis atendem a todas as superfícies obrigatórias. Selecione ',
  allRunnableClearBlocked: 'Bloqueado',
  allRunnableClearSuffix: ' para ver os {{blocked}} que não atendem.',
  everyNodeRunnableTitle: 'Todos os nós instalados são executáveis aqui',
  everyNodeRunnableBody:
    'Nenhum nó no catálogo está sem uma superfície de host — este host consegue executar o conjunto completo de packs.',

  // Host surfaces
  hostSurfaces: 'Superfícies do host',
  hostSurfacesHelpPrefix: 'Renderização ao vivo de ',
  hostSurfacesHelpImplLead: '. A coluna',
  hostSurfacesHelpImplEm: 'implementação',
  hostSurfacesHelpImplMid: ' informa o que sustenta cada superfície — valores como ',
  hostSurfacesHelpImplOr: ' ou ',
  hostSurfacesHelpImplTail: ' significam que a superfície não é durável. A Fase 6 troca esses por adaptadores de backend real de ',
  hostSurfacesHelpEnd: '.',
  surfacesTableCaption: 'Superfícies do host',
  noSurfacesTitle: 'Nenhuma superfície de host anunciada',
  noSurfacesBodyPrefix: 'O ',
  noSurfacesBodySuffix: ' deste host está vazio.',
  colSurface: 'Superfície',
  colSupported: 'Suportado',
  colImplementation: 'Implementação',
  colNote: 'Nota',

  // Envelope discipline
  envelopeDiscipline: 'Disciplina de envelope',
  envelopeHelp:
    'O que este host promete sobre os envelopes de emissão do LLM — o formato do payload de entrada que todo nó de IA serve para a execução. Quando uma linha exibe —, o host ainda não anunciou essa superfície.',
  envelopeHelp2:
    'Quando os eventos de confiabilidade abaixo disparam em uma execução, eles aparecem ao vivo no chat de IA como chips inline dentro do balão do assistente (retentativas, recusas, truncamentos, substituições de modelo, coerções de prosa para JSON, recuperações de payload parcial).',
  envelopeTableCaption: 'Disciplina de envelope',
  colValue: 'Valor',
  envReasoningSupportedNoteLead: 'opcional',
  envReasoningSupportedNoteTail: 'string nos payloads de envelope',
  envReasoningDirectiveNote: 'com que agressividade o host instrui o modelo a preenchê-la',
  envTierOneNote: 'postura do host sobre o subconjunto de schema OpenAI ∩ Anthropic ∩ Gemini',
  envReliabilitySupportedNote: 'o host emite eventos de retentativa / recusa / truncamento',
  envReliabilityEventsNote: 'quais tipos de evento de confiabilidade este host de fato emite',
  envTruncationNote: 'o host ramifica a estratégia de retentativa em truncamento vs. violação de schema',
  envTruncationBudgetNote: 'quanto orçamento extra de saída o host concede em uma retentativa por truncamento',

  // Model capabilities
  modelCapabilities: 'Capacidades do modelo',
  modelCapabilitiesHelpPrefix:
    'O que cada provedor/modelo instalado consegue fazer (function-calling, visão, streaming, etc.) e se este host substituirá silenciosamente por um modelo de fallback quando o workflow pedir uma capacidade que o modelo configurado não tem. A substituição é observável pelo evento ',
  modelCapabilitiesHelpSuffix: '.',
  advertised: 'Anunciado',
  notAdvertised: 'Não anunciado',
  substitutionOn: 'Substituição ativada',
  substitutionOff: 'Substituição desativada',
  declaredCount: '{{count}} declarado(s)',
  modelCapsNotAdvertisedTitle: 'Capacidades do modelo não anunciadas',
  modelCapsNotAdvertisedBodyPrefix: 'Este host ainda não declara ',
  modelCapsNotAdvertisedBodySuffix: ', então o comportamento de substituição de capacidades é desconhecido.',

  // Input modalities
  inputModalities: 'Modalidades de entrada',
  inputModalitiesHelpPrefix: 'As modalidades de percepção que este host aceita como ',
  inputModalitiesHelpMid: ' ContentParts. ',
  inputModalitiesHelpTextEm: 'texto',
  inputModalitiesHelpAfterText: ' é sempre válido; uma modalidade não textual só é aceita quando anunciada aqui, caso contrário a chamada é rejeitada com ',
  inputModalitiesHelpSuffix: '.',
  noModalitiesTitle: 'Nenhuma modalidade não textual anunciada',
  noModalitiesBodyPrefix: 'Este host ainda não declara ',
  noModalitiesBodyMid: ' — apenas ',
  noModalitiesBodySuffix: ' ContentParts são aceitos.',

  // Raw advertisement
  rawAdvertisement: 'Anúncio bruto',
  rawAdvertisementHelpPrefix: 'Payload ',
  rawAdvertisementHelpSuffix: ' completo.',
  rawCapsAriaLabel: 'JSON bruto de capacidades',

  // Conformance & profiles
  conformanceAndProfiles: 'Conformidade & perfis',
  conformanceHelpPrefix: 'A identidade do host conectado + cada perfil que ele anuncia por meio de ',
  conformanceHelpAnd: ' e ',
  conformanceHelpMid: ' — as superfícies com que um implementador externo pode contar. Veja o ',
  conformanceLeaderboardLink: 'ranking de conformidade',
  conformanceHelpSuffix: ' para a matriz de taxa de aprovação entre hosts.',
  implementationLabel: 'Implementação',
  versionPrefix: 'v{{version}}',
  vendorPrefix: '· {{vendor}}',
  profilesClaimed: 'Perfis reivindicados ({{count}})',
  noneAdvertised: 'nenhum anunciado',
  referenceHostBadge: 'Selo de host de referência',
  badgeAlt: 'Selo de conformidade {{label}}',
  noBadgePrefix:
    'Nenhum selo publicado para esta implementação. Hosts que correspondem a uma referência (in-memory, sqlite, postgres, python) recebem um inline; veja o ',
  leaderboard: 'ranking',
  noBadgeSuffix: ' para todos os hosts publicados.',
  emDash: '—',

  // Badge host labels
  badgePostgres: 'Host de referência Postgres',
  badgeSqlite: 'Host de referência SQLite',
  badgePython: 'Host de referência Python em memória',
  badgeInMemory: 'Host de referência em memória',
} as const;
