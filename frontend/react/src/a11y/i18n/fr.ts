/** `a11y` namespace — français (ADR 0363 P2). */
export const messages = {
  missingAlt: 'Une image n’a pas de texte alternatif.',
  headingSkip: 'Le niveau de titre passe de H{{from}} à H{{to}}.',
  linkEmpty: 'Un lien n’a pas de texte.',
  linkGeneric: 'Le texte du lien « {{text}} » n’est pas descriptif à lui seul.',
  lowContrast: 'Les couleurs du texte et de l’arrière-plan ne respectent pas le ratio de contraste WCAG AA.',

  panelTitle: 'Accessibilité',
  panelCheck: 'Vérifier l’accessibilité',
  panelNone: 'Aucun problème d’accessibilité détecté.',
  panelSummary_one: '{{count}} problème détecté',
  panelSummary_other: '{{count}} problèmes détectés',
  severityError: 'Erreur',
  severityWarning: 'Avertissement',

  // P4 — préférences d’accessibilité
  prefsButton: 'Préférences d’accessibilité',
  prefsTitle: 'Accessibilité',
  fontScaleLabel: 'Taille du texte',
  fontScale110: 'Grand',
  fontScale125: 'Plus grand',
  fontScale140: 'Maximal',
  focusStyleLabel: 'Indicateur de focus',
  focusBold: 'Anneau épais',
  prefsHint: 'Elles remplacent les réglages de votre appareil pour cette application dans ce navigateur.',
  prefSystem: 'Système',
  motionLabel: 'Animations',
  motionReduce: 'Réduire',
  contrastLabel: 'Contraste',
  contrastMore: 'Plus',
} as const;
