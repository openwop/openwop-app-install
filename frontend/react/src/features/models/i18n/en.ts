/**
 * `models` namespace — copy for the Models console (ADR 0145).
 * Auto-discovered from this path as the `models` i18n namespace.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Models',
  lede: 'Choose which model answers each chat turn, and see which models your team rates highest.',

  // Tablist
  tablistLabel: 'Model sections',

  // Tab labels (keyed by the route id = path last segment)
  'tab_model-router': 'Routing',
  tab_leaderboard: 'Leaderboard',

  // Empty state
  emptyTitle: 'Nothing to manage here yet',
  emptyBody: 'Model routing and quality tools appear here as they’re enabled for your workspace.',
} as const;
