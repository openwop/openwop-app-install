/**
 * `settings` namespace — user-facing strings for the Settings area
 * (`src/settings/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AdminOverviewPage
  adminEyebrow: 'Admin',
  adminTitle: 'Visão geral',
  adminLede: 'Configuração da plataforma e superfícies do console. O trabalho do dia a dia fica na barra do workspace; tudo que configura a implantação fica aqui.',

  // ExampleDataPage — header
  exampleDataEyebrow: 'Configurações',
  exampleDataTitle: 'Dados de exemplo',
  exampleDataLede: 'Carregue dados de amostra para que os painéis tenham algo a exibir — agentes, equipes e seu histórico. Tudo aqui é explícito e claramente de exemplo; uma instalação limpa começa vazia.',

  // ExampleDataPage — types list
  typesHeading: 'Tipos de dados de exemplo',
  typesIntro: 'Idempotente e não destrutivo: cada tipo é criado apenas onde está ausente, então o carregamento nunca duplica nem mexe em dados que você criou. Limitado ao seu tenant.',
  noTypesTitle: 'Nenhum tipo de dado de exemplo registrado',
  noTypesBody: 'Este host não anuncia nenhum dado de exemplo carregável.',
  selectAria: 'Selecionar {{label}}',
  countPresent: '{{n}} presente(s)',

  // ExampleDataPage — actions
  dryRunLabel: 'Simulação (prévia)',
  loadAllExampleData: 'Carregar todos os dados de exemplo',
  loadSelected: 'Carregar selecionados ({{n}})',
  clearExampleData: 'Limpar dados de exemplo',
  clearTitle: 'Remover entidades de exemplo (seus próprios agentes não são afetados)',
  clearing: 'Limpando…',
  clearConfirm: 'Limpar {{label}}? Isso remove as entidades de exemplo do seu tenant (seus próprios agentes não são afetados).',
  clearAllFallback: 'todos os dados de exemplo',

  // ExampleDataPage — results
  dryRunNotice: 'Simulação — nada foi gravado.',
  summaryCreated_one: '{{n}} criado',
  summaryCreated_other: '{{n}} criados',
  summaryCleared_one: '{{n}} limpo',
  summaryCleared_other: '{{n}} limpos',
  summarySkipped_one: '{{n}} ignorado',
  summarySkipped_other: '{{n}} ignorados',
  summaryErrors_one: '{{n}} erro',
  summaryErrors_other: '{{n}} erros',

  // ExampleDataPage — per-step action labels
  actionCreated: 'criado',
  actionCleared: 'limpo',
  actionError: 'erro',
  actionSkipped: 'ignorado',
} as const;
