/** `a11y` namespace — português do Brasil (ADR 0363 P2). */
export const messages = {
  missingAlt: 'Uma imagem está sem texto alternativo.',
  headingSkip: 'O nível de título pula de H{{from}} para H{{to}}.',
  linkEmpty: 'Um link não tem texto.',
  linkGeneric: 'O texto do link “{{text}}” não é descritivo por si só.',
  lowContrast: 'As cores de texto e fundo não atendem à razão de contraste WCAG AA.',

  panelTitle: 'Acessibilidade',
  panelCheck: 'Verificar acessibilidade',
  panelNone: 'Nenhum problema de acessibilidade encontrado.',
  panelSummary_one: '{{count}} problema encontrado',
  panelSummary_other: '{{count}} problemas encontrados',
  severityError: 'Erro',
  severityWarning: 'Aviso',

  // P4 — preferências de acessibilidade
  prefsButton: 'Preferências de acessibilidade',
  prefsTitle: 'Acessibilidade',
  fontScaleLabel: 'Tamanho do texto',
  fontScale110: 'Grande',
  fontScale125: 'Maior',
  fontScale140: 'Máximo',
  focusStyleLabel: 'Indicador de foco',
  focusBold: 'Anel espesso',
  prefsHint: 'Elas substituem as configurações do seu dispositivo para este app neste navegador.',
  prefSystem: 'Sistema',
  motionLabel: 'Movimento',
  motionReduce: 'Reduzir',
  contrastLabel: 'Contraste',
  contrastMore: 'Mais',
} as const;
