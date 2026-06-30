/** `scheduled-chats` namespace (ADR 0125). */
export const messages = {
  eyebrow: 'Platform',
  title: 'Scheduled chats',
  lede: 'Have an agent run a chat on a schedule — a daily digest, a Monday report — and post the result to a conversation.',
  org: 'Workspace',
  colAgent: 'Agent',
  colSchedule: 'Schedule',
  colStatus: 'Status',
  delete: 'Delete',
  active: 'Active',
  inert: 'Inert',
  empty: 'No scheduled chats yet.',
  emptyHint: 'Create a scheduled chat to run an agent on a cron schedule.',
  loadError: 'Could not load scheduled chats.',
  disabled: 'Scheduled chats are off for this workspace.',
  colNextRun: 'Next run',
} as const;
