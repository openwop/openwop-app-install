/**
 * `assistantAction` namespace — the fields an approver must see on an assistant
 * action card (ADR 0862 D3). LAZY area catalog (ADR 0819 pattern): its only
 * renderer is `assistantAction/AssistantActionFields.tsx`, which every consumer
 * imports lazily and which suspends on its own boundary. FLAT camelCase keys.
 */
export const messages = {
  fieldsLabel: 'What will be sent',
  to: 'To',
  subject: 'Subject',
  title: 'Title',
  starts: 'Starts',
  ends: 'Ends',
  guests: 'Guests',
  location: 'Location',
  details: 'Details',
  event: 'Event',
  ticket: 'Ticket',
  newStart: 'New start',
  newEnd: 'New end',
  allDay: '{{date}} (all day)',
  reviewInInbox: 'Review',
  reviewInInboxHint: 'Open it in your inbox to see everything it will send before approving.',
  actionChanged: 'This action changed after you opened it. Review the current version, then approve.',
  cardOutOfDate: 'This card is out of date. Reload the page and review the action again.',
  loopLastRunFailed: 'Last run failed {{when}}: {{reason}}',
  loopFailReauth: 'Google needs you to sign in again.',
  loopFailScope: 'Google is connected without access to this data.',
  loopFailApiDisabled: 'this Google API is turned off for the workspace — an administrator must enable it.',
  loopFailForbidden: 'Google refused the connected account.',
  loopFailUnavailable: 'Google could not be reached. It will try again next run.',
  loopFailOther: 'see the run for details.',
  loopReconnect: 'Reconnect Google',
  loopViewRun: 'View run',
  actionUnavailable: 'This action is no longer available to approve. You can still reject it.',
  healthLoopFailed: 'A recurring task is failing',
  healthLoopFailedNote: 'Open Recurring tasks below to see why and how to fix it.',
  actionWithheld: 'Only members who can send this action can read or decide it.',
  loopAutoPaused: 'Paused automatically {{when}}: {{reason}} Reconnect Google, then turn it back on.',
  // ADR 0878 (SD2UX-2) — where an approved support reply goes.
  replyVia: "Reply goes to",
  replyViaWhatsapp: "The customer on WhatsApp",
  replyViaWidget: "The visitor, in the website chat",
  replyViaNone: "Nobody — this ticket has no reply channel, so the reply is saved but not sent",
} as const;
