/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero — the thesis, beside the run ledger (visual: 'run')
  heroHeading: 'O trabalho da IA acontece na execução. Agora a execução é aberta.',
  heroSubheading: 'Agentes não seguem um roteiro. Eles decidem enquanto trabalham: qual ferramenta chamar, o que repassar, quando parar e perguntar a você. OpenWOP é um protocolo aberto para essa execução, e aqui você pode criar uma, acompanhá-la e levá-la com você.',
  heroCtaLabel: 'Comece a criar, sem cadastro',
  heroCtaLabel2: 'Ler o protocolo',

  // The "workflow" hero visual (HeroSchematic) — kept for CMS pages that pick it
  heroVignetteName: 'OpenWOP / fluxo de trabalho',
  heroVignetteReady: 'pronto para executar',
  heroVignetteContext: '01 · contexto',
  heroVignetteBrief: 'Novo briefing',
  heroVignetteCapture: 'Enquadre o trabalho',
  heroVignetteWorkflow: '02 · fluxo de trabalho',
  heroVignetteRoute: 'Encaminhe e decida',
  heroVignetteTogether: 'Pessoas e IA juntas',
  heroVignetteRecord: '03 · registro',
  heroVignetteReview: 'Revise a execução',
  heroVignetteReplay: 'Reexecutável por design',
  heroVignetteOpen: 'Padrão aberto',
  heroVignetteInfrastructure: 'Sua infraestrutura',

  // The hero run ledger (SectionRenderer HeroRunLedger). Event names are wire
  // literals and stay untranslated; these are their plain-language glosses.
  heroRunName: 'execução r-7f3a',
  heroRunLog: 'log de eventos',
  heroRunStarted: 'A execução começa com seus dados',
  heroRunDecided: 'O agente escolhe uma ferramenta',
  heroRunToolReturned: 'A ferramenta responde; a saída é marcada como não confiável',
  heroRunBudget: 'O gasto é conferido contra o limite',
  heroRunApprovalRequested: 'O próximo passo não tem volta, então a execução para',
  heroRunWaiting: 'pausada por uma pessoa',
  heroRunApprovalGranted: 'Uma pessoa diz sim',
  heroRunCompleted: 'Concluída, e reproduzível a partir de qualquer passo',
  heroRunFooter: 'Os mesmos eventos, em qualquer host compatível',

  // Default story: why the run matters (richText, markdown emphasis)
  shiftHeading: 'O software costumava fazer exatamente o que mandavam.',
  shiftText: 'Por décadas, o software fez o que alguém escreveu, linha por linha. Agentes são diferentes: eles tomam decisões *durante a execução*. Então a execução passou a ser onde o valor é criado, onde as coisas dão errado e onde alguém precisa responder pelo resultado.\n\nHoje cada plataforma constrói essa execução do seu jeito, e nenhuma concorda com a outra. O trabalho dos seus agentes pertence a quem os hospeda.',

  // Default story: the history lesson (richText)
  historyHeading: 'Já vimos como isso termina.',
  historyText: 'Padrões de fluxo de trabalho como BPMN e BPEL chegaram a um acordo sobre como um processo é *desenhado*. Executá-lo continuou proprietário, e os desenhos nunca viajaram de fato. O e-mail e a web foram pelo caminho oposto: SMTP e HTTP padronizaram a *conversa* entre máquinas, e todo mundo pôde construir em cima disso.\n\nO OpenWOP faz a mesma aposta para o trabalho com IA. Não padronize o diagrama. Padronize a execução.',

  // Default story: what an open run guarantees (columns, layout 'rows')
  openHeading: 'O que muda quando a execução é aberta',
  openLeaveTitle: 'Você pode sair.',
  openLeaveText: 'Leve seus agentes, pacotes e fluxos de trabalho para outro host compatível. Os segredos são vinculados de novo no host novo, nunca copiados.',
  openSeeTitle: 'Você vê o porquê.',
  openSeeText: 'Cada decisão, chamada de ferramenta e repasse é um evento em um vocabulário compartilhado, legível por qualquer ferramenta, não só pela que executou.',
  openDecideTitle: 'Uma pessoa decide o que não tem volta.',
  openDecideText: 'A aprovação faz parte do protocolo, não é um plugin. A execução para e espera onde você mandar.',
  openBoundTitle: 'Nada roda sem limite.',
  openBoundText: 'Limites de repetição e orçamentos fazem parte do contrato, e a saída não confiável de uma ferramenta não consegue forçar uma aprovação.',
  openReplayTitle: 'Qualquer um pode reproduzir.',
  openReplayText: 'Um auditor pode ramificar qualquer execução a partir de qualquer ponto, com efeitos colaterais suprimidos, e ver exatamente o que aconteceu e por quê.',

  // Default story: the evidence + one honest caveat (richText). The paper link
  // is a separate paragraph so white-label installs can drop it (ADR 0196).
  proofHeading: 'Um fluxo de trabalho. Duas linguagens. A mesma execução.',
  proofText: 'O artigo do OpenWOP relata que uma mesma definição de fluxo de trabalho, executada em um host TypeScript e em um host Python, chega ao mesmo estado final com a mesma estrutura de log de eventos. A execução é definida pelo protocolo, não por quem a hospeda.\n\nAinda é cedo, e você não precisa acreditar na nossa palavra. Execute algo aqui, abra o log de eventos e confira.',
  proofPaperLink: 'O método e os resultados completos estão [no artigo](https://doi.org/10.5281/zenodo.20576239).',

  // Default story: what you can do in this app today (columns, layout 'steps' —
  // a real sequence, so the numbering is earned)
  tryHeading: 'Experimente aqui, hoje.',
  tryBuildTitle: 'Criar',
  tryBuildText: 'Desenhe um agente ou fluxo de trabalho no canvas visual, ou descreva-o no chat.',
  tryRunTitle: 'Executar',
  tryRunText: 'Execute com os pacotes `core.openwop.*` publicados e veja cada evento chegar ao vivo.',
  tryDecideTitle: 'Decidir',
  tryDecideText: 'Quando a execução parar para perguntar, responda o cartão de aprovação. Ele espera por você.',
  tryReplayTitle: 'Reproduzir',
  tryReplayText: 'Abra qualquer execução concluída, ramifique a partir de um passo e veja o que mudaria.',

  // Default closing CTA section
  ctaHeading: 'Crie uma execução que você pode levar com você.',
  ctaSubheading: 'Sem cadastro. Traga suas próprias chaves de modelo quando quiser.',
  ctaLabel: 'Comece a criar',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Encontrar um recurso',
  catalogSearchPlaceholder: 'Buscar entre {{count}} recursos…',
  catalogSearchStatus: 'Mostrando {{count}} de {{total}}',
  catalogSearchClear: 'Limpar busca',
  catalogSearchEmpty: 'Nenhum recurso corresponde a “{{query}}”.',

  // ADR 0391 (a) — arquivo público do blog + visualização do post
  blogEyebrow: 'Artigos',
  blogTitle: 'Blog',
  blogSubscribe: 'Feed RSS',
  blogByline: 'Por {{author}}',
  blogFilterTag: 'Marcado como “{{value}}”',
  blogFilterCategory: 'Categoria: {{value}}',
  blogFilterAuthor: 'Por {{value}}',
  blogFilterAuthorUnknown: 'Deste autor',
  blogClearFilter: 'Limpar filtro',
  blogBackToBlog: '← Todos os posts',
  blogEmptyTitle: 'Ainda não há artigos publicados',
  blogEmptyBody: 'Comece pelo guia ou explore a plataforma enquanto esta publicação toma forma.',
  blogEmptyPrimaryCta: 'Ver guia rápido',
  blogEmptySecondaryCta: 'Explorar recursos',
  blogArchiveEmptyTitle: 'Nada por aqui ainda',
  blogArchiveEmptyBody: 'Nenhum post corresponde a este filtro.',
  blogLoadErrorTitle: 'Não foi possível carregar o blog',
  blogLoadErrorBody: 'Algo deu errado ao buscar os posts. Tente novamente.',
  postNotFoundTitle: 'Post não encontrado',
  postNotFoundBody: 'Este post pode ter sido despublicado ou movido.',

  // ROUND 2 (UX_UPGRADE-site R2-G1/G2/G3) — honestidade diante de falhas
  postLoadErrorTitle: 'Não foi possível carregar este post',
  postLoadErrorBody: 'Algo deu errado do nosso lado — o post provavelmente ainda existe.',
  pageNotFoundTitle: 'Página não encontrada',
  pageNotFoundBody: 'Esta página pode ter sido despublicada ou movida.',
  pageLoadErrorTitle: 'Não foi possível carregar esta página',
  pageLoadErrorBody: 'Algo deu errado do nosso lado. Tente novamente.',
  backToHome: 'Ir para a página inicial',
  blogChromeDegraded: 'Alguns detalhes do post (autor, data, posts relacionados) não puderam ser carregados agora.',
  pricingWrapperDegraded: 'Parte desta página não pôde ser carregada agora — os planos abaixo estão atualizados.',
  // UX_UPGRADE-site — filtro do blog (G1), tempo de leitura (G2), ver mais (G3),
  // relacionados/paginação (G4) e copiar link (G6)
  blogReadingTime: '{{count}} min de leitura',
  blogSearchLabel: 'Filtrar posts',
  blogSearchPlaceholder: 'Filtrar {{count}} posts…',
  blogSearchStatus: 'Mostrando {{count}} de {{total}}',
  blogSearchClear: 'Limpar filtro',
  blogSearchEmptyTitle: 'Nenhum post corresponde a “{{query}}”',
  blogSearchEmptyBody: 'Tente outra palavra ou limpe o filtro para ver tudo.',
  blogSearchShowAll: 'Ver todos os posts',
  blogShowMore: 'Ver mais {{count}}',
  blogShownCount: 'Mostrando {{count}} de {{total}} posts',
  blogPagerLabel: 'Posts próximos',
  blogOlderPost: 'Post anterior',
  blogNewerPost: 'Post seguinte',
  blogRelatedTitle: 'Leituras relacionadas',
  blogMoreTitle: 'Mais posts',
  blogCopyLink: 'Copiar link',
  blogTocTitle: 'Nesta página',
  blogShareLabel: 'Compartilhar este post',
  blogShareX: 'Compartilhar no X',
  blogShareLinkedIn: 'Compartilhar no LinkedIn',
  blogShareEmail: 'E-mail',
  blogSearchShortcutHint: 'Ctrl K',
  blogSearchShortcutHintMac: '⌘K',
  blogCopied: 'Copiado',

  // ADR 0391 (b) — página pública de preços (alternativa quando não há página CMS)
  pricingTitle: 'Preços',
  pricingEyebrow: 'Planos',
  pricingHeading: 'Planos desta implantação',
  pricingBlurb: 'Os detalhes dos planos são configurados pelo operador desta implantação. Explore o que cada plano inclui e abra o espaço de trabalho quando estiver pronto para começar.',

  editThisPage: 'Editar esta p\u00e1gina',

  openApp: 'Abrir o aplicativo',
} as const;
