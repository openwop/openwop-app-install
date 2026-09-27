/**
 * `a11y` namespace — shared accessibility-checker copy (ADR 0363 P2). Owned here
 * (not per-feature) so the issue vocabulary can't drift across document-editor,
 * CMS, and app-builder. `document-editor` migrated its 5 a11y keys into this ns.
 */
export const messages = {
  // Issue messages — keyed by A11yIssueKind (contentA11y.ts).
  missingAlt: 'An image is missing alternative text.',
  headingSkip: 'Heading level skips from H{{from}} to H{{to}}.',
  linkEmpty: 'A link has no text.',
  linkGeneric: 'Link text “{{text}}” is not descriptive on its own.',
  lowContrast: 'Text and background colors do not meet the WCAG AA contrast ratio.',

  // Panel chrome.
  panelTitle: 'Accessibility',
  panelCheck: 'Check accessibility',
  panelNone: 'No accessibility issues found.',
  panelSummary_one: '{{count}} issue found',
  panelSummary_other: '{{count}} issues found',
  severityError: 'Error',
  severityWarning: 'Warning',

  // P4 — accessibility preferences
  prefsButton: 'Accessibility preferences',
  prefsTitle: 'Accessibility',
  fontScaleLabel: 'Text size',
  fontScale110: 'Large',
  fontScale125: 'Larger',
  fontScale140: 'Largest',
  focusStyleLabel: 'Focus indicator',
  focusBold: 'Bold ring',
  prefsHint: 'These override your device settings for this app on this browser.',
  prefSystem: 'System',
  motionLabel: 'Motion',
  motionReduce: 'Reduce',
  contrastLabel: 'Contrast',
  contrastMore: 'More',
} as const;
