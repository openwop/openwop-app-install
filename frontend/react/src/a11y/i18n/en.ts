/**
 * `a11y` namespace — shared accessibility-checker copy (ADR 0363 P2). Owned here
 * (not per-feature) so the issue vocabulary can't drift across document-editor,
 * CMS, and app-builder. `document-editor` migrated its 5 a11y keys into this ns.
 */
export const messages = {
  // Issue messages — keyed by A11yIssueKind (contentA11y.ts).
  missingAlt: 'An image is missing alternative text.',
  altFilename: 'The image’s alt text “{{alt}}” is a file name, not a description.',
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
  // ADR 1100 D3 — where an issue is, on a CMS page.
  issueLocationSection: 'Section {{n}}: {{type}}',
  altFilledFromLibrary: 'Alt text filled in from the media library. Check that it fits this page.',
  altClearedOnSwap: 'Alt text from the previous image was removed. Describe the new image.',
  issueLocationSectionItem: 'Section {{n}}: {{type}}, image {{item}}',
  issueLocationShared: '{{where}} (shared section)',
  issueLocationLabel: 'Location:',
  panelIncompleteShared: 'A shared section has not been read yet, or could not be read, so its images were not checked.',
  goToSection: 'Go to {{where}}',
  // ADR 1100 D4 — the CMS link into the ONE chat, scoped to the Reviewer.
  askReviewer: 'Ask the Accessibility Reviewer',
  askReviewerSeed: 'Review the page “{{title}}” for accessibility problems, and tell me what to fix and where. (For the reviewer: page id {{pageId}}.)',

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
