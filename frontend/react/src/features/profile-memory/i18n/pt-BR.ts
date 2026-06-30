/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Anexe <0>documentos</0> ao seu perfil — fontes citadas que seu gêmeo digital pode usar, junto com os fatos da sua aba de Memória. Privado para você.',
  knowledgeEmptyBody: 'Crie uma fonte acima e depois adicione documentos que seu gêmeo possa citar.',
  knowledgeSearchTitle: 'Buscar no seu conhecimento',
  knowledgeSearchPlaceholder: 'O que seu gêmeo lembraria?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Treine seu perfil com memórias pessoais — fatos, preferências e contexto sobre como você trabalha. Com o tempo isso se torna um <0>gêmeo digital</0> de você. Durável e privado para você.',
  memoryAddPlaceholder: 'Prefiro atualizações assíncronas a reuniões; meu horário de foco é das 9h às 11h.',
  memoryEmptyBody: 'Comece a treinar seu gêmeo: adicione um fato ou uma preferência sobre como você trabalha.',

  // Consentimento de extração automática (ADR 0120)
  consentLabel: 'Aprender automaticamente fatos duradouros das minhas conversas',
  consentHint: 'Quando ativado, seu assistente pode salvar como memórias os fatos duradouros que aprende durante as conversas — que você pode revisar e excluir a qualquer momento. Desativado por padrão.',
  consentError: 'Não foi possível atualizar a configuração de aprendizado de memória.',
} as const;
