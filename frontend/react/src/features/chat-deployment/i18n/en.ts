/**
 * `chat-deployment` namespace — copy for the Chat deployment console (ADR 0145).
 * Auto-discovered from this path as the `chat-deployment` i18n namespace.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Chat deployment',
  lede: 'Put your AI chat to work without someone in the seat — run it on a schedule, or embed it on your website.',

  // Tablist
  tablistLabel: 'Chat deployment sections',

  // Tab labels (keyed by the route id = path last segment)
  'tab_scheduled-chats': 'Scheduled runs',
  tab_widgets: 'Website widget',

  // Empty state
  emptyTitle: 'Nothing deployed yet',
  emptyBody: 'Scheduled runs and website widgets appear here as they’re enabled for your workspace.',
} as const;
