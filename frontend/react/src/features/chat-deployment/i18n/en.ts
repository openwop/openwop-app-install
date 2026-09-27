/**
 * `chat-deployment` namespace — copy for the Always-on chat console (ADR 0145).
 * Named from the person's side of the screen: nobody "deploys chat" — they
 * schedule the assistant, or put it on their website. The hub inherits the two
 * panes' own concrete vocabulary (daily digest / Monday report / visitors).
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Always-on chat',
  lede: 'Two ways chat runs without you: on a schedule — a daily digest, a Monday report, posted back to a conversation — or on your website, answering visitors who never sign in.',

  // Tablist — the two doors
  tablistLabel: 'Where chat runs',
  'tab_scheduled-chats': 'On a schedule',
  tab_widgets: 'On your website',

  // Empty state — direction, not mood
  emptyTitle: 'Nothing running on its own yet',
  emptyBody: 'Schedules and website widgets are switched off for this workspace. A workspace admin can turn them on in Feature toggles.',
} as const;
