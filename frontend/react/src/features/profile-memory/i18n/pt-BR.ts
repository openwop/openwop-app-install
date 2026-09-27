/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Anexe <0>documentos</0> ao seu perfil — fontes que seu gêmeo digital pode usar, junto com os fatos da sua aba de Memória.',
  knowledgeAudience:
    'Os documentos ficam no seu espaço de trabalho, não em um armazenamento privado: qualquer pessoa que possa ler esse espaço pode abri-los. As notas da sua Memória são diferentes — essas continuam sendo suas.',
  knowledgeEmptyBody: 'Crie uma fonte acima e depois adicione documentos que seu gêmeo possa citar.',
  knowledgeSearchTitle: 'Buscar no seu conhecimento',
  knowledgeSearchPlaceholder: 'O que seu gêmeo lembraria?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Treine seu perfil com memórias pessoais — fatos, preferências e contexto sobre como você trabalha. Com o tempo isso se torna um <0>gêmeo digital</0> de você. Durável e só seu, a menos que você conceda a um agente permissão para recordá-las.',
  memoryAddPlaceholder: 'Prefiro atualizações assíncronas a reuniões; meu horário de foco é das 9h às 11h.',
  memoryEmptyBody: 'Comece a treinar seu gêmeo: adicione um fato ou uma preferência sobre como você trabalha.',

  // Consentimento de extração automática (ADR 0120)
  consentLabel: 'Aprender automaticamente fatos duradouros das minhas conversas',
  consentHint: 'Quando ativado, seu assistente pode salvar fatos duradouros que aprende durante as conversas. Os fatos aprendidos aparecem abaixo, marcados como “Aprendida automaticamente”, e você pode excluí-los. Desativar isto interrompe o aprendizado futuro, mas não exclui o que já foi aprendido. Desativado por padrão.',
  erasureScopeNote: 'Excluir os dados da sua conta remove a sua memória pessoal. Isso não alcança o que um agente compartilhado do workspace lembra das suas conversas com ele — essa memória pertence ao workspace. Peça a um administrador para limpar a memória do agente na aba Memória dele.',
  consentError: 'Não foi possível atualizar a configuração de aprendizado de memória.',
  consentLoadFailed: 'Não foi possível ler se o aprendizado de memória está ativado. Ele pode estar ATIVADO — isto não confirma que está desativado.',
  consentRetry: 'Tentar de novo',
} as const;
