/** `a11y` namespace — español (ADR 0363 P2). */
export const messages = {
  missingAlt: 'Una imagen no tiene texto alternativo.',
  headingSkip: 'El nivel de encabezado salta de H{{from}} a H{{to}}.',
  linkEmpty: 'Un enlace no tiene texto.',
  linkGeneric: 'El texto del enlace «{{text}}» no es descriptivo por sí solo.',
  lowContrast: 'Los colores de texto y fondo no cumplen la relación de contraste WCAG AA.',

  panelTitle: 'Accesibilidad',
  panelCheck: 'Comprobar accesibilidad',
  panelNone: 'No se encontraron problemas de accesibilidad.',
  panelSummary_one: '{{count}} problema encontrado',
  panelSummary_other: '{{count}} problemas encontrados',
  severityError: 'Error',
  severityWarning: 'Advertencia',

  // P4 — preferencias de accesibilidad
  prefsButton: 'Preferencias de accesibilidad',
  prefsTitle: 'Accesibilidad',
  fontScaleLabel: 'Tamaño del texto',
  fontScale110: 'Grande',
  fontScale125: 'Más grande',
  fontScale140: 'Máximo',
  focusStyleLabel: 'Indicador de foco',
  focusBold: 'Anillo grueso',
  prefsHint: 'Estas anulan la configuración de tu dispositivo para esta app en este navegador.',
  prefSystem: 'Sistema',
  motionLabel: 'Movimiento',
  motionReduce: 'Reducir',
  contrastLabel: 'Contraste',
  contrastMore: 'Más',
} as const;
