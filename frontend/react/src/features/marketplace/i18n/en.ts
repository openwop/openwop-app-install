/**
 * `marketplace` namespace — user-facing copy for the marketplace feature (ADR 0022).
 * Feature-self-contained: every marketplace string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Business',
  title: 'Marketplace',
  lede: 'Browse and install signed feature packs from the registry.',

  // Gating / empty states
  notEnabledTitle: 'Marketplace is not enabled',
  notEnabledBody: 'Ask an administrator to turn on the Marketplace feature in Admin → Feature toggles.',
  noPacksFoundTitle: 'No packs found',
  noPacksFoundBodySearch: 'No packs match your search. Try a broader term.',
  noPacksFoundBodyEmpty: 'No packs are available in the catalog yet.',

  // Search / filter bar
  searchPlaceholder: 'Search packs by name, capability, or category',
  searchPacksLabel: 'Search packs',
  filterGroup: 'Filter packs',

  // Pack list / cards / rows
  packsLabel: 'Packs',
  installed: 'Installed',
  notInstalled: 'Not installed',
  subNoDescription: 'No description provided.',
  requiredBy: 'Required by: {{packs}}',
  reviewsAction: 'Reviews',
  install: 'Install',

  // Stars / rating
  starsReadLabel: '{{count}} out of 5 stars',
  ratingLabel: 'Rating',
  starLabel_one: '{{count}} star',
  starLabel_other: '{{count}} stars',

  // Author
  authorAgent: 'Agent',

  // Reviews panel
  reviewsForLabel: 'Reviews for {{pack}}',
  reviewsForTitle: 'Reviews — {{pack}}',
  reviewsSummary: '{{average}} ({{total}})',
  noReviewsInline: 'No reviews yet',
  orgPickerLabel: 'Organization',
  closeReviewsLabel: 'Close reviews',
  yourRating: 'Your rating',
  commentOptional: 'Comment (optional)',
  commentPlaceholder: 'What did you think of this pack?',
  submitReview: 'Submit review',
  noReviewsTitle: 'No reviews yet',
  noReviewsBody: 'Be the first to rate this pack with the form above.',
  deleteReviewLabel: 'Delete review',

  // Toasts — success
  alreadyInstalled: '{{pack}} is already installed.',
  installedToast: 'Installed {{pack}}.',
  reviewSaved: 'Review saved.',

  // Toasts / errors
  loadFailed: 'Failed to load the marketplace.',
  installFailed: 'Install failed.',
  pickRating: 'Pick a rating from 1 to 5.',
  reviewFailed: 'Review failed.',
  deleteFailed: 'Delete failed.',
  loadReviewsFailed: 'Failed to load reviews.',
} as const;
